/**
 * Presentation layer for text (non-JSON) CLI output.
 *
 * Color support is hand-rolled ANSI: zero dependencies, and every helper
 * degrades to plain text when color is disabled so `--json` output and
 * non-TTY consumers stay byte-identical.
 */

export interface PresentationOptions {
  color: boolean;
}

const GREEN = "\u001b[32m";
const RED = "\u001b[31m";
const YELLOW = "\u001b[33m";
const DIM = "\u001b[2m";
const RESET_COLOR = "\u001b[39m";
const RESET_DIM = "\u001b[22m";

/**
 * Resolve presentation for a writable stream. Color is enabled only when the
 * stream is a TTY and NO_COLOR is unset or empty.
 */
export function resolvePresentation(stream: { isTTY?: boolean }): PresentationOptions {
  const noColor = process.env.NO_COLOR;
  return { color: stream.isTTY === true && !(noColor !== undefined && noColor !== "") };
}

/**
 * Wrap a status marker (PASS/FAIL/SKIP/N/A/READY/NOT READY, upper or lower)
 * in the conventional color. Unknown statuses come back as plain text.
 */
export function statusMarker(status: string, presentation: PresentationOptions): string {
  if (!presentation.color) {
    return status;
  }
  const color = STATUS_COLORS[status];
  return color === undefined ? status : color + status + RESET_COLOR;
}

export function dim(text: string, presentation: PresentationOptions): string {
  return presentation.color ? DIM + text + RESET_DIM : text;
}

const STATUS_COLORS: Record<string, string> = {
  PASS: GREEN,
  passed: GREEN,
  READY: GREEN,
  FAIL: RED,
  failed: RED,
  "NOT READY": RED,
  SKIP: YELLOW,
  skipped: YELLOW,
  "N/A": YELLOW,
};
