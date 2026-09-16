import {
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { OflowError } from "./errors.js";

const ENVIRONMENT_TOKEN_NAMES = [
  "GITLAB_TOKEN",
  "GITLAB_ACCESS_TOKEN",
  "GITLAB_PRIVATE_TOKEN",
] as const;

const CREDENTIALS_FILE_NAME = "credentials.json";
const CREDENTIALS_LOCK_SUFFIX = ".lock";
const CREDENTIALS_LOCK_RETRIES = 200;
const CREDENTIALS_LOCK_DELAY_MS = 25;
const CREDENTIALS_LOCK_STALE_MS = 30_000;

let inProcessWriteQueue: Promise<void> = Promise.resolve();

export interface OflowCredentials {
  managedBy: "oflow";
  version: 1;
  gitlab: Record<string, string>;
}

export type GitLabTokenSource =
  | { kind: "environment"; variable: string }
  | { kind: "stored"; host: string; path: string }
  | null;

export function credentialsPath(): string {
  const configuredHome = process.env.OFLOW_CONFIG_HOME?.trim();
  const configHome = configuredHome ||
    (process.platform === "win32"
      ? process.env.APPDATA?.trim() || join(homedir(), "AppData", "Roaming")
      : process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config"));
  return join(configHome, "oflow", CREDENTIALS_FILE_NAME);
}

export function normalizeGitLabHost(value: string): string {
  const normalized = value
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/api\/v4\/?$/i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (
    !normalized ||
    normalized.startsWith("-") ||
    /[\u0000-\u0020\u007f"'`?#@]/.test(normalized) ||
    normalized.includes("/") ||
    normalized.includes("\\")
  ) {
    throw new OflowError(
      "Invalid GitLab host. Use a hostname such as gitlab.example.com.",
      "INVALID_GITLAB_HOST",
    );
  }
  return normalized;
}

export function getEnvironmentTokenName(): string | null {
  for (const name of ENVIRONMENT_TOKEN_NAMES) {
    const token = process.env[name]?.trim();
    if (token && isValidToken(token)) {
      return name;
    }
  }
  return null;
}

export function getGitLabToken(host?: string): string | null {
  const environmentName = getEnvironmentTokenName();
  if (environmentName) {
    const token = process.env[environmentName]?.trim() || null;
    return token && isValidToken(token) ? token : null;
  }

  if (!host) {
    return null;
  }
  const key = normalizeGitLabHost(host);
  const credentials = readCredentialsSync().gitlab;
  return hasOwn(credentials, key) && isValidToken(credentials[key])
    ? credentials[key]
    : null;
}

export function getGitLabTokenSource(host?: string): GitLabTokenSource {
  const environmentName = getEnvironmentTokenName();
  if (environmentName) {
    return { kind: "environment", variable: environmentName };
  }
  if (!host) {
    return null;
  }

  const normalizedHost = normalizeGitLabHost(host);
  const credentials = readCredentialsSync().gitlab;
  if (!hasOwn(credentials, normalizedHost) || !isValidToken(credentials[normalizedHost])) {
    return null;
  }
  return {
    kind: "stored",
    host: normalizedHost,
    path: credentialsPath(),
  };
}

export function listStoredGitLabHosts(): string[] {
  return Object.keys(readCredentialsSync().gitlab).sort();
}

export function redactGitLabToken(message: string, token: string): string {
  return token ? message.split(token).join("[REDACTED]") : message;
}

export async function saveGitLabToken(host: string, token: string): Promise<void> {
  const normalizedHost = normalizeGitLabHost(host);
  const normalizedToken = token.trim();
  if (!normalizedToken) {
    throw new OflowError("GitLab token cannot be empty.", "EMPTY_GITLAB_TOKEN");
  }
  if (!isValidToken(normalizedToken)) {
    throw new OflowError(
      "GitLab token contains invalid control characters.",
      "INVALID_GITLAB_TOKEN",
    );
  }

  await withCredentialsLock(async () => {
    const credentials = await readCredentials();
    credentials.gitlab[normalizedHost] = normalizedToken;
    await writeCredentials(credentials);
  });
}

export async function clearGitLabToken(host: string): Promise<boolean> {
  const normalizedHost = normalizeGitLabHost(host);
  return withCredentialsLock(async () => {
    const credentials = await readCredentials();
    if (!hasOwn(credentials.gitlab, normalizedHost)) {
      return false;
    }

    delete credentials.gitlab[normalizedHost];
    if (Object.keys(credentials.gitlab).length === 0) {
      try {
        await unlink(credentialsPath());
      } catch (error: unknown) {
        if (!isFileNotFound(error)) {
          throw error;
        }
      }
    } else {
      await writeCredentials(credentials);
    }
    return true;
  });
}

export async function readTokenFromStdin(): Promise<string> {
  let value = "";
  for await (const chunk of process.stdin) {
    value += String(chunk);
  }
  const token = value.trim();
  if (!token) {
    throw new OflowError(
      "No GitLab token was provided on stdin.",
      "EMPTY_GITLAB_TOKEN",
    );
  }
  return token;
}

export async function promptForGitLabToken(): Promise<string> {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new OflowError(
      "Interactive token input requires a terminal. Use oflow auth set --token-stdin for scripts or CI.",
      "NON_INTERACTIVE_AUTH",
    );
  }

  return new Promise((resolve, reject) => {
    let value = "";
    const stdin = process.stdin;
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    const onData = (chunk: Buffer | string) => {
      for (const character of String(chunk)) {
        if (character === "\u0003") {
          cleanup();
          process.stderr.write("\n");
          reject(new OflowError("Token input cancelled.", "AUTH_CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          process.stderr.write("\n");
          const token = value.trim();
          if (!token) {
            reject(new OflowError("GitLab token cannot be empty.", "EMPTY_GITLAB_TOKEN"));
          } else {
            resolve(token);
          }
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else {
          value += character;
        }
      }
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("data", onData);
    process.stderr.write("GitLab token (input hidden): ");
  });
}

async function readCredentials(): Promise<OflowCredentials> {
  try {
    const content = await readFile(credentialsPath(), "utf8");
    return parseCredentials(content);
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return emptyCredentials();
    }
    throw error;
  }
}

function readCredentialsSync(): OflowCredentials {
  try {
    return parseCredentials(readFileSync(credentialsPath(), "utf8"));
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return emptyCredentials();
    }
    if (error instanceof OflowError) {
      throw error;
    }
    throw new OflowError(
      "Could not read oflow credentials file: " + credentialsPath() + ".",
      "CREDENTIALS_READ_ERROR",
    );
  }
}

function parseCredentials(content: string): OflowCredentials {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new OflowError(
      "Invalid JSON in " + credentialsPath() + ".",
      "INVALID_CREDENTIALS",
    );
  }
  if (
    !isPlainRecord(value) ||
    value.managedBy !== "oflow" ||
    value.version !== 1 ||
    !isPlainRecord(value.gitlab)
  ) {
    throw new OflowError(
      "Invalid oflow credentials file: " + credentialsPath(),
      "INVALID_CREDENTIALS",
    );
  }

  const gitlab: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [host, token] of Object.entries(value.gitlab)) {
    if (typeof token === "string" && token.trim()) {
      const normalizedToken = token.trim();
      if (!isValidToken(normalizedToken)) {
        throw new OflowError(
          "Invalid token in oflow credentials file: " + credentialsPath() + ".",
          "INVALID_CREDENTIALS",
        );
      }
      gitlab[normalizeGitLabHost(host)] = normalizedToken;
    }
  }
  return { managedBy: "oflow", version: 1, gitlab };
}

function emptyCredentials(): OflowCredentials {
  return {
    managedBy: "oflow",
    version: 1,
    gitlab: Object.create(null) as Record<string, string>,
  };
}

async function writeCredentials(credentials: OflowCredentials): Promise<void> {
  const path = credentialsPath();
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await chmod(dirname(path), 0o700);
  const temporaryPath = path + ".tmp-" + process.pid + "-" + randomUUID();
  try {
    await writeFile(temporaryPath, JSON.stringify(credentials, null, 2) + "\n", {
      encoding: "utf8",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, path);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
  }
}

async function withCredentialsLock<T>(operation: () => Promise<T>): Promise<T> {
  const queued = inProcessWriteQueue.then(
    () => runWithCredentialsLock(operation),
    () => runWithCredentialsLock(operation),
  );
  inProcessWriteQueue = queued.then(
    () => undefined,
    () => undefined,
  );
  return queued;
}

async function runWithCredentialsLock<T>(operation: () => Promise<T>): Promise<T> {
  const lockPath = credentialsPath() + CREDENTIALS_LOCK_SUFFIX;
  await mkdir(dirname(credentialsPath()), { recursive: true, mode: 0o700 });
  let acquired = false;
  for (let attempt = 0; attempt < CREDENTIALS_LOCK_RETRIES; attempt += 1) {
    try {
      const lock = await open(lockPath, "wx", 0o600);
      await lock.close();
      acquired = true;
      break;
    } catch (error: unknown) {
      if (!isAlreadyExists(error)) {
        throw error;
      }
      if (await isStaleLock(lockPath)) {
        try {
          await unlink(lockPath);
        } catch (removeError: unknown) {
          if (!isFileNotFound(removeError)) {
            throw removeError;
          }
        }
        continue;
      }
      await delay(CREDENTIALS_LOCK_DELAY_MS);
    }
  }
  if (!acquired) {
    throw new OflowError(
      "The oflow credentials file is busy; try again.",
      "CREDENTIALS_BUSY",
    );
  }

  try {
    return await operation();
  } finally {
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isValidToken(token: string): boolean {
  return !/[\u0000-\u001f\u007f]/.test(token);
}

function isAlreadyExists(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "EEXIST",
  );
}

async function isStaleLock(lockPath: string): Promise<boolean> {
  try {
    const details = await stat(lockPath);
    return Date.now() - details.mtimeMs > CREDENTIALS_LOCK_STALE_MS;
  } catch (error: unknown) {
    return false;
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT",
  );
}
