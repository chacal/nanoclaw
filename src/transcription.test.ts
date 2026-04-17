import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Mocks ---

vi.mock('./env.js', () => ({
  readEnvFile: vi.fn(() => ({ OPENAI_API_KEY: 'test-key' })),
}));
vi.mock('./logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const mockExistsSync = vi.fn();
const mockReadFileSync = vi.fn();
vi.mock('fs', () => ({
  default: {
    existsSync: (...args: any[]) => mockExistsSync(...args),
    readFileSync: (...args: any[]) => mockReadFileSync(...args),
  },
}));

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { transcribeAudio, guessExtFromFile } from './transcription.js';

// --- Tests ---

describe('transcribeAudio', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    mockReadFileSync.mockReturnValue(Buffer.from('fake-audio'));
  });

  it('returns transcribed text on success', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'Hello world' }),
    });

    const result = await transcribeAudio('/tmp/test.m4a', 'audio/m4a');
    expect(result).toBe('Hello world');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.openai.com/v1/audio/transcriptions',
      expect.objectContaining({
        method: 'POST',
        headers: { Authorization: 'Bearer test-key' },
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('falls back to whisper-1 when the first fetch aborts (timeout)', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    mockFetch.mockRejectedValueOnce(abortErr).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ text: 'recovered' }),
    });

    const result = await transcribeAudio('/tmp/test.m4a');
    expect(result).toBe('recovered');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to whisper-1 when gpt-4o-transcribe fails', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        text: async () => 'model error',
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ text: 'Fallback result' }),
      });

    const result = await transcribeAudio('/tmp/test.m4a');
    expect(result).toBe('Fallback result');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null when file does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await transcribeAudio('/tmp/missing.m4a');
    expect(result).toBeNull();
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('returns null when both models fail', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'error 1',
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => 'error 2',
      });

    const result = await transcribeAudio('/tmp/test.m4a');
    expect(result).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns null when fetch throws and both models error', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'));

    const result = await transcribeAudio('/tmp/test.m4a');
    expect(result).toBeNull();
  });
});

describe('guessExtFromFile', () => {
  it('detects MP3 with ID3 header', () => {
    const buf = Buffer.alloc(12);
    buf.write('ID3', 0, 'ascii');
    expect(guessExtFromFile(buf)).toBe('mp3');
  });

  it('detects MP3 with sync bytes (0xFF 0xFB)', () => {
    const buf = Buffer.alloc(12);
    buf[0] = 0xff;
    buf[1] = 0xfb;
    expect(guessExtFromFile(buf)).toBe('mp3');
  });

  it('detects M4A with ftyp marker', () => {
    const buf = Buffer.alloc(12);
    buf.write('ftyp', 4, 'ascii');
    expect(guessExtFromFile(buf)).toBe('m4a');
  });

  it('detects OGG', () => {
    const buf = Buffer.alloc(12);
    buf.write('OggS', 0, 'ascii');
    expect(guessExtFromFile(buf)).toBe('ogg');
  });

  it('detects WAV', () => {
    const buf = Buffer.alloc(12);
    buf.write('RIFF', 0, 'ascii');
    expect(guessExtFromFile(buf)).toBe('wav');
  });

  it('detects FLAC', () => {
    const buf = Buffer.alloc(12);
    buf.write('fLaC', 0, 'ascii');
    expect(guessExtFromFile(buf)).toBe('flac');
  });

  it('returns null for unknown format', () => {
    const buf = Buffer.alloc(12);
    buf.fill(0x00);
    expect(guessExtFromFile(buf)).toBeNull();
  });

  it('returns null for buffer shorter than 12 bytes', () => {
    const buf = Buffer.alloc(4);
    expect(guessExtFromFile(buf)).toBeNull();
  });
});

describe('MIME type mapping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    // Return a buffer that won't match any magic bytes
    mockReadFileSync.mockReturnValue(Buffer.alloc(12));
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ text: 'test' }),
    });
  });

  it('uses mp3 extension for audio/mpeg', async () => {
    await transcribeAudio('/tmp/test', 'audio/mpeg');
    const body = mockFetch.mock.calls[0][1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.mp3');
  });

  it('uses m4a extension for audio/m4a', async () => {
    await transcribeAudio('/tmp/test', 'audio/m4a');
    const body = mockFetch.mock.calls[0][1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.m4a');
  });

  it('defaults to m4a for unknown content type', async () => {
    await transcribeAudio('/tmp/test', 'audio/unknown');
    const body = mockFetch.mock.calls[0][1].body as FormData;
    const file = body.get('file') as File;
    expect(file.name).toBe('audio.m4a');
  });
});
