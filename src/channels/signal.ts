import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { ingestImage } from '../image-ingest.js';
import { logger } from '../logger.js';
import { parseSignalStyles } from '../text-styles.js';
import { transcribeAudio } from '../transcription.js';
import { Channel, NewMessage } from '../types.js';
import { registerChannel, ChannelOpts } from './registry.js';

const RPC_TIMEOUT_MS = 30_000;
const READY_DELAY_MS = 1_000;
const SEND_CHUNK_SIZE = 2_000;

const SIGNAL_ATTACHMENTS_DIR =
  process.env.SIGNAL_ATTACHMENTS_DIR ||
  `${process.env.HOME}/.local/share/signal-cli/attachments`;

const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/**
 * Resolve an attachment id to its on-disk path inside signal-cli's attachments
 * dir, rejecting any traversal attempts (e.g. "../foo").
 */
function resolveSafeAttachmentPath(id: string, baseDir: string): string | null {
  const resolved = path.resolve(baseDir, id);
  if (!resolved.startsWith(baseDir + path.sep)) {
    logger.warn({ id }, 'Signal attachment id escapes attachments directory');
    return null;
  }
  return resolved;
}

export function chunkText(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += max) {
    chunks.push(text.slice(i, i + max));
  }
  return chunks;
}

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
  /** Maps phone numbers and UUIDs to display names so mentions carrying
   *  signal-cli's phone/UUID fallback can be resolved to a real name. */
  private nameCache = new Map<string, string>();

  constructor(phoneNumber: string, signalCliPath: string, opts: ChannelOpts) {
    this.phoneNumber = phoneNumber;
    this.signalCliPath = signalCliPath;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (err) reject(err);
        else resolve();
      };

      this.proc = spawn(this.signalCliPath, [
        '-a',
        this.phoneNumber,
        'jsonRpc',
      ]);

      this.proc.stdout!.on('data', (chunk: Buffer) => {
        this.lineBuffer += chunk.toString();
        const lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop() || '';
        for (const line of lines) {
          if (line.trim()) this.handleLine(line.trim());
        }
      });

      this.proc.stderr!.on('data', (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (!text) return;
        if (text.includes('INFO')) logger.debug({ text }, 'signal-cli info');
        else logger.warn({ text }, 'signal-cli stderr');
      });

      this.proc.on('close', (code) => {
        this.connected = false;
        for (const [, p] of this.pendingRequests) {
          p.reject(new Error(`signal-cli exited with code ${code}`));
        }
        this.pendingRequests.clear();
        logger.warn({ code }, 'signal-cli process exited');
        // If connect() hasn't resolved yet, the process died during startup —
        // fail rather than silently reporting success via the ready timer.
        settle(new Error(`signal-cli exited during startup with code ${code}`));
      });

      this.proc.on('error', (err) => {
        this.connected = false;
        logger.error({ err }, 'signal-cli spawn error');
        settle(err);
      });

      // signal-cli in jsonRpc mode is ready immediately; give it a moment.
      setTimeout(() => {
        if (settled) return;
        if (this.proc && !this.proc.killed) {
          this.connected = true;
          logger.info(
            { phoneNumber: this.phoneNumber },
            'Signal channel connected',
          );
          console.log(`\n  Signal: ${this.phoneNumber}`);
          console.log(`  Send a message to this number to start chatting\n`);
          settle();
          this.prefillNameCache().catch((err) => {
            logger.debug({ err }, 'Failed to prefill Signal name cache');
          });
        }
      }, READY_DELAY_MS);
    });
  }

  /**
   * Fetch contacts via signal-cli's JSON-RPC so mentions can be resolved to
   * display names from the very first inbound group message. Best-effort:
   * failures are logged and swallowed.
   */
  private async prefillNameCache(): Promise<void> {
    const contacts: any[] = await this.sendRpc('listContacts', {});
    if (!Array.isArray(contacts)) return;
    let count = 0;
    for (const c of contacts) {
      const name = c?.profileName || c?.name;
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
      logger.info(
        { entries: count },
        'Signal name cache prefilled from contacts',
      );
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
    if (!dataMessage) return;

    const attachments: any[] = dataMessage.attachments || [];
    const imageAttachment = attachments.find(
      (a) => a?.contentType?.startsWith('image/') && a?.id,
    );
    const voiceAttachment = attachments.find(
      (a) => a?.contentType?.startsWith('audio/') && a?.id,
    );

    const text = dataMessage.message;
    if (!text && !imageAttachment && !voiceAttachment) return;

    const source =
      envelope.sourceNumber || envelope.sourceUuid || envelope.source;
    if (!source) return;

    const sourceName = envelope.sourceName || source;
    const timestamp = new Date(envelope.timestamp || Date.now()).toISOString();

    // Cache sender identifiers → display name, so later messages that
    // mention this user (and carry only a phone/UUID as `name`) can be
    // reconstructed with the real name.
    if (sourceName && sourceName !== source) {
      this.nameCache.set(source, sourceName);
    }
    const sourceUuid = envelope.sourceUuid;
    if (sourceUuid && sourceName && sourceName !== sourceUuid) {
      this.nameCache.set(sourceUuid, sourceName);
    }

    const groupInfo = dataMessage.groupInfo;
    const isGroup = !!groupInfo;
    const chatJid =
      isGroup && groupInfo.groupId
        ? `signal:${groupInfo.groupId}`
        : `signal:${source}`;
    const chatName = isGroup
      ? groupInfo.groupName || groupInfo.groupId
      : sourceName;

    let content = text || '';

    // Signal transmits mentions as U+FFFC (object replacement character) in
    // the message body with the actual mention data in dataMessage.mentions.
    // Reconstruct "@name" spans so the trigger pattern check + human readers
    // see names instead of opaque placeholders.
    const mentions: any[] = dataMessage.mentions || [];
    if (mentions.length > 0 && content) {
      // Descending start order so each slice-and-splice doesn't shift the
      // indices of mentions that follow.
      const sorted = [...mentions].sort(
        (a, b) => (b.start ?? 0) - (a.start ?? 0),
      );
      for (const m of sorted) {
        const start = m.start ?? 0;
        const len = m.length ?? 1;
        // Guard against malformed mention data (out-of-range start) to avoid
        // silent truncation of the message body.
        if (start < 0 || start >= content.length) continue;
        const isSelf = m.number === this.phoneNumber;
        const name = isSelf ? ASSISTANT_NAME : this.resolveMentionName(m);
        content =
          content.slice(0, start) + `@${name}` + content.slice(start + len);
      }
    }

    // Translate "@Andy …" in group chats into the configured trigger form so
    // the router's trigger check fires.
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

    this.opts.onChatMetadata(chatJid, timestamp, chatName, 'signal', isGroup);

    const group = this.opts.registeredGroups()[chatJid];
    if (!group) {
      logger.debug(
        { chatJid, chatName },
        'Message from unregistered Signal chat',
      );
      return;
    }

    if (imageAttachment) {
      let marker: string | null = null;
      const safePath = resolveSafeAttachmentPath(
        imageAttachment.id,
        SIGNAL_ATTACHMENTS_DIR,
      );
      if (safePath) {
        try {
          const data = fs.readFileSync(safePath);
          const ext = MIME_TO_EXT[imageAttachment.contentType] || '.jpg';
          marker = ingestImage(
            data,
            'sig',
            imageAttachment.id,
            ext,
            group.folder,
          );
        } catch (err) {
          logger.warn(
            { err, chatJid, id: imageAttachment.id },
            'Failed to read Signal image attachment',
          );
        }
      }
      const finalMarker = marker ?? '[Image unavailable]';
      content = content ? `${content}\n${finalMarker}` : finalMarker;
    }

    if (voiceAttachment) {
      const safePath = resolveSafeAttachmentPath(
        voiceAttachment.id,
        SIGNAL_ATTACHMENTS_DIR,
      );
      let marker = '[Voice message - unavailable]';
      if (safePath) {
        const transcript = await transcribeAudio(
          safePath,
          voiceAttachment.contentType,
        );
        marker = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice message - transcription unavailable]';
      }
      content = content ? `${content}\n${marker}` : marker;
    }

    if (!content) return;

    const newMessage: NewMessage = {
      id: String(envelope.timestamp),
      chat_jid: chatJid,
      sender: source,
      sender_name: sourceName,
      content,
      timestamp,
      is_from_me: isFromMe,
    };
    this.opts.onMessage(chatJid, newMessage);
    logger.info(
      { chatJid, chatName, sender: sourceName },
      'Signal message stored',
    );
  }

  /**
   * Resolve a mention payload to a display name. signal-cli frequently puts
   * the phone number or UUID into `name` when the user isn't a saved contact;
   * fall back to the cache of names we've seen or been told about.
   */
  private resolveMentionName(mention: any): string {
    const { name, number: num, uuid } = mention;
    // A real name doesn't look like a phone number (starts with +) or a UUID
    // (8-hex-dash-...); if signal-cli gave us one, trust it.
    if (name && !name.startsWith('+') && !/^[0-9a-f]{8}-/.test(name)) {
      return name;
    }
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
    const request = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`RPC timeout for ${method}`));
      }, RPC_TIMEOUT_MS);

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
      for (const chunk of chunkText(text, SEND_CHUNK_SIZE)) {
        const { text: plainText, textStyle } = parseSignalStyles(chunk);
        const params: Record<string, any> = {
          message: plainText,
          ...this.recipientParams(jid),
        };
        if (textStyle.length > 0) {
          params.textStyle = textStyle.map(
            (s) => `${s.start}:${s.length}:${s.style}`,
          );
        }
        await this.sendRpc('send', params);
      }
      logger.info({ jid, length: text.length }, 'Signal message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal message');
    }
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.proc) {
      logger.warn('Signal not connected');
      return;
    }
    try {
      const params: Record<string, any> = {
        ...this.recipientParams(jid),
        attachment: [filePath],
      };
      if (caption) {
        const { text: plainText, textStyle } = parseSignalStyles(caption);
        params.message = plainText;
        if (textStyle.length > 0) {
          params.textStyle = textStyle.map(
            (s) => `${s.start}:${s.length}:${s.style}`,
          );
        }
      }
      await this.sendRpc('send', params);
      logger.info({ jid, filePath }, 'Signal image sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Signal image');
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
      // Typing indicators are best-effort.
    }
  }
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
