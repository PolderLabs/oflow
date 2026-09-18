/**
 * Optional, secret-free GitLab MCP setup for OMP project-local config
 * (vNext architecture, PR 6).
 *
 * Writes only the hosted MCP URL — no token, no OAuth secret; OMP and GitLab
 * perform their own OAuth flow on first use. Merges safely with an existing
 * `.omp/mcp.json`: existing servers are preserved and a differently
 * configured `GitLab` entry is reported as a conflict, never overwritten.
 */

import { join } from "node:path";
import { readJson, writeJson } from "./fs.js";
import type { FileAction, GitLabRemote } from "./types.js";

export interface OmpMcpSetupResult {
  path: string;
  action: FileAction | "conflict";
  detail: string;
}

interface McpServerConfig {
  type?: string;
  url?: string;
  [key: string]: unknown;
}

interface OmpMcpConfig {
  $schema?: string;
  mcpServers?: Record<string, McpServerConfig>;
  [key: string]: unknown;
}

const MCP_SCHEMA =
  "https://raw.githubusercontent.com/can1357/oh-my-pi/main/packages/coding-agent/src/config/mcp-schema.json";

export async function setupOmpGitLabMcp(
  root: string,
  remote: GitLabRemote,
  dryRun: boolean,
): Promise<OmpMcpSetupResult> {
  const path = join(root, ".omp", "mcp.json");
  const existing = await readJson<OmpMcpConfig>(path);
  const url = "https://" + remote.host + "/api/v4/mcp";

  if (existing) {
    const gitlab = existing.mcpServers?.GitLab;
    if (gitlab && gitlab.url !== url) {
      return {
        path: ".omp/mcp.json",
        action: "conflict",
        detail:
          "existing GitLab MCP entry points at " +
          String(gitlab.url) +
          "; leaving it untouched",
      };
    }
    if (gitlab && gitlab.url === url) {
      return {
        path: ".omp/mcp.json",
        action: "unchanged",
        detail: "GitLab MCP already configured for " + remote.host,
      };
    }
    const merged: OmpMcpConfig = {
      ...existing,
      mcpServers: {
        ...existing.mcpServers,
        GitLab: { type: "http", url },
      },
    };
    if (!dryRun) {
      await writeJson(path, merged);
    }
    return {
      path: ".omp/mcp.json",
      action: "updated",
      detail: "added project-local GitLab MCP entry for " + remote.host,
    };
  }

  if (!dryRun) {
    await writeJson(path, {
      $schema: MCP_SCHEMA,
      mcpServers: {
        GitLab: { type: "http", url },
      },
    });
  }
  return {
    path: ".omp/mcp.json",
    action: "created",
    detail: "project-local GitLab MCP config for " + remote.host,
  };
}

/** Report whether `.omp/mcp.json` already routes to the resolved host. */
export async function ompGitLabMcpConfigured(
  root: string,
  remote: GitLabRemote,
): Promise<boolean> {
  const config = await readJson<OmpMcpConfig>(join(root, ".omp", "mcp.json"));
  return config?.mcpServers?.GitLab?.url === "https://" + remote.host + "/api/v4/mcp";
}
