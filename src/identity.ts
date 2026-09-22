/**
 * Server-resolved identity subcommand (Slice A — must-ship #87).
 *
 * Lives in its own module so `src/context.ts` doesn't accrete identity
 * concerns, and so the formatter pair (JSON + markdown) doesn't get tangled
 * with the formatter pair used by `work`, `sync`, `capabilities`, etc.
 *
 * Design decisions locked in the slice-A planning round:
 *   - requires `.oflow/config.json` (D3) — refuses to proceed without it,
 *     same as `getCurrentGitLabUser` does today.
 *   - email exposure is opt-in (`withEmail: true`) and only surfaces when
 *     GitLab's `public_email` boolean is `true`. The default JSON output
 *     never includes the `email` field's value.
 *   - source is derived from `getGitLabTokenSource` so env and stored
 *     tokens are recognized consistently with `oflow auth status`.
 *   - MCP runtime and glab sessions are not listed as identity sources;
 *     `oflow identity` is a server-self view of the user authenticated
 *     through whatever credential oflow holds. MCP and glab's view of
 *     "who am I" can differ; oflow does not adjudicate.
 */
import { OflowError } from "./errors.js";
import { GitLabClient } from "./gitlab.js";
import { getGitLabRemote } from "./git.js";
import { loadConfig } from "./config.js";
import { getGitLabTokenSource } from "./auth.js";

export interface OflowIdentity {
  host: string;
  /** Source the credential came from. `null` when oflow cannot tell. */
  source: "environment" | "stored" | "ci-job-token" | "mcp-runtime" | null;
  id: number;
  username: string;
  name: string | null;
  /**
   * Email is null unless `withEmail: true` AND GitLab's `public_email`
   * boolean is true. The field is always present in the typed response
   * so consumers don't have to special-case the property's existence.
   */
  email: string | null;
}

export interface ResolveIdentityOptions {
  /** Opt in to surfacing a public email. Default `false`. */
  withEmail?: boolean;
}

export async function resolveIdentity(
  root: string,
  options: ResolveIdentityOptions = {},
): Promise<OflowIdentity> {
  const config = await loadConfig(root);
  if (!config) {
    throw new OflowError(
      "No .oflow/config.json found. Run oflow install first.",
      "NOT_INSTALLED",
    );
  }
  const remote = await getGitLabRemote(root);
  const client = new GitLabClient(remote.host);
  const user = await client.getCurrentUser();
  const publicEmail = user.public_email === true;
  const rawEmail = typeof user.email === "string" ? user.email : null;
  return {
    host: remote.host,
    source: detectIdentitySource(),
    id: user.id,
    username: user.username,
    name: typeof user.name === "string" ? user.name : null,
    email: options.withEmail === true && publicEmail ? rawEmail : null,
  };
}

function detectIdentitySource(): OflowIdentity["source"] {
  const tokenSource = getGitLabTokenSource();
  if (tokenSource === null) return null;
  if (tokenSource.kind === "environment") return "environment";
  return "stored";
}

export function formatIdentityJson(identity: OflowIdentity): string {
  return JSON.stringify(identity, null, 2);
}

export function formatIdentityMarkdown(identity: OflowIdentity): string {
  const lines = [
    "# oflow identity",
    "",
    "Host: " + identity.host,
    "Source: " + (identity.source ?? "unknown"),
    "ID: " + identity.id,
    "Username: " + identity.username,
    "Name: " + (identity.name ?? "(none)"),
    "",
  ];
  if (identity.email !== null) {
    lines.push("Email: " + identity.email);
  } else {
    lines.push(
      "Email: <not surfaced; pass --with-email to opt in (only public emails exposed)>",
    );
  }
  return lines.join("\n");
}
