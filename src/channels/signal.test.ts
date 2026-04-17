import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./registry.js', () => ({ registerChannel: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));

vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Fake child_process.spawn → EventEmitter with a writable stdin and
// emitter-based stdout / stderr. Tests drive the process via `fakeProc`.
class FakeStdin extends EventEmitter {
  writes: string[] = [];
  write(data: string): boolean {
    this.writes.push(data);
    return true;
  }
}

class FakeProc extends EventEmitter {
  stdin = new FakeStdin();
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(signal?: string): boolean {
    this.killed = true;
    this.emit('close', 0, signal);
    return true;
  }
}

const spawnMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: any[]) => spawnMock(...args),
}));

// Import after mocks so registerChannel etc. are mocked at module load.
import { chunkText, SignalChannel } from './signal.js';

// Helpers ------------------------------------------------------------------

function makeChannel(phone = '+15550001234') {
  const onMessage = vi.fn();
  const onChatMetadata = vi.fn();
  const groups: Record<string, any> = {};
  const channel = new SignalChannel(phone, 'signal-cli', {
    onMessage,
    onChatMetadata,
    registeredGroups: () => groups,
  });
  return { channel, onMessage, onChatMetadata, groups };
}

async function connectWithFakeProc(channel: SignalChannel): Promise<FakeProc> {
  const proc = new FakeProc();
  spawnMock.mockReturnValueOnce(proc);
  vi.useFakeTimers();
  const connectPromise = channel.connect();
  vi.advanceTimersByTime(1100);
  vi.useRealTimers();
  await connectPromise;
  return proc;
}

function emitStdout(proc: FakeProc, payload: string): void {
  proc.stdout.emit('data', Buffer.from(payload));
}

// --- chunkText ------------------------------------------------------------

describe('chunkText', () => {
  it('returns one chunk when text is within the limit', () => {
    expect(chunkText('hello', 10)).toEqual(['hello']);
  });

  it('splits text into fixed-size chunks', () => {
    expect(chunkText('abcdefghij', 4)).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('handles empty input', () => {
    expect(chunkText('', 10)).toEqual(['']);
  });
});

// --- ownsJid --------------------------------------------------------------

describe('ownsJid', () => {
  it('accepts signal: prefixed jids', () => {
    const { channel } = makeChannel();
    expect(channel.ownsJid('signal:+123')).toBe(true);
    expect(channel.ownsJid('signal:abcd-efgh')).toBe(true);
  });

  it('rejects other channels', () => {
    const { channel } = makeChannel();
    expect(channel.ownsJid('tg:123')).toBe(false);
    expect(channel.ownsJid('123')).toBe(false);
  });
});

// --- connection lifecycle -------------------------------------------------

describe('connection lifecycle', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('spawns signal-cli jsonRpc and resolves after ready delay', async () => {
    const { channel } = makeChannel('+15550001234');
    await connectWithFakeProc(channel);
    expect(spawnMock).toHaveBeenCalledWith('signal-cli', [
      '-a',
      '+15550001234',
      'jsonRpc',
    ]);
    expect(channel.isConnected()).toBe(true);
  });

  it('disconnect kills the process and clears connection state', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);
    await channel.disconnect();
    expect(proc.killed).toBe(true);
    expect(channel.isConnected()).toBe(false);
  });

  it('rejects pending RPCs when the process exits', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);

    const pending = channel.sendMessage('signal:+123', 'hi');
    // Pretend the process exited before the send response arrived.
    proc.emit('close', 42);
    await pending; // sendMessage swallows failures, but must not hang.
    expect(channel.isConnected()).toBe(false);
  });

  it('rejects connect() if signal-cli exits during the startup window', async () => {
    const { channel } = makeChannel();
    const proc = new FakeProc();
    spawnMock.mockReturnValueOnce(proc);
    vi.useFakeTimers();
    const connectPromise = channel.connect();
    // signal-cli dies (e.g. bad auth) before the ready timer fires.
    proc.emit('close', 1);
    vi.advanceTimersByTime(1100);
    vi.useRealTimers();
    await expect(connectPromise).rejects.toThrow(/exited during startup/);
    expect(channel.isConnected()).toBe(false);
  });
});

