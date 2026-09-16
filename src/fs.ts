import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { OflowError } from "./errors.js";
import type { FileAction } from "./types.js";

export async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readText(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, "utf8");
  } catch (error: unknown) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return null;
    }
    throw error;
  }
}

export async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, "utf8");
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  const content = await readText(filePath);
  if (content === null) {
    return null;
  }

  try {
    return JSON.parse(content) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new OflowError("Invalid JSON in " + filePath + ": " + message, "INVALID_JSON");
  }
}

export async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeText(filePath, JSON.stringify(value, null, 2) + "\n");
}

export async function upsertManagedBlock(
  filePath: string,
  marker: string,
  block: string,
  dryRun = false,
): Promise<FileAction> {
  const begin = "<!-- BEGIN " + marker + " -->";
  const end = "<!-- END " + marker + " -->";
  const managed = begin + "\n" + block.trim() + "\n" + end;
  const current = await readText(filePath);

  if (current === null) {
    if (!dryRun) {
      await writeText(filePath, managed + "\n");
    }
    return "created";
  }

  const pattern = new RegExp(
    escapeRegExp(begin) + "[\\s\\S]*?" + escapeRegExp(end),
    "m",
  );
  const next = pattern.test(current)
    ? current.replace(pattern, managed)
    : current.replace(/\s*$/, "") + "\n\n" + managed + "\n";

  if (next === current) {
    return "unchanged";
  }
  if (!dryRun) {
    await writeText(filePath, next);
  }
  return "updated";
}

export async function ensureLines(
  filePath: string,
  requiredLines: string[],
  dryRun = false,
): Promise<FileAction> {
  const current = (await readText(filePath)) ?? "";
  const lines = current.split(/\r?\n/);
  const missing = requiredLines.filter((line) => !lines.includes(line));
  if (missing.length === 0) {
    return "unchanged";
  }

  const trimmed = current.replace(/\s*$/, "");
  const next = trimmed + (trimmed ? "\n" : "") + missing.join("\n") + "\n";
  if (!dryRun) {
    await writeText(filePath, next);
  }
  return current ? "updated" : "created";
}

function escapeRegExp(value: string): string {
  const specials = [".", "*", "+", "?", "^", "$", "{", "}", "(", ")", "|", "[", "]", "\\"];
  return value
    .split("")
    .map((character) => (specials.includes(character) ? "\\" + character : character))
    .join("");
}
