import fs from 'fs';
import https from 'https';
import path from 'path';

import { Api, Bot, InputFile } from 'grammy';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { ingestImage } from '../image-ingest.js';
import { logger } from '../logger.js';
import { transcribeAudio } from '../transcription.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * Send a message with Telegram Markdown parse mode, falling back to plain text.
 * Claude's output naturally matches Telegram's Markdown v1 format:
 *   *bold*, _italic_, `code`, ```code blocks```, [links](url)
 */
async function sendTelegramMessage(
  api: { sendMessage: Api['sendMessage'] },
  chatId: string | number,
  text: string,
  options: { message_thread_id?: number } = {},
): Promise<void> {
  try {
    await api.sendMessage(chatId, text, {
      ...options,
      parse_mode: 'Markdown',
    });
  } catch (err) {
    // Fallback: send as plain text if Markdown parsing fails
    logger.debug({ err }, 'Markdown send failed, falling back to plain text');
    await api.sendMessage(chatId, text, options);
  }
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  /**
   * Download a Telegram file to the group's attachments directory.
   * Returns the container-relative path (e.g. /workspace/group/attachments/photo_123.jpg)
   * or null if the download fails.
   */
  private async downloadFile(
    fileId: string,
    groupFolder: string,
    filename: string,
  ): Promise<string | null> {
    if (!this.bot) return null;

    try {
      const file = await this.bot.api.getFile(fileId);
      if (!file.file_path) {
        logger.warn({ fileId }, 'Telegram getFile returned no file_path');
        return null;
      }

      const groupDir = resolveGroupFolderPath(groupFolder);
      const attachDir = path.join(groupDir, 'attachments');
      fs.mkdirSync(attachDir, { recursive: true });

      // Sanitize filename and add extension from Telegram's file_path if missing
      const tgExt = path.extname(file.file_path);
      const localExt = path.extname(filename);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const finalName = localExt ? safeName : `${safeName}${tgExt}`;
      const destPath = path.join(attachDir, finalName);

      const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
      const resp = await fetch(fileUrl);
      if (!resp.ok) {
        logger.warn(
          { fileId, status: resp.status },
          'Telegram file download failed',
        );
        return null;
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(destPath, buffer);

      logger.info({ fileId, dest: destPath }, 'Telegram file downloaded');
      return `/workspace/group/attachments/${finalName}`;
    } catch (err) {
      logger.error({ fileId, err }, 'Failed to download Telegram file');
      return null;
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken, {
      client: {
        baseFetchConfig: { agent: https.globalAgent, compress: true },
      },
    });

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    // Telegram bot commands handled above — skip them in the general handler
    // so they don't also get stored as messages. All other /commands flow through.
    const TELEGRAM_BOT_COMMANDS = new Set(['chatid', 'ping']);

    this.bot.on('message:text', async (ctx) => {
      if (ctx.message.text.startsWith('/')) {
        const cmd = ctx.message.text.slice(1).split(/[\s@]/)[0].toLowerCase();
        if (TELEGRAM_BOT_COMMANDS.has(cmd)) return;
      }

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();
      const threadId = ctx.message.message_thread_id;

      const replyTo = ctx.message.reply_to_message;
      const replyToMessageId = replyTo?.message_id?.toString();
      const replyToContent = replyTo?.text || replyTo?.caption;
      const replyToSenderName = replyTo
        ? replyTo.from?.first_name ||
          replyTo.from?.username ||
          replyTo.from?.id?.toString() ||
          'Unknown'
        : undefined;

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';
      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        chatName,
        'telegram',
        isGroup,
      );

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
        thread_id: threadId ? threadId.toString() : undefined,
        reply_to_message_id: replyToMessageId,
        reply_to_message_content: replyToContent,
        reply_to_sender_name: replyToSenderName,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Shared inbound-media delivery: computes chatJid + per-message metadata,
    // emits onChatMetadata, invokes a caller-supplied buildContent that
    // decides the message body, and finally fires onMessage. All specific
    // handlers (photo / voice / audio / video / document / sticker / …) are
    // just different buildContent implementations.
    interface MediaContext {
      group: RegisteredGroup;
      caption: string;
      msgId: string;
    }
    const deliverMedia = async (
      ctx: any,
      buildContent: (mc: MediaContext) => string | Promise<string>,
    ): Promise<void> => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';
      const msgId = ctx.message.message_id.toString();
      const isGroup =
        ctx.chat.type === 'group' || ctx.chat.type === 'supergroup';

      this.opts.onChatMetadata(
        chatJid,
        timestamp,
        undefined,
        'telegram',
        isGroup,
      );

      const content = await buildContent({ group, caption, msgId });
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    // Generic placeholder delivery for non-text messages with optional file
    // download. Produces "[Type] (container/path)caption" or just the
    // placeholder when no fileId or the download fails.
    const placeholderContent = async (
      placeholder: string,
      { group, caption, msgId }: MediaContext,
      opts?: { fileId?: string; filename?: string },
    ): Promise<string> => {
      if (!opts?.fileId) return `${placeholder}${caption}`;
      const filename =
        opts.filename ||
        `${placeholder.replace(/[\[\] ]/g, '').toLowerCase()}_${msgId}`;
      const filePath = await this.downloadFile(
        opts.fileId,
        group.folder,
        filename,
      );
      return filePath
        ? `${placeholder} (${filePath})${caption}`
        : `${placeholder}${caption}`;
    };

    this.bot.on('message:photo', (ctx) =>
      deliverMedia(ctx, async ({ group, caption, msgId }) => {
        try {
          if (!this.bot) throw new Error('Bot not connected');
          // Telegram sends sizes smallest→largest (typically 90/320/800/1280 px).
          // Take second-to-largest when available — plenty of detail for vision
          // at a fraction of the base64 payload cost.
          const photos = ctx.message.photo;
          const photo =
            photos.length >= 3
              ? photos[photos.length - 2]
              : photos[photos.length - 1];
          const file = await this.bot.api.getFile(photo.file_id);
          if (file.file_path) {
            const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
            const resp = await fetch(url);
            if (resp.ok) {
              const data = Buffer.from(await resp.arrayBuffer());
              const ext = path.extname(file.file_path) || '.jpg';
              const marker = ingestImage(data, 'tg', msgId, ext, group.folder);
              if (marker) return `${marker}${caption}`;
            }
          }
        } catch (err) {
          logger.warn({ err }, 'Failed to download Telegram photo');
        }
        return `[Photo]${caption}`;
      }),
    );

    this.bot.on('message:video', (ctx) =>
      deliverMedia(ctx, (mc) =>
        placeholderContent('[Video]', mc, {
          fileId: ctx.message.video?.file_id,
          filename: `video_${ctx.message.message_id}`,
        }),
      ),
    );

    const transcriptContent = async (
      opts: { fileId?: string; filename: string; mimeType?: string },
      { group, caption }: MediaContext,
    ): Promise<string> => {
      if (!opts.fileId) return `[Voice message - no file]${caption}`;
      try {
        if (!this.bot) throw new Error('Bot not connected');
        const file = await this.bot.api.getFile(opts.fileId);
        if (!file.file_path) return `[Voice message - no file path]${caption}`;

        const groupDir = resolveGroupFolderPath(group.folder);
        const attachDir = path.join(groupDir, 'attachments');
        fs.mkdirSync(attachDir, { recursive: true });
        const tgExt = path.extname(file.file_path);
        const safeName = opts.filename.replace(/[^a-zA-Z0-9._-]/g, '_');
        const finalName = path.extname(safeName)
          ? safeName
          : `${safeName}${tgExt}`;
        const hostPath = path.join(attachDir, finalName);

        const url = `https://api.telegram.org/file/bot${this.botToken}/${file.file_path}`;
        const resp = await fetch(url);
        if (!resp.ok) return `[Voice message - download failed]${caption}`;
        fs.writeFileSync(hostPath, Buffer.from(await resp.arrayBuffer()));

        const transcript = await transcribeAudio(hostPath, opts.mimeType);
        const marker = transcript
          ? `[Voice: ${transcript}]`
          : '[Voice message - transcription unavailable]';
        return `${marker}${caption}`;
      } catch (err) {
        logger.warn({ err }, 'Failed to transcribe Telegram audio');
        return `[Voice message - error]${caption}`;
      }
    };

    this.bot.on('message:voice', (ctx) =>
      deliverMedia(ctx, (mc) =>
        transcriptContent(
          {
            fileId: ctx.message.voice?.file_id,
            filename: `voice_${ctx.message.message_id}`,
            mimeType: ctx.message.voice?.mime_type,
          },
          mc,
        ),
      ),
    );
    this.bot.on('message:audio', (ctx) =>
      deliverMedia(ctx, (mc) =>
        transcriptContent(
          {
            fileId: ctx.message.audio?.file_id,
            filename:
              ctx.message.audio?.file_name || `audio_${ctx.message.message_id}`,
            mimeType: ctx.message.audio?.mime_type,
          },
          mc,
        ),
      ),
    );
    this.bot.on('message:document', (ctx) => {
      const name = ctx.message.document?.file_name || 'file';
      return deliverMedia(ctx, (mc) =>
        placeholderContent(`[Document: ${name}]`, mc, {
          fileId: ctx.message.document?.file_id,
          filename: name,
        }),
      );
    });
    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      return deliverMedia(ctx, (mc) =>
        placeholderContent(`[Sticker ${emoji}]`, mc),
      );
    });
    this.bot.on('message:location', (ctx) =>
      deliverMedia(ctx, (mc) => placeholderContent('[Location]', mc)),
    );
    this.bot.on('message:contact', (ctx) =>
      deliverMedia(ctx, (mc) => placeholderContent('[Contact]', mc)),
    );

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(
    jid: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const options = threadId
        ? { message_thread_id: parseInt(threadId, 10) }
        : {};

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (text.length <= MAX_LENGTH) {
        await sendTelegramMessage(this.bot.api, numericId, text, options);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await sendTelegramMessage(
            this.bot.api,
            numericId,
            text.slice(i, i + MAX_LENGTH),
            options,
          );
        }
      }
      logger.info(
        { jid, length: text.length, threadId },
        'Telegram message sent',
      );
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendImage(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not connected');
      return;
    }
    const chatId = jid.replace(/^tg:/, '');
    const numericId = /^-?\d+$/.test(chatId) ? parseInt(chatId, 10) : chatId;
    try {
      await this.bot.api.sendPhoto(numericId, new InputFile(filePath), {
        caption: caption || undefined,
      });
      logger.info({ jid, filePath }, 'Telegram image sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram image');
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.bot || !isTyping) return;
    try {
      const numericId = jid.replace(/^tg:/, '');
      await this.bot.api.sendChatAction(numericId, 'typing');
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Telegram typing indicator');
    }
  }
}

registerChannel('telegram', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['TELEGRAM_BOT_TOKEN']);
  const token =
    process.env.TELEGRAM_BOT_TOKEN || envVars.TELEGRAM_BOT_TOKEN || '';
  if (!token) {
    logger.warn('Telegram: TELEGRAM_BOT_TOKEN not set');
    return null;
  }
  return new TelegramChannel(token, opts);
});
