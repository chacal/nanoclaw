import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { ingestImage } from '../image-ingest.js';
import { logger } from '../logger.js';
import { parseSignalStyles } from '../text-styles.js';
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
      });

      this.proc.on('error', (err) => {
        this.connected = false;
        logger.error({ err }, 'signal-cli spawn error');
        reject(err);
      });

      // signal-cli in jsonRpc mode is ready immediately; give it a moment.
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
      }, READY_DELAY_MS);
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

    const text = dataMessage.message;
    if (!text && !imageAttachment) return;

    const source =
      envelope.sourceNumber || envelope.sourceUuid || envelope.source;
    if (!source) return;

    const sourceName = envelope.sourceName || source;
    const timestamp = new Date(envelope.timestamp || Date.now()).toISOString();

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
