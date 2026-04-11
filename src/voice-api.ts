/**
 * HTTP API for voice/text input from iOS Shortcuts and similar clients.
 *
 * POST /voice  — audio file upload → transcribe → inject as message
 * POST /message — text body → inject as message
 *
 * Auth: Bearer token (VOICE_API_TOKEN in .env)
 * Response goes via the user's normal channel (Signal, Telegram, etc.)
 */
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';
import { transcribeAudio } from './transcription.js';

const envVars = readEnvFile(['VOICE_API_TOKEN']);
const VOICE_API_TOKEN =
  process.env.VOICE_API_TOKEN || envVars.VOICE_API_TOKEN || '';

export interface VoiceApiDeps {
  onMessage: (chatJid: string, message: any) => void;
  defaultJid: string; // Default chat JID to inject messages into
  defaultSender: string; // Sender name for injected messages
}

export function startVoiceApi(port: number, deps: VoiceApiDeps): http.Server {
  if (!VOICE_API_TOKEN) {
    logger.warn(
      'VOICE_API_TOKEN not set — voice API disabled. Set it in .env to enable.',
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

    // Auth check
    if (!VOICE_API_TOKEN) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Voice API not configured' }));
      return;
    }

    const auth = req.headers.authorization;
    if (auth !== `Bearer ${VOICE_API_TOKEN}`) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const jid = url.searchParams.get('jid') || deps.defaultJid;
    const sender = url.searchParams.get('sender') || deps.defaultSender;

    try {
      if (req.method === 'POST' && url.pathname === '/voice') {
        await handleVoice(req, res, jid, sender, deps);
      } else if (req.method === 'POST' && url.pathname === '/message') {
        await handleMessage(req, res, jid, sender, deps);
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Not found' }));
      }
    } catch (err) {
      logger.error({ err }, 'Voice API error');
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Internal error' }));
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger.info({ port }, 'Voice API started');
  });

  return server;
}

async function handleVoice(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  jid: string,
  sender: string,
  deps: VoiceApiDeps,
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
  deps: VoiceApiDeps,
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
