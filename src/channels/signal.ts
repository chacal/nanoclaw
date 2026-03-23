import { ChildProcess, spawn } from 'child_process';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, chunkText, ChannelOpts } from './registry.js';
import { Channel } from '../types.js';

export class SignalChannel implements Channel {
  name = 'signal';

  private proc: ChildProcess | null = null;
  private opts: ChannelOpts;
  private phoneNumber: string;
  private signalCliPath: string;
  private connected = false;
  private rpcId = 0;
  private pendingRequests = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  private lineBuffer = '';
  /** Maps phone numbers and UUIDs to display names from previously seen messages. */
  private nameCache = new Map<string, string>();

  constructor(phoneNumber: string, signalCliPath: string, opts: ChannelOpts) {
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
          // Pre-populate name cache from known contacts (best-effort)
          this.prefillNameCache().catch((err) => {
            logger.debug({ err }, 'Failed to prefill Signal name cache');
          });
        }
      }, 1000);
    });
  }

  /**
   * Fetch known contacts from signal-cli and populate the name cache so that
   * mentions can be resolved to display names immediately after startup.
   */
  private async prefillNameCache(): Promise<void> {
    const contacts: any[] = await this.sendRpc('listContacts', {});
    if (!Array.isArray(contacts)) return;
    let count = 0;
    for (const c of contacts) {
      const name = c.profileName || c.name;
      if (!name) continue;
      if (c.number && name !== c.number) {
        this.nameCache.set(c.number, name);
        count++;
      }
      if (c.uuid && name !== c.uuid) {
        this.nameCache.set(c.uuid, name);
        count++;
      }
    }
    if (count > 0) {
      logger.info({ entries: count }, 'Signal name cache prefilled from contacts');
    }
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
        pending.reject(
          new Error(msg.error.message || JSON.stringify(msg.error)),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    // JSON-RPC notification (incoming message)
    if (msg.method === 'receive') {
      this.handleNotification(msg.params).catch((err) => {
        logger.error({ err }, 'Unhandled error in Signal notification handler');
      });
    }
  }

  private async handleNotification(params: any): Promise<void> {
    const envelope = params?.envelope;
    if (!envelope) return;

    const dataMessage = envelope.dataMessage;
    if (!dataMessage) return; // Skip receipts, typing indicators, etc.

    // Check for voice message attachments
    // signal-cli stores attachments at ~/.local/share/signal-cli/attachments/{id}
    const ATTACHMENTS_DIR =
      process.env.HOME + '/.local/share/signal-cli/attachments';
    const attachments = dataMessage.attachments || [];
    const voiceAttachment = attachments.find(
      (a: any) => a.contentType?.startsWith('audio/') && a.id,
    );
    let voiceFilePath: string | null = null;
    if (voiceAttachment) {
      const resolved = path.resolve(ATTACHMENTS_DIR, voiceAttachment.id);
      if (resolved.startsWith(ATTACHMENTS_DIR + path.sep)) {
        voiceFilePath = resolved;
      } else {
        logger.warn(
          { id: voiceAttachment.id },
          'Attachment ID escapes attachments directory, ignoring',
        );
      }
    }

    const text = dataMessage.message;
    if (!text && !voiceFilePath) return; // Skip if no text and no voice

    // Signal uses UUIDs as primary identifiers; phone number may be null
    const source =
      envelope.sourceNumber || envelope.sourceUuid || envelope.source;
    if (!source) return;

    const sourceName = envelope.sourceName || source;
    const timestamp = new Date(envelope.timestamp || Date.now()).toISOString();

    // Cache sender name so we can resolve mentions by phone number or UUID
    if (sourceName && sourceName !== source) {
      this.nameCache.set(source, sourceName);
    }
    const sourceUuid = envelope.sourceUuid;
    if (sourceUuid && sourceName && sourceName !== sourceUuid) {
      this.nameCache.set(sourceUuid, sourceName);
    }

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

    // Build content: text message or voice transcription
    let content = text || '';

    // Signal mentions replace the mentioned name with U+FFFC (object replacement
    // character) in the message body. The actual mention data is in dataMessage.mentions.
    // Reconstruct the text by replacing each placeholder with @name.
    const mentions = dataMessage.mentions || [];
    if (mentions.length > 0 && content) {
      // Sort by start position descending so replacements don't shift indices
      const sorted = [...mentions].sort(
        (a: any, b: any) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const m of sorted) {
        const start = m.start ?? 0;
        const len = m.length ?? 1;
        if (start < 0 || start >= content.length) continue;
        // Signal puts phone number or UUID as mention name — map our own
        // number/UUID to the assistant name so the trigger pattern matches.
        const isSelf = m.number === this.phoneNumber;
        const name = isSelf ? ASSISTANT_NAME : this.resolveMentionName(m);
        content =
          content.slice(0, start) + `@${name}` + content.slice(start + len);
      }
    }

    if (voiceFilePath) {
      const transcript = await transcribeAudio(
        voiceFilePath,
        voiceAttachment.contentType,
      );
      if (transcript) {
        content = content
          ? `${content}\n[Voice: ${transcript}]`
          : `[Voice: ${transcript}]`;
        logger.info(
          { chatJid, chars: transcript.length },
          'Voice message transcribed',
        );
      } else {
        content = content
          ? `${content}\n[Voice message - transcription unavailable]`
          : '[Voice message - transcription unavailable]';
      }
    }

    if (!content) return;

    // Translate @mention to trigger format (like Telegram does)
    const namePattern = new RegExp(
      `@${ASSISTANT_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`,
      'i',
    );
    if (
      isGroup &&
      namePattern.test(content) &&
      !TRIGGER_PATTERN.test(content)
    ) {
      content = `@${ASSISTANT_NAME} ${content}`;
    }

    const isFromMe =
      source === this.phoneNumber || envelope.sourceNumber === this.phoneNumber;

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

  /**
   * Resolve a mention to a display name.  signal-cli often puts the phone
   * number or UUID into the `name` field — look up a real name from the cache
   * built from previously seen messages.
   */
  private resolveMentionName(mention: any): string {
    const { name, number: num, uuid } = mention;
    // If signal-cli already provided a real name (not a phone number/UUID), use it
    if (name && !name.startsWith('+') && !/^[0-9a-f]{8}-/.test(name)) {
      return name;
    }
    // Try cache lookup by phone number, then UUID
    if (num) {
      const cached = this.nameCache.get(num);
      if (cached) return cached;
    }
    if (uuid) {
      const cached = this.nameCache.get(uuid);
      if (cached) return cached;
    }
    return name || 'unknown';
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

  /** Build recipient/groupId params for an outbound RPC call. */
  private recipientParams(jid: string): Record<string, any> {
    const id = jid.replace(/^signal:/, '');
    const isDirectRecipient =
      id.startsWith('+') || /^[0-9a-f]{8}-[0-9a-f]{4}-/.test(id);
    return isDirectRecipient ? { recipient: [id] } : { groupId: id };
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.proc) {
      logger.warn('Signal not connected');
      return;
    }

    try {
      for (const chunk of chunkText(text, 2000)) {
        const { text: plainText, styles } = parseFormatting(chunk);
        const params: any = {
          message: plainText,
          ...this.recipientParams(jid),
        };
        if (styles.length > 0) {
          params.textStyle = styles;
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
    try {
      await this.sendRpc('sendTyping', this.recipientParams(jid));
    } catch {
      // Typing indicators are best-effort
    }
  }
}

/**
 * Parse markdown-style formatting from text and convert to Signal body ranges.
 * Returns the plain text and an array of "start:length:STYLE" strings.
 *
 * Uses a single-pass approach: find all markers, sort by position, then strip
 * markers while tracking position offsets. This avoids cross-pattern position bugs.
 */
export function parseFormatting(input: string): {
  text: string;
  styles: string[];
} {
  // Find all format markers with their positions in the original text
  const markers: Array<{
    index: number;
    fullMatch: string;
    content: string;
    style: string;
  }> = [];

  const patterns: Array<{ re: RegExp; style: string }> = [
    { re: /\*\*(.+?)\*\*/g, style: 'BOLD' },
    { re: /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, style: 'ITALIC' },
    { re: /~~(.+?)~~/g, style: 'STRIKETHROUGH' },
    { re: /`([^`]+)`/g, style: 'MONOSPACE' },
  ];

  for (const { re, style } of patterns) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(input)) !== null) {
      markers.push({
        index: match.index,
        fullMatch: match[0],
        content: match[1],
        style,
      });
    }
  }

  // Remove overlapping matches (e.g. ** inside `) — keep the first one at each position
  markers.sort((a, b) => a.index - b.index);
  const filtered: typeof markers = [];
  let lastEnd = 0;
  for (const m of markers) {
    if (m.index >= lastEnd) {
      filtered.push(m);
      lastEnd = m.index + m.fullMatch.length;
    }
  }

  // Build output text and style list in a single pass
  const styles: string[] = [];
  let result = '';
  let cursor = 0;

  for (const m of filtered) {
    // Append text before this marker
    result += input.slice(cursor, m.index);
    // Record style at the current position in the output
    const start = Buffer.from(result, 'utf16le').length / 2;
    const length = Buffer.from(m.content, 'utf16le').length / 2;
    styles.push(`${start}:${length}:${m.style}`);
    // Append the content without markers
    result += m.content;
    cursor = m.index + m.fullMatch.length;
  }
  // Append remaining text
  result += input.slice(cursor);

  return { text: result, styles };
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
