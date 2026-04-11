/**
 * HTTP API for external input — voice, text, and webhook events.
 *
 * POST /voice   — audio file upload → transcribe → inject as message
 * POST /message — text body → inject as message
 * POST /webhook — JSON event from external systems (e.g. Home Assistant)
 *
 * Auth: Bearer token (VOICE_API_TOKEN for /voice and /message, WEBHOOK_TOKEN for /webhook)
 * Response goes via the user's normal channel (Signal, Telegram, etc.)
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { transcribeAudio } from './transcription.js';

const envVars = readEnvFile(['VOICE_API_TOKEN', 'WEBHOOK_TOKEN']);
const VOICE_API_TOKEN =
  process.env.VOICE_API_TOKEN || envVars.VOICE_API_TOKEN || '';
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || envVars.WEBHOOK_TOKEN || '';

export interface HttpApiDeps {
  onMessage: (chatJid: string, message: any) => void;
  defaultJid: string; // Default chat JID to inject messages into
  defaultSender: string; // Sender name for injected messages
}

export function startHttpApi(port: number, deps: HttpApiDeps): http.Server {
  if (!VOICE_API_TOKEN) {
    logger.warn(
      'VOICE_API_TOKEN not set — voice/message endpoints disabled. Set it in .env to enable.',
    );
  }
  if (!WEBHOOK_TOKEN) {
    logger.warn(
      'WEBHOOK_TOKEN not set — webhook endpoint disabled. Set it in .env to enable.',
    );
  }

  const server = http.createServer(async (req, res) => {
    // CORS for potential web clients
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Authorization, Content-Type',
    );
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const isWebhook = req.method === 'POST' && url.pathname === '/webhook';

    // Route-specific auth
    const auth = req.headers.authorization;
    if (isWebhook) {
      if (!WEBHOOK_TOKEN) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Webhook not configured' }));
        return;
      }
      if (auth !== `Bearer ${WEBHOOK_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    } else {
      if (!VOICE_API_TOKEN) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Voice API not configured' }));
        return;
      }
      if (auth !== `Bearer ${VOICE_API_TOKEN}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const jid = url.searchParams.get('jid') || deps.defaultJid;
    const sender = url.searchParams.get('sender') || deps.defaultSender;

    try {
      if (req.method === 'POST' && url.pathname === '/voice') {
        await handleVoice(req, res, jid, sender, deps);
      } else if (req.method === 'POST' && url.pathname === '/message') {
        await handleMessage(req, res, jid, sender, deps);
      } else if (isWebhook) {
        await handleWebhook(req, res, jid, deps);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'HTTP API error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'HTTP API started');
  });

  return server;
}

/**
 * Format a webhook event payload into a readable text block for the agent.
 */
export function formatWebhookEvent(data: Record<string, unknown>): string {
  const lines = ['[Webhook Event]'];
  for (const [key, value] of Object.entries(data)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

async function handleVoice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  sender: string,
  deps: HttpApiDeps,
): Promise<void> {
  // Read the raw body
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const body = Buffer.concat(chunks);

  const MAX_BODY_SIZE = 25 * 1024 * 1024; // 25MB — OpenAI's limit
  if (body.length === 0) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty audio' }));
    return;
  }
  if (body.length > MAX_BODY_SIZE) {
    res.writeHead(413, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Audio too large (max 25MB)' }));
    return;
  }

  // Write to temp file for transcription (transcribeAudio handles format detection)
  const contentType = req.headers['content-type'] || 'audio/m4a';
  const tmpFile = path.join(os.tmpdir(), `nanoclaw-voice-${Date.now()}.audio`);
  fs.writeFileSync(tmpFile, body);

  try {
    const transcript = await transcribeAudio(tmpFile, contentType);

    if (!transcript) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Transcription failed' }));
      return;
    }

    // Inject as message
    const timestamp = new Date().toISOString();
    deps.onMessage(jid, {
      id: `voice-${Date.now()}`,
      chat_jid: jid,
      sender: 'voice-api',
      sender_name: sender,
      content: `[Voice: ${transcript}]`,
      timestamp,
      is_trusted: true,
    });

    logger.info(
      { jid, sender, chars: transcript.length },
      'Voice API: message injected',
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, transcript }));
  } finally {
    fs.unlinkSync(tmpFile);
  }
}

async function handleMessage(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  sender: string,
  deps: HttpApiDeps,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf-8').trim();

  if (!text) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty message' }));
    return;
  }

  const timestamp = new Date().toISOString();
  deps.onMessage(jid, {
    id: `api-${Date.now()}`,
    chat_jid: jid,
    sender: 'voice-api',
    sender_name: sender,
    content: text,
    timestamp,
    is_trusted: true,
  });

  logger.info(
    { jid, sender, chars: text.length },
    'Voice API: text message injected',
  );

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}

async function handleWebhook(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  deps: HttpApiDeps,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();

  if (!raw) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Empty body' }));
    return;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw);
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON' }));
    return;
  }

  const content = formatWebhookEvent(data);
  const timestamp = new Date().toISOString();

  deps.onMessage(jid, {
    id: `webhook-${Date.now()}`,
    chat_jid: jid,
    sender: 'webhook',
    sender_name: 'Webhook',
    content,
    timestamp,
    is_trusted: true,
  });

  logger.info(
    { jid, event: data.event || 'unknown' },
    'Webhook event injected',
  );

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true }));
}
