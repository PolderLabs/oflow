// Proves the Laya modules are portable, rather than asserting it.
//
// The claim is that src/laya-runner.ts and src/laya-scrum.ts can be lifted into
// another planning tool unchanged: no oflow types, no GitLab types, no import
// from any other module in this package, and no runtime dependency beyond
// node: builtins plus the Laya process itself.
//
// This script checks all three mechanically. It is a check, not a bundler: it
// fails on a forbidden import, and it reports the exported surface so a change
// to that surface is visible in review.
//
// Run: node scripts/check-portable.mjs
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcDir = join(here, "..", "src");

/**
 * Portable modules are discovered, not listed. A hardcoded array meant a new
 * src/laya-*.ts file would be invisible to this gate until someone remembered
 * to add it, which is the same failure as the orphaned-dist check: a guard
 * that only covers what it was told about.
 */
const PORTABLE_MODULES = readdirSync(srcDir)
  .filter((file) => /^laya-.*\.ts$/.test(file))
  .sort();

if (PORTABLE_MODULES.length === 0) {
  process.stderr.write("FAIL no src/laya-*.ts modules found; the glob is wrong");
  process.exit(1);
}

/** Imports these are fine: node builtins, and any other portable module. */
const ALLOWED_LOCAL = new Set(
  PORTABLE_MODULES.map((file) => `./${file.replace(/\.ts$/, ".js")}`),
);
const isAllowedImport = (specifier) =>
  specifier.startsWith("node:") || ALLOWED_LOCAL.has(specifier);


let failures = 0;
for (const name of PORTABLE_MODULES) {
  const source = readFileSync(join(srcDir, name), "utf8");
  const offenders = [];
  for (const match of source.matchAll(/^import[^;]*?from\s+"([^"]+)"/gm)) {
    const specifier = match[1];
    if (!isAllowedImport(specifier)) offenders.push(specifier);
  }
  // A bare `require` or a reference to another src module would also break the
  // claim, so check for the obvious ways to smuggle one in.
  const smuggled = [];
  if (/\brequire\s*\(/.test(source)) smuggled.push("require()");
  for (const other of readdirSync(srcDir)) {
    if (!other.endsWith(".ts")) continue;
    if (PORTABLE_MODULES.includes(other)) continue;
    if (other === "types.ts") continue; // type-only; the modules avoid it
    if (new RegExp(`\\./${other.replace(/\.ts$/, "")}\\b`).test(source)) {
      smuggled.push(`./${other.replace(/\.ts$/, ".js")}`);
    }
  }

  if (offenders.length > 0 || smuggled.length > 0) {
    failures += 1;
    process.stderr.write(
      `FAIL ${name}: not portable\n` +
      (offenders.length ? `  forbidden imports: ${offenders.join(", ")}\n` : "") +
      (smuggled.length ? `  references to other modules: ${smuggled.join(", ")}\n` : ""),
    );
  } else {
    const exports = [...source.matchAll(/^export (?:async )?(?:function|const|type|interface) ([A-Za-z_]+)/gm)]
      .map((m) => m[1])
      .sort();
    process.stdout.write(`ok   ${name}: no oflow coupling, ${exports.length} exports\n`);
    process.stdout.write(`     ${exports.join(", ")}\n`);
  }
}

// A deleted source leaves its compiled output behind, because tsc never
// removes it -- and dist ships in the published tarball. That is how a module
// with no source behind it reached a pack listing before.
const distDir = join(here, "..", "dist");
let stale = [];
try {
  const built = new Set(
    readdirSync(distDir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => file.replace(/\.js$/, "")),
  );
  const sources = new Set(
    readdirSync(srcDir)
      .filter((file) => file.endsWith(".ts"))
      .map((file) => file.replace(/\.ts$/, "")),
  );
  stale = [...built].filter((name) => !sources.has(name));
} catch {
  // No dist yet (typecheck-only run). Nothing to check.
}

if (stale.length > 0) {
  failures += 1;
  process.stderr.write(
    `FAIL dist has ${stale.length} module(s) with no matching src/*.ts: ${stale.join(", ")}\n` +
    "     npm run build now cleans dist first; run it before packing.\n",
  );
} else {
  process.stdout.write("ok   dist matches src: no orphaned build output\n");
}

if (failures > 0) {
  process.stderr.write(`\n${failures} module(s) are not portable\n`);
  process.exit(1);
}
process.stdout.write("\nAll Laya modules are portable: node builtins and each other only.\n");
