import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { EventEmitter } from 'events';

// --- Mocks ---

vi.mock('./registry.js', async () => {
  const actual = await vi.importActual('./registry.js');
  return { ...actual, registerChannel: vi.fn() };
});
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../config.js', () => ({
  ASSISTANT_NAME: 'Andy',
  TRIGGER_PATTERN: /^@Andy\b/i,
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockTranscribeAudio = vi.fn();
vi.mock('../transcription.js', () => ({
  transcribeAudio: (...args: any[]) => mockTranscribeAudio(...args),
}));

// child_process mock
interface FakeProcess extends EventEmitter {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
}

function createFakeProcess(): FakeProcess {
  const proc = new EventEmitter() as FakeProcess;
  proc.stdin = new PassThrough();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();
  proc.killed = false;
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

let fakeProc: FakeProcess;
vi.mock('child_process', () => ({
  spawn: vi.fn(() => {
    fakeProc = createFakeProcess();
    return fakeProc;
  }),
}));

import { SignalChannel, parseFormatting } from './signal.js';
import type { ChannelOpts } from './registry.js';

// --- Helpers ---

function createTestOpts(overrides?: Partial<ChannelOpts>): ChannelOpts {
  return {
    onMessage: vi.fn(),
    onChatMetadata: vi.fn(),
    registeredGroups: vi.fn(() => ({
      'signal:+15551234567': {
        name: 'Test Group',
        folder: 'test-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
      'signal:test-group-id': {
        name: 'Signal Group',
        folder: 'signal-group',
        trigger: '@Andy',
        added_at: '2024-01-01T00:00:00.000Z',
      },
    })),
    ...overrides,
  };
}

function emitJsonLine(proc: FakeProcess, obj: any): void {
  proc.stdout.push(JSON.stringify(obj) + '\n');
}

// --- Tests ---

describe('parseFormatting', () => {
  it('returns plain text unchanged', () => {
    const result = parseFormatting('Hello world');
    expect(result.text).toBe('Hello world');
    expect(result.styles).toEqual([]);
  });

  it('parses bold (**text**)', () => {
    const result = parseFormatting('Hello **bold** world');
    expect(result.text).toBe('Hello bold world');
    expect(result.styles).toEqual(['6:4:BOLD']);
  });

  it('parses italic (*text*)', () => {
    const result = parseFormatting('Hello *italic* world');
    expect(result.text).toBe('Hello italic world');
    expect(result.styles).toEqual(['6:6:ITALIC']);
  });

  it('parses strikethrough (~~text~~)', () => {
    const result = parseFormatting('Hello ~~strike~~ world');
    expect(result.text).toBe('Hello strike world');
    expect(result.styles).toEqual(['6:6:STRIKETHROUGH']);
  });

  it('parses monospace (`text`)', () => {
    const result = parseFormatting('Hello `code` world');
    expect(result.text).toBe('Hello code world');
    expect(result.styles).toEqual(['6:4:MONOSPACE']);
  });

  it('parses mixed formats', () => {
    const result = parseFormatting('**bold** and *italic*');
    expect(result.text).toBe('bold and italic');
    expect(result.styles).toContain('0:4:BOLD');
    expect(result.styles).toContain('9:6:ITALIC');
  });

  it('handles overlapping markers by keeping first', () => {
    // ` contains ** inside — backtick wins because it starts first
    const result = parseFormatting('`code **with** bold`');
    expect(result.text).toBe('code **with** bold');
    expect(result.styles).toEqual(['0:18:MONOSPACE']);
  });

  it('handles UTF-16 positions with emoji', () => {
    // Emoji takes 2 UTF-16 code units
    const result = parseFormatting('\u{1F600} **bold**');
    expect(result.text).toBe('\u{1F600} bold');
    // Emoji is 2 UTF-16 units + space = position 3
    expect(result.styles).toEqual(['3:4:BOLD']);
  });

  it('handles adjacent formatted regions', () => {
    const result = parseFormatting('**bold**`code`');
    expect(result.text).toBe('boldcode');
    expect(result.styles).toContain('0:4:BOLD');
    expect(result.styles).toContain('4:4:MONOSPACE');
  });

  it('returns text unchanged when no markers present', () => {
    const result = parseFormatting('No formatting here!');
    expect(result.text).toBe('No formatting here!');
    expect(result.styles).toEqual([]);
  });

  it('handles empty string', () => {
    const result = parseFormatting('');
    expect(result.text).toBe('');
    expect(result.styles).toEqual([]);
  });

  it('handles bold at start of string', () => {
    const result = parseFormatting('**bold** text');
    expect(result.text).toBe('bold text');
    expect(result.styles).toEqual(['0:4:BOLD']);
  });
});

describe('SignalChannel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('spawns signal-cli with correct args', async () => {
      const { spawn } = await import('child_process');
      const opts = createTestOpts();
      const channel = new SignalChannel(
        '+15559999999',
        '/usr/bin/signal-cli',
        opts,
      );

      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;

      expect(spawn).toHaveBeenCalledWith('/usr/bin/signal-cli', [
        '-a',
        '+15559999999',
        'jsonRpc',
      ]);
    });

    it('resolves after init timeout', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);

      const connectPromise = channel.connect();
      expect(channel.isConnected()).toBe(false);

      vi.advanceTimersByTime(1000);
      await connectPromise;

      expect(channel.isConnected()).toBe(true);
    });

    it('rejects on spawn error', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);

      const connectPromise = channel.connect();
      fakeProc.emit('error', new Error('spawn failed'));

      await expect(connectPromise).rejects.toThrow('spawn failed');
    });

    it('disconnect kills process', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);

      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;

      await channel.disconnect();
      expect(fakeProc.kill).toHaveBeenCalledWith('SIGTERM');
      expect(channel.isConnected()).toBe(false);
    });

    it('isConnected reflects state correctly', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);

      expect(channel.isConnected()).toBe(false);

      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;
      expect(channel.isConnected()).toBe(true);

      await channel.disconnect();
      expect(channel.isConnected()).toBe(false);
    });
  });

  // --- ownsJid ---

  describe('ownsJid', () => {
    it('owns signal: JIDs', () => {
      const channel = new SignalChannel('+1', 'signal-cli', createTestOpts());
      expect(channel.ownsJid('signal:+15551234567')).toBe(true);
    });

    it('does not own tg: JIDs', () => {
      const channel = new SignalChannel('+1', 'signal-cli', createTestOpts());
      expect(channel.ownsJid('tg:123')).toBe(false);
    });

    it('does not own whatsapp JIDs', () => {
      const channel = new SignalChannel('+1', 'signal-cli', createTestOpts());
      expect(channel.ownsJid('12345@g.us')).toBe(false);
    });
  });

  // --- Incoming messages ---

  describe('incoming messages', () => {
    async function connectChannel(opts?: Partial<ChannelOpts>) {
      const testOpts = createTestOpts(opts);
      const channel = new SignalChannel('+15559999999', 'signal-cli', testOpts);
      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;
      return { channel, opts: testOpts };
    }

    it('delivers text message for registered group', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: 1704067200000,
            dataMessage: { message: 'Hello' },
          },
        },
      });

      // Allow microtask
      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.any(String),
        'Alice',
        'signal',
        false,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          chat_jid: 'signal:+15551234567',
          sender: '+15551234567',
          sender_name: 'Alice',
          content: 'Hello',
        }),
      );
    });

    it('skips unregistered chat (metadata only)', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+19999999999',
            sourceName: 'Unknown',
            timestamp: Date.now(),
            dataMessage: { message: 'Hi' },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onChatMetadata).toHaveBeenCalled();
      expect(opts.onMessage).not.toHaveBeenCalled();
    });

    it('skips envelope with no dataMessage', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            timestamp: Date.now(),
            // No dataMessage — receipt or typing indicator
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).not.toHaveBeenCalled();
      expect(opts.onChatMetadata).not.toHaveBeenCalled();
    });

    it('transcribes voice attachment', async () => {
      mockTranscribeAudio.mockResolvedValueOnce('Transcribed text');
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              attachments: [{ contentType: 'audio/ogg', id: 'abc123' }],
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(mockTranscribeAudio).toHaveBeenCalled();
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          content: '[Voice: Transcribed text]',
        }),
      );
    });

    it('handles voice transcription failure', async () => {
      mockTranscribeAudio.mockResolvedValueOnce(null);
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              attachments: [{ contentType: 'audio/ogg', id: 'abc123' }],
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({
          content: '[Voice message - transcription unavailable]',
        }),
      );
    });

    it('handles group message with groupInfo', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: 'Group hello',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onChatMetadata).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.any(String),
        'Signal Group',
        'signal',
        true,
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          chat_jid: 'signal:test-group-id',
          content: 'Group hello',
        }),
      );
    });

    it('translates @mention to trigger format in group', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: 'Hey @Andy help me',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          content: '@Andy Hey @Andy help me',
        }),
      );
    });

    it('reconstructs U+FFFC self-mention to trigger name', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: '\uFFFC hello!',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
              mentions: [
                {
                  name: '+15559999999',
                  number: '+15559999999',
                  start: 0,
                  length: 1,
                },
              ],
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          content: '@Andy hello!',
        }),
      );
    });

    it('reconstructs U+FFFC mention for other users', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: 'hey \uFFFC check this',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
              mentions: [
                {
                  name: 'Bob',
                  number: '+15550000000',
                  start: 4,
                  length: 1,
                },
              ],
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          content: 'hey @Bob check this',
        }),
      );
    });

    it('reconstructs multiple U+FFFC mentions in one message', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: '\uFFFC and \uFFFC hello',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
              mentions: [
                {
                  name: '+15559999999',
                  number: '+15559999999',
                  start: 0,
                  length: 1,
                },
                {
                  name: 'Bob',
                  number: '+15550000000',
                  start: 6,
                  length: 1,
                },
              ],
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          content: '@Andy and @Bob hello',
        }),
      );
    });

    it('handles message with no mentions array gracefully', async () => {
      const { opts } = await connectChannel();

      emitJsonLine(fakeProc, {
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: {
              message: 'plain message',
              groupInfo: {
                groupId: 'test-group-id',
                groupName: 'Signal Group',
              },
            },
          },
        },
      });

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:test-group-id',
        expect.objectContaining({
          content: 'plain message',
        }),
      );
    });
  });

  // --- sendMessage ---

  describe('sendMessage', () => {
    async function connectChannel() {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);
      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;
      return { channel, proc: fakeProc };
    }

    it('sends RPC with formatting', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      // Resolve the RPC immediately
      const sendPromise = channel.sendMessage(
        'signal:+15551234567',
        'Hello **bold**',
      );
      // Read what was written to stdin
      await vi.advanceTimersByTimeAsync(0);

      const rpcLine = written.join('');
      const rpc = JSON.parse(rpcLine.trim());
      expect(rpc.method).toBe('send');
      expect(rpc.params.message).toBe('Hello bold');
      expect(rpc.params.textStyle).toEqual(['6:4:BOLD']);
      expect(rpc.params.recipient).toEqual(['+15551234567']);

      // Resolve the pending RPC
      emitJsonLine(proc, { id: rpc.id, result: {} });
      await sendPromise;
    });

    it('chunks messages at 2000 chars', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      const longText = 'x'.repeat(3000);
      const sendPromise = channel.sendMessage('signal:+15551234567', longText);
      await vi.advanceTimersByTimeAsync(0);

      // First chunk written, awaiting RPC response
      let lines = written.join('').trim().split('\n');
      expect(lines.length).toBe(1);
      const rpc1 = JSON.parse(lines[0]);
      expect(rpc1.params.message.length).toBe(2000);

      // Resolve first RPC so second chunk can be sent
      emitJsonLine(proc, { id: rpc1.id, result: {} });
      await vi.advanceTimersByTimeAsync(0);

      lines = written.join('').trim().split('\n');
      expect(lines.length).toBe(2);
      const rpc2 = JSON.parse(lines[1]);
      expect(rpc2.params.message.length).toBe(1000);

      emitJsonLine(proc, { id: rpc2.id, result: {} });
      await sendPromise;
    });

    it('sends to phone recipient', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      const sendPromise = channel.sendMessage('signal:+15551234567', 'Hi');
      await vi.advanceTimersByTimeAsync(0);

      const rpc = JSON.parse(written.join('').trim());
      expect(rpc.params.recipient).toEqual(['+15551234567']);
      expect(rpc.params.groupId).toBeUndefined();

      emitJsonLine(proc, { id: rpc.id, result: {} });
      await sendPromise;
    });

    it('sends to group recipient', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      const sendPromise = channel.sendMessage('signal:my-group-id', 'Hi group');
      await vi.advanceTimersByTimeAsync(0);

      const rpc = JSON.parse(written.join('').trim());
      expect(rpc.params.groupId).toBe('my-group-id');
      expect(rpc.params.recipient).toBeUndefined();

      emitJsonLine(proc, { id: rpc.id, result: {} });
      await sendPromise;
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    async function connectChannel() {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);
      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;
      return { channel, proc: fakeProc };
    }

    it('sends sendTyping RPC when typing', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      const typingPromise = channel.setTyping('signal:+15551234567', true);
      await vi.advanceTimersByTimeAsync(0);

      const rpc = JSON.parse(written.join('').trim());
      expect(rpc.method).toBe('sendTyping');

      emitJsonLine(proc, { id: rpc.id, result: {} });
      await typingPromise;
    });

    it('no-ops when not typing', async () => {
      const { channel, proc } = await connectChannel();

      const written: string[] = [];
      proc.stdin.on('data', (chunk: Buffer) => written.push(chunk.toString()));

      await channel.setTyping('signal:+15551234567', false);

      expect(written).toHaveLength(0);
    });
  });

  // --- Line buffering ---

  describe('line buffering', () => {
    it('handles partial JSON across chunks', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);
      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;

      const msg = JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: Date.now(),
            dataMessage: { message: 'Split message' },
          },
        },
      });

      // Send in two chunks
      const mid = Math.floor(msg.length / 2);
      fakeProc.stdout.push(msg.slice(0, mid));
      fakeProc.stdout.push(msg.slice(mid) + '\n');

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: 'Split message' }),
      );
    });

    it('handles multiple lines in one chunk', async () => {
      const opts = createTestOpts();
      const channel = new SignalChannel('+15559999999', 'signal-cli', opts);
      const connectPromise = channel.connect();
      vi.advanceTimersByTime(1000);
      await connectPromise;

      const msg1 = JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: 1000,
            dataMessage: { message: 'First' },
          },
        },
      });
      const msg2 = JSON.stringify({
        method: 'receive',
        params: {
          envelope: {
            sourceNumber: '+15551234567',
            sourceName: 'Alice',
            timestamp: 2000,
            dataMessage: { message: 'Second' },
          },
        },
      });

      // Both lines in one chunk
      fakeProc.stdout.push(msg1 + '\n' + msg2 + '\n');

      await vi.advanceTimersByTimeAsync(0);

      expect(opts.onMessage).toHaveBeenCalledTimes(2);
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: 'First' }),
      );
      expect(opts.onMessage).toHaveBeenCalledWith(
        'signal:+15551234567',
        expect.objectContaining({ content: 'Second' }),
      );
    });
  });
});
