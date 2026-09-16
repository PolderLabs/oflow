import { rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { readJson, writeJson } from "./fs.js";

export const SYNC_CACHE_VERSION = 1;
export const SYNC_CACHE_RELATIVE_PATH = ".oflow/cache/sync.json";

export interface SyncCacheEnvelope<T> {
  version: typeof SYNC_CACHE_VERSION;
  savedAt: string;
  host: string;
  projectPath: string;
  query: T;
  result: unknown;
}

export function syncCachePath(root: string): string {
  return join(root, SYNC_CACHE_RELATIVE_PATH);
}

export async function readSyncCache<T>(root: string): Promise<SyncCacheEnvelope<T> | null> {
  return readJson<SyncCacheEnvelope<T>>(syncCachePath(root));
}

export async function writeSyncCache<T>(
  root: string,
  envelope: SyncCacheEnvelope<T>,
): Promise<void> {
  const target = syncCachePath(root);
  const temporary = target + "." + String(process.pid) + ".tmp";
  await writeJson(temporary, envelope);
  try {
    await rename(temporary, target);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
}
