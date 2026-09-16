import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

export interface BackendStatus {
  rest: {
    available: true;
    role: "core";
  };
  glab: {
    available: boolean;
    version: string | null;
    role: "optional-fallback";
  };
  mcp: {
    available: false;
    role: "agent-runtime";
    note: string;
  };
}

export async function detectBackends(): Promise<BackendStatus> {
  let glab: BackendStatus["glab"] = {
    available: false,
    version: null,
    role: "optional-fallback",
  };

  try {
    const result = await execFile("glab", ["--version"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 64 * 1024,
    });
    glab = {
      available: true,
      version: parseGlabVersion(result.stdout + "\n" + result.stderr),
      role: "optional-fallback",
    };
  } catch {
    // glab is deliberately optional; REST remains usable without it.
  }

  return {
    rest: { available: true, role: "core" },
    glab,
    mcp: {
      available: false,
      role: "agent-runtime",
      note: "MCP availability belongs to the connected agent runtime, not the oflow CLI process.",
    },
  };
}

function parseGlabVersion(output: string): string | null {
  const match = output.match(/glab version\s+([^\s]+)/i);
  return match?.[1] ?? (output.trim().split(/\r?\n/, 1)[0] || null);
}
