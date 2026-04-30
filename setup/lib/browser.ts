/**
 * Browser-open helpers shared across channel setup flows.
 *
 * `openUrl` is best-effort — silent on failure, so headless/SSH/WSL
 * environments where `open`/`xdg-open` isn't wired up don't crash the
 * setup. The URL should always be visible in the clack note that calls
 * this so the user can copy-paste if the auto-open doesn't land.
 *
 * `confirmThenOpen` pauses for the operator before triggering the open —
 * the browser tends to steal focus when it pops, and a split-second
 * "wait what just happened" moment is worse than letting the user hit
 * Enter when they're ready. On headless devices (no graphical session
 * available) it skips both the prompt and the open: there's no browser
 * to launch, the surrounding `note(...)` already shows the URL for
 * copy-paste on another device, and the next prompt in the channel
 * flow ("Got your bot token?" etc.) provides the natural completion
 * confirmation.
 */
import { spawn } from 'child_process';

import * as p from '@clack/prompts';
import k from 'kleur';

import { isHeadless } from '../platform.js';
import { ensureAnswer } from './runner.js';

/** Best-effort open of a URL in the user's default browser. Silent on failure. */
export function openUrl(url: string): void {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    const child = spawn(cmd, [url], { stdio: 'ignore', detached: true });
    child.on('error', () => {
      // Headless / no browser / unknown command — URL is printed in the
      // calling note so the user can copy-paste.
    });
    child.unref();
  } catch {
    // swallow — URL is visible in the note.
  }
}

/**
 * Format a URL for display inside a setup `note(...)` card. On
 * GUI devices the URL renders dim — it's a fallback in case the
 * auto-open misses, and `confirmThenOpen` is doing the heavy
 * lifting of getting the user there. On headless devices the
 * URL becomes the user's only path forward, so we surface it
 * with a "Get started:" label and full-strength text — copy-
 * pasting onto another device is the actual action, not an
 * incidental reference.
 */
export function formatNoteLink(url: string): string {
  if (isHeadless()) return `Get started: ${url}`;
  return k.dim(url);
}

/**
 * Gate a browser-open on a confirm so the user is ready for their browser
 * to take focus. Proceeds on cancel as well — the user can always copy the
 * URL from the note that precedes the prompt. On headless devices both
 * the prompt and the open are skipped — there's no browser to time
 * focus for, and the URL is already visible in the surrounding note.
 */
export async function confirmThenOpen(
  url: string,
  message = 'Press Enter to open your browser',
): Promise<void> {
  if (isHeadless()) return;
  ensureAnswer(
    await p.confirm({
      message,
      initialValue: true,
    }),
  );
  openUrl(url);
}