// --- line buffering -------------------------------------------------------

describe('line buffering', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('assembles messages split across chunks and ignores empty lines', async () => {
    const { channel, onMessage, groups } = makeChannel();
    groups['signal:+19998887777'] = { name: 'Jouni', folder: 'solo' };

    const proc = await connectWithFakeProc(channel);

    const notification = JSON.stringify({
      method: 'receive',
      params: {
        envelope: {
          sourceNumber: '+19998887777',
          sourceName: 'Jouni',
          timestamp: 1700000000000,
          dataMessage: { message: 'hello' },
        },
      },
    });

    // Send in two parts, with a stray empty newline and trailing partial line.
    emitStdout(proc, notification.slice(0, 30));
    emitStdout(proc, notification.slice(30) + '\n\n');
    // Let the async notification handler run.
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const call = onMessage.mock.calls[0];
    expect(call[0]).toBe('signal:+19998887777');
    expect(call[1]).toMatchObject({
      chat_jid: 'signal:+19998887777',
      sender: '+19998887777',
      sender_name: 'Jouni',
      content: 'hello',
      is_from_me: false,
    });
  });

  it('silently drops malformed JSON lines', async () => {
    const { channel, onMessage } = makeChannel();
    const proc = await connectWithFakeProc(channel);
    emitStdout(proc, '{ not json\n');
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// --- incoming messages ----------------------------------------------------

describe('incoming messages', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('stores chat metadata for every inbound, but only delivers for registered groups', async () => {
    const { channel, onMessage, onChatMetadata } = makeChannel();
    const proc = await connectWithFakeProc(channel);

    emitStdout(
      proc,
      JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+19998887777',
            sourceName: 'Stranger',
            timestamp: 1700000000000,
            dataMessage: { message: 'hi' },
          },
        },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(onChatMetadata).toHaveBeenCalledWith(
      'signal:+19998887777',
      expect.any(String),
      'Stranger',
      'signal',
      false,
    );
    expect(onMessage).not.toHaveBeenCalled();
  });

  it('routes group messages to the group jid', async () => {
    const { channel, onMessage, groups } = makeChannel();
    groups['signal:family-group-id'] = { name: 'Family', folder: 'family' };

    const proc = await connectWithFakeProc(channel);
    emitStdout(
      proc,
      JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+19998887777',
            sourceName: 'Mom',
            timestamp: 1700000000001,
            dataMessage: {
              message: '@Andy what time is it?',
              groupInfo: {
                groupId: 'family-group-id',
                groupName: 'Family',
              },
            },
          },
        },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage).toHaveBeenCalledTimes(1);
    const [jid, msg] = onMessage.mock.calls[0];
    expect(jid).toBe('signal:family-group-id');
    expect(msg.content).toBe('@Andy what time is it?');
  });

  it('rewrites @Andy into trigger form in group chats when not already present', async () => {
    const { channel, onMessage, groups } = makeChannel();
    groups['signal:family-group-id'] = { name: 'Family', folder: 'family' };

    const proc = await connectWithFakeProc(channel);
    emitStdout(
      proc,
      JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+19998887777',
            sourceName: 'Mom',
            timestamp: 1700000000001,
            dataMessage: {
              message: 'Hey @Andy remind us please',
              groupInfo: { groupId: 'family-group-id', groupName: 'Family' },
            },
          },
        },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));

    const [, msg] = onMessage.mock.calls[0];
    expect(msg.content.startsWith('@Andy ')).toBe(true);
  });

  it('marks messages from the configured phone number as is_from_me', async () => {
    const { channel, onMessage, groups } = makeChannel('+15550001234');
    groups['signal:+15550001234'] = { name: 'Me', folder: 'solo' };

    const proc = await connectWithFakeProc(channel);
    emitStdout(
      proc,
      JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15550001234',
            sourceName: 'Jouni',
            timestamp: 1700000000002,
            dataMessage: { message: 'test' },
          },
        },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));

    expect(onMessage.mock.calls[0][1].is_from_me).toBe(true);
  });

  it('ignores envelopes without a dataMessage (e.g. typing/receipts)', async () => {
    const { channel, onMessage } = makeChannel();
    const proc = await connectWithFakeProc(channel);
    emitStdout(
      proc,
      JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+19998887777',
            timestamp: 1700000000003,
          },
        },
      }) + '\n',
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(onMessage).not.toHaveBeenCalled();
  });
});

