import { access } from "node:fs/promises";
import { join } from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { OflowError } from "./errors.js";
import { readText } from "./fs.js";
import type { AgentDetection, AgentMode, AgentName } from "./types.js";

const execFile = promisify(execFileCallback);

export async function commandAvailable(command: string): Promise<boolean> {
  const checker = process.platform === "win32" ? "where.exe" : "which";
  try {
    await execFile(checker, [command], { encoding: "utf8" });
    return true;
  } catch {
    return false;
  }
}

export function normalizeAgentMode(value: string | undefined): AgentMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "auto") {
    return undefined;
  }
  if (
    normalized === "claude" ||
    normalized === "codex" ||
    normalized === "omp" ||
    normalized === "both" ||
    normalized === "unknown"
  ) {
    return normalized;
  }
  throw new OflowError(
    "Unknown agent mode \"" + value + "\". Use auto, claude, codex, omp, or both.",
    "INVALID_AGENT_MODE",
  );
}

export async function detectAgents(
  root: string,
  requestedMode?: string,
): Promise<AgentDetection> {
  const explicit = normalizeAgentMode(requestedMode);
  const signals: Record<"claude" | "codex" | "omp", string[]> = {
    claude: [],
    codex: [],
    omp: [],
  };

  if (explicit) {
    if (explicit === "claude" || explicit === "both") {
      signals.claude.push("explicit --agent selection");
    }
    if (explicit === "codex" || explicit === "both") {
      signals.codex.push("explicit --agent selection");
    }
    if (explicit === "omp" || explicit === "both") {
      signals.omp.push("explicit --agent selection");
    }
    return {
      mode: explicit,
      claude: explicit === "claude" || explicit === "both",
      codex: explicit === "codex" || explicit === "both",
      omp: explicit === "omp" || explicit === "both",
      signals,
    };
  }

  const markerChecks: Array<[string, AgentName, string]> = [
    ["CLAUDE.md", "claude", "CLAUDE.md"],
    [".claude", "claude", ".claude directory"],
    ["AGENTS.md", "codex", "AGENTS.md"],
    [".codex", "codex", ".codex directory"],
    [".omp/AGENTS.md", "omp", ".omp/AGENTS.md"],
    [".omp/commands", "omp", ".omp/commands directory"],
    [".omp/skills", "omp", ".omp/skills directory"],
  ];
  for (const [relativePath, agent, signal] of markerChecks) {
    try {
      await access(join(root, relativePath));
      signals[agent].push(signal);
    } catch {
      // The marker is optional.
    }
  }

  const envSignals: Array<[string, AgentName, string]> = [
    ["CLAUDE_CODE", "claude", "CLAUDE_CODE environment"],
    ["CLAUDE_PROJECT_DIR", "claude", "CLAUDE_PROJECT_DIR environment"],
    ["CLAUDE_SESSION_ID", "claude", "CLAUDE_SESSION_ID environment"],
    ["CODEX_HOME", "codex", "CODEX_HOME environment"],
    ["CODEX_SESSION_ID", "codex", "CODEX_SESSION_ID environment"],
    ["CODEX_THREAD_ID", "codex", "CODEX_THREAD_ID environment"],
    ["OMP_PROFILE", "omp", "OMP_PROFILE environment"],
  ];
  for (const [name, agent, signal] of envSignals) {
    if (process.env[name]) {
      signals[agent].push(signal);
    }
  }

  const mcp = await readText(join(root, ".mcp.json"));
  if (mcp && /gitlab/i.test(mcp)) {
    signals.claude.push("GitLab MCP configuration");
    signals.codex.push("GitLab MCP configuration");
  }

  if (await commandAvailable("claude")) {
    signals.claude.push("claude command");
  }
  if (await commandAvailable("codex")) {
    signals.codex.push("codex command");
  }
  if (await commandAvailable("omp")) {
    signals.omp.push("omp command");
  }

  const claude = signals.claude.length > 0;
  const codex = signals.codex.length > 0;
  const omp = signals.omp.length > 0;
  const mode: AgentMode = claude && codex
    ? "both"
    : claude
      ? "claude"
      : codex
        ? "codex"
        : omp
          ? "omp"
          : "unknown";

  return { mode, claude, codex, omp, signals };
}
