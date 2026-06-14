import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TTS_MARKER_RE = /\[robot:tts\]/gi;
const TTS_MARKER_TEST_RE = /\[robot:tts\]/i;

export const TTS_DIRNAME = 'tts';

export function extractRobotTtsMarker(text: string): { cleanedText: string; requested: boolean } {
  const requested = TTS_MARKER_TEST_RE.test(text);
  const cleanedText = stripRobotTtsMarkers(text);
  return { cleanedText, requested };
}

export function stripRobotTtsMarkers(text: string): string {
  return (text ?? '').replace(TTS_MARKER_RE, '').replace(/[ \t]+\n/g, '\n').trim();
}

export function detectTtsLang(text: string): 'en' | 'zh' {
  if (/[^\x00-\x7F]/.test(text)) {
    if (/[\u4E00-\u9FFF]/.test(text)) return 'zh';
  }
  return 'en';
}

export function buildTtsStoragePath(uploadsDir: string, storageId: string): string {
  return join(uploadsDir, TTS_DIRNAME, `${storageId}.mp3`);
}

export function isTtsStoragePath(uploadsDir: string, storagePath: string): boolean {
  return storagePath.startsWith(join(uploadsDir, TTS_DIRNAME));
}

export async function generateTtsMp3(opts: {
  scriptPath: string;
  text: string;
  outPath: string;
  maxChars?: number;
}): Promise<{ ok: boolean; error?: string }>
{
  const text = (opts.text ?? '').trim();
  if (!text) {
    return { ok: false, error: 'TTS text is empty' };
  }

  const maxChars = Math.max(200, opts.maxChars ?? 2500);
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}\n…` : text;
  const lang = detectTtsLang(clipped);

  try {
    mkdirSync(dirname(opts.outPath), { recursive: true });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Failed to create TTS output directory' };
  }

  const child = spawn(opts.scriptPath, [lang, opts.outPath], {
    stdio: ['pipe', 'ignore', 'pipe'],
    env: process.env
  });

  const stderr: Buffer[] = [];
  child.stderr?.on('data', (chunk) => stderr.push(Buffer.from(chunk)));

  const timeoutMs = 120_000;
  const killTimer = setTimeout(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      // ignore
    }
  }, timeoutMs);

  try {
    child.stdin?.write(clipped);
    child.stdin?.end();
  } catch {
    // ignore
  }

  const code: number | null = await new Promise((resolve) => {
    child.on('close', (c) => resolve(c));
    child.on('error', () => resolve(1));
  });

  clearTimeout(killTimer);

  if (code !== 0) {
    const errText = Buffer.concat(stderr).toString('utf-8').trim().slice(0, 400);
    return { ok: false, error: errText || 'TTS generation failed' };
  }

  return { ok: true };
}
