#!/usr/bin/env node
// prepack: assemble the deployable prism tree into packages/create-prism/template/.
//
// The template is NOT committed (it would duplicate the repo source tree in git).
// npm runs this on `npm pack` / `npm publish` before packing, so the tarball
// carries a fresh copy of the current source. Run it by hand to inspect the tree:
//   node scripts/assemble-template.js
//
// It also copies LICENSE and NOTICE up to the package root so the published
// tarball carries them. All three outputs (template/, LICENSE, NOTICE) are
// gitignored. The .gitignore ships as "gitignore" (no dot); the CLI restores the
// dot on scaffold, sidestepping npm stripping a literal .gitignore from tarballs.

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_DIR = join(HERE, "..");
const REPO_ROOT = join(HERE, "..", "..", "..");
const TEMPLATE_DIR = join(PKG_DIR, "template");

// Directories copied whole (recursive). These are the deployable app.
const DIRS = ["src", "public", "tests", "tests-integration", "migrations"];

// Individual files copied verbatim.
const FILES = [
  "schema.sql",
  "MIGRATIONS.md",
  "wrangler.example.toml",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.node.config.ts",
  "vitest.workers.config.ts",
  "CONTRIBUTING.md",
  "README.md",
  "LICENSE",
  "NOTICE",
];

// Docs subset: only the marketing screenshots (README embeds them) and the
// adaptable instance-policy templates. Internal planning docs are excluded.
const DOC_FILES = [
  "docs/screenshot-desktop.jpg",
  "docs/screenshot-mobile.jpg",
  "docs/legal/README.md",
  "docs/legal/INSTANCE-PRIVACY.md",
  "docs/legal/INSTANCE-ACCEPTABLE-USE.md",
];

function die(message) {
  process.stderr.write(`assemble-template: ${message}\n`);
  process.exit(1);
}

function requireSource(rel) {
  const abs = join(REPO_ROOT, rel);
  if (!existsSync(abs)) {
    die(`required source "${rel}" not found at ${abs}. The repo layout changed; update DIRS/FILES.`);
  }
  return abs;
}

function copyInto(rel) {
  const src = requireSource(rel);
  const dest = join(TEMPLATE_DIR, rel);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
}

// Transform the repo-root package.json into the scaffolded app package.json:
// placeholder name, fresh 0.1.0 version, private kept true, prism-project
// identity fields dropped. Scripts and (dev)dependencies (the actual app) stay.
function writeAppPackageJson() {
  const root = JSON.parse(readFileSync(requireSource("package.json"), "utf8"));
  const app = {
    name: "prism-app",
    version: "0.1.0",
    description: root.description,
    license: root.license,
    private: true,
    type: root.type,
    scripts: root.scripts,
    dependencies: root.dependencies,
    devDependencies: root.devDependencies,
  };
  writeFileSync(join(TEMPLATE_DIR, "package.json"), JSON.stringify(app, null, 2) + "\n");
}

function main() {
  // Fresh start for idempotency.
  rmSync(TEMPLATE_DIR, { recursive: true, force: true });
  mkdirSync(TEMPLATE_DIR, { recursive: true });

  for (const d of DIRS) copyInto(d);
  for (const f of FILES) copyInto(f);
  for (const f of DOC_FILES) copyInto(f);

  // migrate-v*.sql legacy deltas (variable set; enumerate rather than hardcode).
  const migrateFiles = readdirSync(REPO_ROOT).filter((f) => /^migrate-v.*\.sql$/.test(f));
  if (migrateFiles.length === 0) die("no migrate-v*.sql files found; expected the legacy delta set.");
  for (const f of migrateFiles) copyInto(f);

  // .gitignore ships without the leading dot; the CLI restores it on scaffold.
  cpSync(requireSource(".gitignore"), join(TEMPLATE_DIR, "gitignore"));

  writeAppPackageJson();

  // Package root also carries LICENSE + NOTICE for the published tarball.
  cpSync(requireSource("LICENSE"), join(PKG_DIR, "LICENSE"));
  cpSync(requireSource("NOTICE"), join(PKG_DIR, "NOTICE"));

  // Fail-loud verification: assert the un-stubbable invariants of a usable tree.
  const mustExist = [
    "src/index.ts",
    "public/index.html",
    "schema.sql",
    "wrangler.example.toml",
    "tsconfig.json",
    "package.json",
    "gitignore",
    "README.md",
    "LICENSE",
    "NOTICE",
  ];
  for (const rel of mustExist) {
    const abs = join(TEMPLATE_DIR, rel);
    if (!existsSync(abs) || statSync(abs).size === 0) {
      die(`post-assembly check failed: template/${rel} missing or empty.`);
    }
  }
  // package.json must NOT be the prism package (name must be the placeholder).
  const appName = JSON.parse(readFileSync(join(TEMPLATE_DIR, "package.json"), "utf8")).name;
  if (appName !== "prism-app") die(`template package.json name is "${appName}", expected "prism-app".`);

  const fileCount = DIRS.length + FILES.length + DOC_FILES.length + migrateFiles.length + 2;
  process.stdout.write(`assemble-template: template ready (${fileCount} top-level entries).\n`);
}

main();
