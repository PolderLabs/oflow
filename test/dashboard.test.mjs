import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homedir } from "node:os";

import { startDashboard, sanitizeDoctorReport } from "../dist/dashboard.js";
import { redactLocalPath, dropSecretFields } from "../dist/dashboard-redaction.js";

const postJson = (url, body) =>
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

test("redactLocalPath collapses home to ~ and otherwise keeps only a basename", () => {
  const home = homedir();
  assert.equal(redactLocalPath(home + "/.config/oflow/credentials.json"), "~/.config/oflow/credentials.json");
  assert.equal(redactLocalPath(home + "\\.config\\oflow\\credentials.json"), "~/.config/oflow/credentials.json");
  assert.equal(redactLocalPath(home), "~");
  assert.equal(redactLocalPath("/var/tmp/build/notes.json"), "notes.json");
  assert.equal(redactLocalPath("C:\\Users\\someone\\creds.json"), "creds.json");
  assert.equal(redactLocalPath("relative/file.json"), "file.json");
  assert.equal(redactLocalPath(null), null);
  assert.equal(redactLocalPath(undefined), null);
  assert.equal(redactLocalPath("   "), null);
});

test("a redacted path never contains the machine's home directory", () => {
  const home = homedir();
  if (!home) return;
  const redacted = redactLocalPath(join(home, ".config", "oflow", "credentials.json"));
  assert.ok(redacted);
  assert.equal(redacted.includes(home), false);
});

test("dropSecretFields removes secret values but keeps token state signals", () => {
  const dropped = dropSecretFields({
    tokenConfigured: true,
    tokenSource: "stored",
    token: "secret-value",
    password: "hunter2",
    nested: { authorization: "Bearer x", keep: 1 },
    list: [{ credentials: "c", keep: 2 }],
  });
  assert.deepEqual(dropped, {
    tokenConfigured: true,
    tokenSource: "stored",
    nested: { keep: 1 },
    list: [{ keep: 2 }],
  });
});

test("doctor reports are sanitized before they leave the process", () => {
  const safe = sanitizeDoctorReport({
    root: homedir() + "/projects/example",
    tokenConfigured: true,
    tokenSource: "env",
    token: "never-emit-me",
    warnings: [],
  });
  assert.equal(safe.root.includes(homedir()), false);
  assert.equal("token" in safe, false);
  assert.equal(safe.tokenConfigured, true);
});

test("auth status reports the credentials file without leaking a home path", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-auth-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const response = await fetch(new URL("api/auth/status", dashboard.url));
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.tokenAcceptedInBrowser, false);
    assert.ok(status.loginCommand.startsWith("oflow auth login"));
    if (status.credentialsFile) {
      assert.equal(status.credentialsFile.includes(homedir()), false);
    }
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("auth request is action-only and never returns token material", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-action-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const response = await postJson(new URL("api/auth/request", dashboard.url), { action: "login" });
    assert.equal(response.status, 200);
    const body = await response.text();
    const result = JSON.parse(body);
    assert.equal(result.applied, false);
    assert.equal(result.tokenReturned, false);
    assert.equal("token" in result, false);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("auth request refuses a browser-supplied host", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-host-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const response = await postJson(new URL("api/auth/request", dashboard.url), {
      action: "login",
      host: "attacker.test",
    });
    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.code, "DASHBOARD_HOST_NOT_ACCEPTED");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("auth request rejects an unknown action", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-badaction-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const response = await postJson(new URL("api/auth/request", dashboard.url), { action: "exfiltrate" });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.code, "INVALID_AUTH_REQUEST");
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("capabilities are served from the declarative catalog with no network access", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-caps-"));
  const dashboard = await startDashboard(root, { port: 0 });
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (...args) => {
    calls += 1;
    return realFetch(...args);
  };
  try {
    const response = await realFetch(new URL("api/capabilities", dashboard.url));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.ok(Array.isArray(body.capabilities));
    assert.ok(body.capabilities.length > 0);
    assert.equal(calls, 0, "capabilities must not trigger any outbound request");
  } finally {
    globalThis.fetch = realFetch;
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("mutating routes reject a foreign origin and a wrong method", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-origin-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const crossOrigin = await fetch(new URL("api/check-api", dashboard.url), {
      method: "POST",
      headers: { Origin: "https://foreign-origin.test" },
    });
    assert.equal(crossOrigin.status, 403);

    // A mutating route must never run on GET: a link or prefetch would fire it.
    const getOnMutating = await fetch(new URL("api/refresh", dashboard.url));
    assert.equal(getOnMutating.status, 405);

    const wrongMethod = await fetch(new URL("api/data", dashboard.url), { method: "PUT" });
    assert.equal(wrongMethod.status, 404);

    const missing = await fetch(new URL("api/nope", dashboard.url));
    assert.equal(missing.status, 404);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the served page sets no-store and a self-only content security policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-headers-"));
  const dashboard = await startDashboard(root, { port: 0 });
  try {
    const response = await fetch(dashboard.url);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'self'/);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
  } finally {
    await dashboard.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("--open and --port are only accepted by the dashboard command", async () => {
  const { main } = await import("../dist/cli.js");
  const root = await mkdtemp(join(tmpdir(), "oflow-dash-openflag-"));
  const errors = [];
  const realWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { errors.push(String(chunk)); return true; };
  try {
    const withOpen = await main(["start", "--open", "--root", root]);
    const withPort = await main(["start", "--port", "4173", "--root", root]);
    assert.notEqual(withOpen, 0, "--open must be rejected outside dashboard");
    assert.notEqual(withPort, 0, "--port must be rejected outside dashboard");
    const output = errors.join("\n");
    assert.match(output, /--open is only supported with dashboard/);
    assert.match(output, /--port is only supported with dashboard/);
  } finally {
    process.stderr.write = realWrite;
    await rm(root, { recursive: true, force: true });
  }
});
