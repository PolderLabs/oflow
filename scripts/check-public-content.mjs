#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function trackedFiles() {
  try {
    return execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
    )
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
  } catch {
    console.log("Public-content scan skipped outside a Git working tree.");
    return null;
  }
}

const safeHosts = new Set([
  "127.0.0.1",
  "docs.gitlab.com",
  "example.com",
  "example.net",
  "example.org",
  "github.com",
  "gitlab.com",
  "gitlab.example.com",
  "img.shields.io",
  "localhost",
  "raw.githubusercontent.com",
  "registry.npmjs.org",
]);

function isSafeHost(host) {
  const normalized = host.toLowerCase().replace(/\.$/, "");
  return (
    safeHosts.has(normalized) ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".localhost")
  );
}

const files = trackedFiles();
if (files === null) process.exit(0);

const violations = [];

function addViolation(file, line, rule) {
  violations.push(`${file}:${line}: ${rule}`);
}

function lineNumber(text, offset) {
  return text.slice(0, offset).split("\n").length;
}

function scanPattern(file, text, pattern, rule, accept = () => false) {
  for (const match of text.matchAll(pattern)) {
    if (!accept(match)) {
      addViolation(file, lineNumber(text, match.index ?? 0), rule);
    }
  }
}

for (const file of files) {
  const absolutePath = join(root, file);
  let buffer;
  try {
    buffer = readFileSync(absolutePath);
  } catch {
    continue;
  }

  // Binary assets are reviewed separately; scanning their decoded bytes creates
  // false positives and never improves detection of textual disclosures.
  if (buffer.includes(0)) continue;
  const text = buffer.toString("utf8");

  scanPattern(
    file,
    text,
    /\b(?:gl(?:pat|rt|dt|so)-[A-Za-z0-9_-]{12,}|gh[pors]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    "credential-like token",
  );
  scanPattern(
    file,
    text,
    /-----BEGIN (?:RSA|OPENSSH|EC|DSA|PGP) PRIVATE KEY-----/g,
    "private key material",
  );
  scanPattern(
    file,
    text,
    /\bhttps?:\/\/[^/\s@]+:[^/\s@]{20,}@/gi,
    "credential embedded in URL",
  );
  scanPattern(
    file,
    text,
    /(?:^|[\s"'(])\/(?:home|Users)\/[^\s"'`]+/g,
    "absolute user path",
  );
  scanPattern(
    file,
    text,
    /\b[A-Za-z]:\\Users\\[^\s"'`]+/g,
    "absolute user path",
  );
  scanPattern(
    file,
    text,
    /\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b/gi,
    "non-placeholder email address",
    (match) => isSafeHost(match[1]),
  );

  const urlPattern = /\bhttps?:\/\/(?:[^/@\s]+@)?([A-Z0-9.-]+)(?::\d+)?/gi;
  for (const match of text.matchAll(urlPattern)) {
    if (!isSafeHost(match[1])) {
      addViolation(file, lineNumber(text, match.index ?? 0), "unapproved external host");
    }
  }

  const sshPattern = /\bgit@([A-Z0-9.-]+):/gi;
  for (const match of text.matchAll(sshPattern)) {
    if (!isSafeHost(match[1])) {
      addViolation(file, lineNumber(text, match.index ?? 0), "unapproved Git host");
    }
  }

  const hostArgumentPattern = /(?:--hostname|--host|GITLAB_HOST\s*=)\s*["']?([A-Z0-9.-]+\.[A-Z]{2,})/gi;
  for (const match of text.matchAll(hostArgumentPattern)) {
    if (!isSafeHost(match[1])) {
      addViolation(file, lineNumber(text, match.index ?? 0), "unapproved configured host");
    }
  }
}

if (violations.length > 0) {
  console.error("Public-content scan failed:");
  for (const violation of [...new Set(violations)].sort()) {
    console.error(`- ${violation}`);
  }
  console.error("Use synthetic placeholders and keep client data outside this repository.");
  process.exitCode = 1;
} else {
  console.log("Public-content scan passed: no credential, private-host, email, or local-path indicators found.");
}