// --- sendMessage ----------------------------------------------------------

describe('sendMessage', () => {
  afterEach(() => {
    spawnMock.mockReset();
    vi.useRealTimers();
  });

  it('chunks long messages into multiple RPC calls', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);
    const long = 'A'.repeat(5000);

    const p = channel.sendMessage('signal:+123', long);

    // sendMessage awaits each sendRpc before writing the next chunk, so ack
    // them as they come in. Three chunks of 2000/2000/1000 chars.
    for (let i = 0; i < 3; i++) {
      // Wait for the next write.
      for (let tick = 0; tick < 10 && proc.stdin.writes.length <= i; tick++) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const req = JSON.parse(proc.stdin.writes[i].trim());
      emitStdout(
        proc,
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n',
      );
    }
    await p;

    expect(proc.stdin.writes.length).toBe(3);
  });

  it('attaches textStyle ranges when markdown formatting is present', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);

    const p = channel.sendMessage('signal:+123', 'hello **world**');
    await new Promise((resolve) => setImmediate(resolve));

    const req = JSON.parse(proc.stdin.writes[0].trim());
    expect(req.params.message).toBe('hello world');
    expect(req.params.textStyle).toEqual(['6:5:BOLD']);

    emitStdout(
      proc,
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n',
    );
    await p;
  });

  it('uses groupId params for group jids and recipient params for direct jids', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);

    const p1 = channel.sendMessage('signal:+199', 'one');
    const p2 = channel.sendMessage('signal:family-group-id', 'two');
    await new Promise((resolve) => setImmediate(resolve));

    const req1 = JSON.parse(proc.stdin.writes[0].trim());
    const req2 = JSON.parse(proc.stdin.writes[1].trim());
    expect(req1.params.recipient).toEqual(['+199']);
    expect(req2.params.groupId).toBe('family-group-id');

    for (const req of [req1, req2]) {
      emitStdout(
        proc,
        JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n',
      );
    }
    await Promise.all([p1, p2]);
  });

  it('is a no-op when signal-cli is not connected', async () => {
    const { channel } = makeChannel();
    // Never connected; sendMessage must not throw.
    await expect(
      channel.sendMessage('signal:+1', 'x'),
    ).resolves.toBeUndefined();
  });
});

// --- setTyping ------------------------------------------------------------

describe('setTyping', () => {
  beforeEach(() => spawnMock.mockReset());

  it('sends a sendTyping RPC when enabled', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);

    const p = channel.setTyping('signal:+123', true);
    await new Promise((resolve) => setImmediate(resolve));
    const req = JSON.parse(proc.stdin.writes[0].trim());
    expect(req.method).toBe('sendTyping');
    expect(req.params.recipient).toEqual(['+123']);
    emitStdout(
      proc,
      JSON.stringify({ jsonrpc: '2.0', id: req.id, result: {} }) + '\n',
    );
    await p;
  });

  it('does nothing when isTyping is false', async () => {
    const { channel } = makeChannel();
    const proc = await connectWithFakeProc(channel);
    await channel.setTyping('signal:+123', false);
    expect(proc.stdin.writes.length).toBe(0);
  });
});
