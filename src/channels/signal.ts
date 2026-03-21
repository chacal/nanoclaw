import { ChildProcess, spawn } from 'child_process';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import { Channel, RegisteredGroup } from '../types.js';

export interface SignalChannelOpts {
  onMessage: (chatJid: string, message: any) => void;
  onChatMetadata: (
    chatJid: string,
    timestamp: string,
    name?: string,
    channel?: string,
    isGroup?: boolean,
  ) => void;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class SignalChannel implements Channel {
  name = 'signal';

  private proc: ChildProcess | null = null;
  private opts: SignalChannelOpts;
  private phoneNumber: string;
  private signalCliPath: string;
  private connected = false;
  private rpcId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private lineBuffer = '';

  constructor(
    phoneNumber: string,
    signalCliPath: string,
    opts: SignalChannelOpts,
  ) {
    this.phoneNumber = phoneNumber;
    this.signalCliPath = signalCliPath;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.proc = spawn(this.signalCliPath, [
        '-a',
        this.phoneNumber,
        'jsonRpc',
      ]);

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.lineBuffer += chunk.toString();
        const lines = this.lineBuffer.split('\n');
        // Keep the last incomplete line in the buffer
        this.lineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) {
            this.handleLine(line.trim());
          }
        }
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          // Filter out routine info messages
          if (text.includes('INFO')) {
            logger.debug({ text }, 'signal-cli info');
          } else {
            logger.warn({ text }, 'signal-cli stderr');
          }
        }
      });

      this.proc.on('close', (code) => {
        this.connected = false;
        // Reject any pending RPC requests
        for (const [, pending] of this.pendingRequests) {
          pending.reject(new Error(`signal-cli exited with code ${code}`));
        }
        this.pendingRequests.clear();
        logger.warn({ code }, 'signal-cli process exited');
      });

      this.proc.on('error', (err) => {
        this.connected = false;
        logger.error({ err }, 'signal-cli spawn error');
        reject(err);
      });

      // signal-cli in jsonRpc mode is ready immediately after spawn
      // Give it a moment to initialize
      setTimeout(() => {
        if (this.proc && !this.proc.killed) {
          this.connected = true;
          logger.info(
            { phoneNumber: this.phoneNumber },
            'Signal channel connected',
          );
          console.log(`\n  Signal: ${this.phoneNumber}`);
          console.log(`  Send a message to this number to start chatting\n`);
          resolve();
        }
      }, 1000);
    });
  }

  private handleLine(line: string): void {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      logger.debug({ line }, 'Non-JSON line from signal-cli');
      return;
    }

    // JSON-RPC response (has id matching a pending request)
    if (msg.id != null && this.pendingRequests.has(msg.id)) {
      const pending = this.pendingRequests.get(msg.id)!;
      this.pendingRequests.delete(msg.id);
      if (msg.error) {
        pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (incoming message)
    if (msg.method === 'receive') {
      this.handleNotification(msg.params);
    }
  }

  private handleNotification(params: any): void {
    const envelope = params?.envelope;
    if (!envelope) return;

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return; // Skip receipts, typing indicators, etc.

    const text = dataMessage.message;
    if (!text) return; // Skip non-text messages (attachments-only, etc.)

    // Signal uses UUIDs as primary identifiers; phone number may be null
    const source =
      envelope.sourceNumber || envelope.sourceUuid || envelope.source;
    if (!source) return;

    const sourceName = envelope.sourceName || source;
    const timestamp = new Date(
      envelope.timestamp || Date.now(),
    ).toISOString();

    // Determine if group or 1:1
    const groupInfo = dataMessage.groupInfo;
    const isGroup = !!groupInfo;
    let chatJid: string;
    let chatName: string;

    if (isGroup && groupInfo.groupId) {
      chatJid = `signal:${groupInfo.groupId}`;
      chatName = groupInfo.groupName || groupInfo.groupId;
    } else {
      chatJid = `signal:${source}`;
      chatName = sourceName;
    }

    // Translate @mention to trigger format (like Telegram does)
    let content = text;
    const namePattern = new RegExp(
      `@${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    if (isGroup && namePattern.test(content) && !TRIGGER_PATTERN.test(content)) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    const isFromMe =
      source === this.phoneNumber ||
      envelope.sourceNumber === this.phoneNumber;

    // Store chat metadata
    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    // Only deliver full message for registered groups
    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    this.opts.onMessage(chatJid, {
      id: String(envelope.timestamp),
      chat_jid: chatJid,
      sender: source,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me: isFromMe,
    });

    logger.info(
      { chatJid, chatName, sender: sourceName },
      'Signal message stored',
    );
  }

  private sendRpc(method: string, params: any): Promise<any> {
    if (!this.proc || !this.proc.stdin || this.proc.killed) {
      return Promise.reject(new Error('signal-cli not running'));
    }

    const id = ++this.rpcId;
    const request = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, 30000);

      this.pendingRequests.set(id, {
        resolve: (v) => {
          clearTimeout(timeout);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timeout);
          reject(e);
        },
      });

      this.proc!.stdin!.write(request + '\n');
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.proc) {
      logger.warn('Signal not connected');
      return;
    }

    try {
      const id = jid.replace(/^signal:/, '');

      // Signal has ~2000 char limit per message
      const MAX_LENGTH = 2000;
      const chunks =
        text.length <= MAX_LENGTH
          ? [text]
          : Array.from(
              { length: Math.ceil(text.length / MAX_LENGTH) },
              (_, i) => text.slice(i * MAX_LENGTH, (i + 1) * MAX_LENGTH),
            );

      for (const chunk of chunks) {
        const { text: plainText, styles } = parseFormatting(chunk);
        const isPhone = id.startsWith('+');
        const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id);
        const params: any = {
          message: plainText,
        };
        if (styles.length > 0) {
          params.textStyle = styles;
        }
        if (isPhone || isUuid) {
          params.recipient = [id];
        } else {
          params.groupId = id;
        }
        await this.sendRpc('send', params);
      }

      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  isConnected(): boolean {
    return this.connected && this.proc !== null && !this.proc.killed;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('signal:');
  }

  async disconnect(): Promise<void> {
    if (this.proc) {
      this.proc.kill('SIGTERM');
      this.proc = null;
      this.connected = false;
      logger.info('Signal channel disconnected');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.proc || !isTyping) return;
    // Signal doesn't have a reliable typing indicator via signal-cli jsonRpc
  }
}

/**
 * Parse markdown-style formatting from text and convert to Signal body ranges.
 * Returns the plain text and an array of "start:length:STYLE" strings.
 * Processes in order: bold (**), italic (*), strikethrough (~~), monospace (`).
 */
function parseFormatting(input: string): {
  text: string;
  styles: string[];
} {
  const styles: Array<{ start: number; length: number; style: string }> = [];
  let text = input;

  // Process patterns from most specific to least specific
  const patterns: Array<{ re: RegExp; style: string }> = [
    { re: /\*\*(.+?)\*\*/g, style: 'BOLD' },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, style: 'ITALIC' },
    { re: /~~(.+?)~~/g, style: 'STRIKETHROUGH' },
    { re: /`([^`]+)`/g, style: 'MONOSPACE' },
  ];

  for (const { re, style } of patterns) {
    const result: string[] = [];
    let lastIndex = 0;
    let offset = 0;
    let match: RegExpExecArray | null;

    // Reset regex
    re.lastIndex = 0;

    while ((match = re.exec(text)) !== null) {
      const fullMatch = match[0];
      const content = match[1];
      const markerLen = (fullMatch.length - content.length) / 2;

      result.push(text.slice(lastIndex, match.index));
      const start = match.index - offset;
      // UTF-16 length for signal-cli
      const utf16Len = Buffer.from(content, 'utf16le').length / 2;
      styles.push({ start, length: utf16Len, style });
      result.push(content);
      offset += markerLen * 2;
      lastIndex = match.index + fullMatch.length;
    }
    result.push(text.slice(lastIndex));
    text = result.join('');
  }

  return {
    text,
    styles: styles.map((s) => `${s.start}:${s.length}:${s.style}`),
  };
}

registerChannel('signal', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['SIGNAL_PHONE_NUMBER', 'SIGNAL_CLI_PATH']);
  const phoneNumber =
    process.env.SIGNAL_PHONE_NUMBER || envVars.SIGNAL_PHONE_NUMBER || '';
  const cliPath =
    process.env.SIGNAL_CLI_PATH || envVars.SIGNAL_CLI_PATH || 'signal-cli';
  if (!phoneNumber) {
    logger.warn('Signal: SIGNAL_PHONE_NUMBER not set');
    return null;
  }
  return new SignalChannel(phoneNumber, cliPath, opts);
});
