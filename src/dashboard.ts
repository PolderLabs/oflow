import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { OflowError } from "./errors.js";
import { dropSecretFields, redactLocalPath } from "./dashboard-redaction.js";
import { dashboardViewHtml } from "./dashboard-view.js";
import { getCapabilities } from "./capabilities.js";
import { loadConfig } from "./config.js";
import { doctor } from "./doctor.js";
import { getGitLabTokenSource, listStoredGitLabHosts, credentialsPath } from "./auth.js";
import { getGitLabRemote } from "./git.js";
import { listPlans } from "./plan.js";
import { readAudit } from "./audit.js";
import { getLocalVerificationStatus } from "./local-verification.js";
import {
  readDashboardData,
  readReadModelStatus,
  requestReadModelRefresh,
} from "./read-model.js";
import type { DoctorReport } from "./types.js";

export interface DashboardOptions {
  port?: number;
}

export interface DashboardServer {
  url: string;
  close(): Promise<void>;
}

/** Mutating routes only; GET routes expose no side effect and no secret. */
const MUTATING_ROUTES = new Set(["/api/refresh", "/api/check-api", "/api/auth/request"]);

export async function startDashboard(
  root: string,
  options: DashboardOptions = {},
): Promise<DashboardServer> {
  const port = options.port ?? 4173;
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new OflowError("Dashboard port must be an integer between 0 and 65535.", "INVALID_DASHBOARD_PORT");
  }
  const server = createServer((request, response) => {
    void handleRequest(root, request, response, port);
  });
  await listen(server, port);
  const address = server.address();
  const actualPort = address && typeof address === "object" ? address.port : port;
  return {
    url: "http://127.0.0.1:" + String(actualPort) + "/",
    close: () => closeServer(server),
  };
}

async function handleRequest(
  root: string,
  request: IncomingMessage,
  response: ServerResponse,
  boundPort: number,
): Promise<void> {
  try {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Content-Security-Policy", "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'");
    // No CORS headers on purpose: a foreign page may not read any response.
    if (originAllowed(request, boundPort) === false) {
      writeJson(response, 403, { error: "Cross-origin request rejected." });
      return;
    }

    const method = request.method ?? "GET";
    if (MUTATING_ROUTES.has(url.pathname) && method !== "POST") {
      writeJson(response, 405, { error: "Method not allowed" });
      return;
    }

    if (method === "GET" && url.pathname === "/") {
      writeText(response, 200, dashboardViewHtml());
      return;
    }
    if (method === "GET" && url.pathname === "/api/status") {
      writeJson(response, 200, await readReadModelStatus(root));
      return;
    }
    if (method === "GET" && url.pathname === "/api/data") {
      writeJson(response, 200, await readDashboardData(root));
      return;
    }
    if (method === "POST" && url.pathname === "/api/refresh") {
      const accepted = await requestReadModelRefresh(root);
      writeJson(response, 202, {
        accepted,
        remoteRefreshRequired: accepted,
        command: accepted ? "oflow sync --refresh" : null,
        credentialsExposed: false,
        message: accepted
          ? "Refresh requested locally. Run the CLI command to contact GitLab; the dashboard never receives credentials."
          : "No local read model exists yet. Run oflow sync --refresh first.",
      });
      return;
    }
    if (method === "GET" && url.pathname === "/api/capabilities") {
      writeJson(response, 200, await getCapabilities({}));
      return;
    }
    if (method === "POST" && url.pathname === "/api/check-api") {
      writeJson(response, 200, await checkApiReport(root));
      return;
    }
    if (method === "GET" && url.pathname === "/api/auth/status") {
      writeJson(response, 200, await authStatus(root));
      return;
    }
    if (method === "POST" && url.pathname === "/api/auth/request") {
      writeJson(response, 200, await handleAuthRequest(root, request));
      return;
    }
    if (method === "GET" && url.pathname === "/api/plans") {
      writeJson(response, 200, { plans: await listPlans(root) });
      return;
    }
    if (method === "GET" && url.pathname === "/api/verification") {
      const config = await loadConfig(root);
      writeJson(
        response,
        200,
        await getLocalVerificationStatus(root, config?.workflow?.verification),
      );
      return;
    }
    if (method === "GET" && url.pathname === "/api/audit") {
      writeJson(response, 200, await readAudit(root, 50));
      return;
    }
    writeJson(response, 404, { error: "Not found" });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    // OflowError here means the request itself was wrong (bad body, rejected
    // option), which is a client fault; anything else is a server fault.
    if (error instanceof OflowError) {
      writeJson(response, 400, { error: message, code: error.code });
      return;
    }
    writeJson(response, 500, { error: message });
  }
}

