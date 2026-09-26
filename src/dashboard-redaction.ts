import { homedir } from "node:os";

/**
 * Display-safe form of a local filesystem path.
 *
 * Anything that crosses the dashboard's HTTP boundary passes through here so a
 * browser never renders a machine-specific home directory. Behavior is
 * platform-independent: separators are normalized so a path produced on one OS
 * reads correctly on another, and the public-content scan rejects absolute user
 * paths in tracked files.
 */
export function redactLocalPath(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = normalizeSeparators(trimmed);
  for (const prefix of homePrefixes()) {
    if (normalized === prefix) return "~";
    if (normalized.startsWith(prefix + "/")) {
      return "~" + normalized.slice(prefix.length);
    }
  }

  const segments = trimmed.split(/[/\\]+/).filter(Boolean);
  return segments.length > 0 ? segments[segments.length - 1] : null;
}

/**
 * The real home directory, plus a Windows profile prefix so a path shaped like
 * `C:/Users/<name>/...` is recognised as a home path even when the report was
 * produced on a different OS. The comparison is anchored at the start of the
 * whole normalized path, so this cannot match a bare basename.
 */
function homePrefixes(): string[] {
  const prefixes: string[] = [];
  const home = normalizeSeparators(homedir());
  if (home) prefixes.push(home);
  const windowsProfile = /^[A-Z]:\/Users\/[^/]+/i.exec(home);
  if (windowsProfile) prefixes.push(windowsProfile[0]);
  return prefixes;
}

/**
 * Drops fields whose name suggests secret material while keeping the
 * boolean/enum health signals callers need. `tokenConfigured` and
 * `tokenSource` survive: they describe state, never a value.
 */
export function dropSecretFields<T>(value: T): T {
  return dropSecrets(value, 0) as T;
}

function dropSecrets(value: unknown, depth: number): unknown {
  if (depth > 8) return null;
  if (Array.isArray(value)) return value.map((entry) => dropSecrets(entry, depth + 1));
  if (value === null || typeof value !== "object") return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isSecretKey(key)) continue;
    output[key] = dropSecrets(entry, depth + 1);
  }
  return output;
}

/**
 * Drops fields whose name suggests secret material while keeping the
 * boolean/enum health signals callers need. `tokenConfigured` and
 * `tokenSource` survive: they describe state, never a value.
 *
 * The key is split on case boundaries and separators, so `accessToken` and
 * `client_secret` are both recognised. The previous exact-match regex caught
 * only a bare `token`, so every prefixed or suffixed variant -- the shapes
 * real APIs actually use -- crossed the boundary intact.
 */
function isSecretKey(key: string): boolean {
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  if (SAFE_STATE_KEY.test(words.join(""))) return false;
  return words.some((word) => SECRET_WORDS[word] === true);
}

/** Health signals the dashboard renders, which describe state, not a value. */
const SAFE_STATE_KEY =
  /^(?:[a-z]*token(?:configured|source|scopes|acceptedinbrowser|present|valid|status|state|returned|probe|scopesunsupported)|gitlab(?:token)?source|has(?:token|auth)|auth(?:configured|source|status)|normalize[d]?token|redact[a-z]*token|isvalidtoken)$/;

const SECRET_WORDS: Record<string, true> = {
  token: true, secret: true, password: true, passwd: true, passphrase: true,
  credential: true, credentials: true, privatekey: true, apikey: true,
  authorization: true, auth: true, bearer: true, pat: true, key: true,
  pem: true, certificate: true,
};

function normalizeSeparators(value: string): string {
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}
