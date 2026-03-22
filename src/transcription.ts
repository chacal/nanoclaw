/**
 * Voice message transcription using OpenAI API.
 * Tries gpt-4o-transcribe first, falls back to whisper-1.
 */
import fs from 'fs';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

const envVars = readEnvFile(['OPENAI_API_KEY']);
const OPENAI_API_KEY =
  process.env.OPENAI_API_KEY || envVars.OPENAI_API_KEY || '';

const MIME_TO_EXT: Record<string, string> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/aac': 'm4a',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/flac': 'flac',
};

const MODELS = ['gpt-4o-transcribe', 'whisper-1'];

export async function transcribeAudio(
  filePath: string,
  contentType?: string,
): Promise<string | null> {
  if (!OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set, skipping voice transcription');
    return null;
  }

  if (!fs.existsSync(filePath)) {
    logger.warn({ filePath }, 'Audio file not found');
    return null;
  }

  const fileBuffer = fs.readFileSync(filePath);
  const ext =
    MIME_TO_EXT[contentType || ''] || guessExtFromFile(fileBuffer) || 'm4a';

  for (const model of MODELS) {
    try {
      const blob = new Blob([fileBuffer]);
      const formData = new FormData();
      formData.append('file', blob, `audio.${ext}`);
      formData.append('model', model);

      const response = await fetch(
        'https://api.openai.com/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
          },
          body: formData,
        },
      );

      if (!response.ok) {
        const error = await response.text();
        logger.warn(
          { status: response.status, model, ext, error },
          'Transcription failed, trying next model',
        );
        continue;
      }

      const result = (await response.json()) as { text: string };
      logger.info(
        { chars: result.text.length, model, ext },
        'Transcribed voice message',
      );
      return result.text;
    } catch (err) {
      logger.warn({ err, model }, 'Transcription error, trying next model');
    }
  }

  logger.error(
    { filePath, ext, contentType },
    'All transcription models failed',
  );
  return null;
}

/** Guess file extension from magic bytes */
export function guessExtFromFile(buf: Buffer): string | null {
  if (buf.length < 12) return null;
  // MP3: starts with ID3 or 0xFF 0xFB
  if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return 'mp3';
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return 'mp3';
  // M4A/MP4: has 'ftyp' at offset 4
  if (buf.toString('ascii', 4, 8) === 'ftyp') return 'm4a';
  // OGG: starts with 'OggS'
  if (buf.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  // WAV: starts with 'RIFF'
  if (buf.toString('ascii', 0, 4) === 'RIFF') return 'wav';
  // FLAC: starts with 'fLaC'
  if (buf.toString('ascii', 0, 4) === 'fLaC') return 'flac';
  return null;
}