/**
 * A loopback port is reachable by any page the user has open, so a foreign
 * origin must not be able to drive a mutating route. No `Origin` means a
 * non-browser client (the CLI or curl), which is allowed.
 */
function originAllowed(request: IncomingMessage, boundPort: number): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  return origin === "http://127.0.0.1:" + String(boundPort);
}

/**
 * `doctor` reports the machine-local repository root and a token *presence*
 * boolean. Both are reduced here so the browser never renders a specific
 * filesystem path and never receives token material.
 */
export function sanitizeDoctorReport(report: DoctorReport): Record<string, unknown> {
  const safe = dropSecretFields({ ...report, root: redactLocalPath(report.root) });
  return safe as Record<string, unknown>;
}

async function checkApiReport(root: string): Promise<Record<string, unknown>> {
  return sanitizeDoctorReport(await doctor(root, { checkApi: true }));
}

async function authStatus(root: string): Promise<Record<string, unknown>> {
  const host = await dashboardHost(root);
  return {
    host,
    activeSource: getGitLabTokenSource(host ?? undefined),
    storedForHost: host === null ? false : listStoredGitLabHosts().includes(host),
    storedHosts: listStoredGitLabHosts(),
    credentialsFile: redactLocalPath(credentialsPath()),
    tokenAcceptedInBrowser: false,
    loginCommand: "oflow auth login" + (host ? " --host " + host : ""),
  };
}

/**
 * The browser may request an auth action but may never name the host it
 * applies to: a loopback server must not be steerable by whichever page
 * happens to reach it. The host comes from the repository's Git remote.
 */
async function handleAuthRequest(root: string, request: IncomingMessage): Promise<Record<string, unknown>> {
  const body = await readJsonBody(request);
  const action = typeof body?.action === "string" ? body.action : "";
  if (action !== "login" && action !== "clear") {
    throw new OflowError(
      "Auth request requires action \"login\" or \"clear\"; the host is resolved from the repository remote.",
      "INVALID_AUTH_REQUEST",
    );
  }
  if (body !== null && typeof body === "object" && "host" in body) {
    throw new OflowError(
      "The dashboard does not accept a host from the browser; it is resolved from the repository remote.",
      "DASHBOARD_HOST_NOT_ACCEPTED",
    );
  }
  const host = await dashboardHost(root);
  return {
    action,
    host,
    applied: false,
    activeSource: getGitLabTokenSource(host ?? undefined),
    tokenReturned: false,
    message:
      "Token entry stays in your terminal. Run `oflow auth login` in the repository, then reload this view.",
    nextCommand: action === "login" ? "oflow auth login" : "oflow auth clear",
  };
}

async function dashboardHost(root: string): Promise<string | null> {
  try {
    const remote = await getGitLabRemote(root);
    return remote.host;
  } catch {
    return null;
  }
}

async function readJsonBody(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) {
      throw new OflowError("Dashboard request body is too large.", "DASHBOARD_BODY_TOO_LARGE");
    }
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return null;
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return null;
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new OflowError("Dashboard request body must be a JSON object.", "INVALID_DASHBOARD_BODY");
  }
  return parsed as Record<string, unknown>;
}

function writeJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value, null, 2) + "\n";
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(body);
}

function writeText(response: ServerResponse, status: number, value: string): void {
  response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  response.end(value);
}

function listen(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}
