import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { OflowError } from "./errors.js";

const execFile = promisify(execFileCallback);

export interface GlabApiGetOptions {
  root: string;
  host: string;
  endpoint: string;
}

/**
 * Read-only escape hatch for GitLab endpoints not yet wrapped by the typed REST adapter.
 * glab owns its own credentials; oflow never passes a token to the subprocess.
 */
export async function glabApiGet(options: GlabApiGetOptions): Promise<unknown> {
  const endpoint = normalizeEndpoint(options.endpoint);
  const binary = process.env.OFLOW_GLAB_BIN?.trim() || "glab";
  let result: { stdout: string; stderr: string };
  try {
    result = await execFile(
      binary,
      [
        "api",
        "--hostname",
        options.host,
        "--method",
        "GET",
        endpoint,
        "--output",
        "json",
      ],
      {
        cwd: options.root,
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 4 * 1024 * 1024,
      },
    );
  } catch (error: unknown) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new OflowError(
      "glab read failed: " + redact(detail),
      "GLAB_API_ERROR",
    );
  }

  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new OflowError(
      "glab returned a non-JSON response for " + endpoint + ".",
      "INVALID_GLAB_RESPONSE",
    );
  }
}

function normalizeEndpoint(value: string): string {
  const endpoint = value.trim().replace(/^\/+/, "");
  if (
    !endpoint ||
    endpoint.startsWith("-") ||
    endpoint.includes("://") ||
    endpoint.split("/").some((part) => part === "..") ||
    /[\r\n\0]/.test(endpoint)
  ) {
    throw new OflowError(
      "glab endpoints must be relative GitLab API paths and read-only.",
      "UNSAFE_GLAB_ENDPOINT",
    );
  }
  return endpoint;
}

function redact(value: string): string {
  return value
    .replace(/glpat-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/(PRIVATE-TOKEN|Authorization):?\s*[^\s]+/gi, "$1: [REDACTED]");
}
