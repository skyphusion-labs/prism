#!/usr/bin/env node
// @skyphusion/create-prism (v0.168.0 release train; package v0.1.0)
// Scaffold a new prism deployment: a multimodal AI playground on one Cloudflare
// Worker. Single file, zero runtime dependencies, Node >= 20.
//
// Usage:
//   npm create @skyphusion/prism [dir]
//   npx @skyphusion/create-prism [dir]
//
// Exit codes (documented, stable):
//   0  success (or --help / --version)
//   1  usage error (unknown flag or bad argument)
//   2  target directory exists and is not empty (refused, nothing written)
//   3  bundled template missing (packaging error; report upstream)
//   4  filesystem error while copying the template or writing package.json

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_DIR = join(HERE, "template");
const PKG_VERSION = "0.1.0";

const EXIT = {
  OK: 0,
  USAGE: 1,
  TARGET_NOT_EMPTY: 2,
  TEMPLATE_MISSING: 3,
  IO: 4,
};

const HELP = `create-prism ${PKG_VERSION}

Scaffold a new prism deployment (a multimodal AI playground on one Cloudflare
Worker) into a new directory.

Usage:
  npm create @skyphusion/prism [dir]
  npx @skyphusion/create-prism [dir]

Arguments:
  dir            Target directory to create (default: prism-app). Must be empty
                 or not yet exist; the command refuses to write into a non-empty
                 directory.

Options:
  -h, --help     Print this help and exit.
  -v, --version  Print the create-prism version and exit.

Exit codes:
  0  success (also --help / --version)
  1  usage error (unknown flag or bad argument)
  2  target directory exists and is not empty (nothing written)
  3  bundled template missing (packaging error)
  4  filesystem error while copying the template

After scaffolding, the printed next steps walk through npm install, wrangler
resource creation, secrets, and deploy. Full docs ship in the generated
README.md.`;

function fail(code, message) {
  process.stderr.write(`create-prism: ${message}\n`);
  process.exit(code);
}

// Turn a directory name into a valid npm package name for the scaffolded app.
// Falls back to "prism-app" when nothing usable remains.
function toPackageName(dir) {
  const cleaned = basename(dir)
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[-_.]+/, "")
    .replace(/[-_.]+$/, "");
  return cleaned.length > 0 ? cleaned : "prism-app";
}

function parseArgs(argv) {
  const positionals = [];
  for (const arg of argv) {
    if (arg === "-h" || arg === "--help") return { help: true };
    if (arg === "-v" || arg === "--version") return { version: true };
    if (arg.startsWith("-")) return { error: `unknown option "${arg}"` };
    positionals.push(arg);
  }
  if (positionals.length > 1) {
    return { error: `expected at most one directory, got ${positionals.length}` };
  }
  return { dir: positionals[0] ?? "prism-app" };
}

function isNonEmptyDir(target) {
  if (!existsSync(target)) return false;
  const st = statSync(target);
  if (!st.isDirectory()) return true; // a file at the path counts as occupied
  return readdirSync(target).length > 0;
}

// Rewrite the scaffolded package.json name to match the target directory. Best
// effort: if the file is unreadable or malformed we leave the template default.
function setAppName(target, appName) {
  const pkgPath = join(target, "package.json");
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    pkg.name = appName;
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
  } catch {
    // Non-fatal: the app still scaffolds; the user can set the name by hand.
  }
}

function nextSteps(dir) {
  return `Scaffolded prism into ${dir}/

Next steps:

  1.  cd ${dir}
  2.  npm install
  3.  npm run bootstrap
        Copies wrangler.example.toml to wrangler.toml (your per-deployer config).
  4.  Create the Cloudflare resources and wire their ids:
        npx wrangler d1 create skyphusion-llm
          then paste the returned database_id into wrangler.toml
          ([[d1_databases]] database_id), and apply the schema:
            npm run db:migrate:remote
        npx wrangler r2 bucket create skyphusion-llm
        npx wrangler vectorize create skyphusion-llm-vec --dimensions=768 --metric=cosine
  5.  Set the worker secrets (access mode, the default):
        npx wrangler secret put GATEWAY_ID     (your AI Gateway slug)
        npx wrangler secret put CF_AIG_TOKEN   (AI Gateway Run token, for paid models)
        Optional web search: SEARXNG_URL (and the two SEARXNG_ACCESS_* halves if
        the instance is Access-gated). See the README for the full secret list.
  6.  Verify, then deploy:
        npm run typecheck
        npm test
        npm run deploy
  7.  Put Cloudflare Access in front of the worker URL (access mode), or set
        AUTH_MODE=public in wrangler.toml for first-party signups. See the
        "Running the public service" section of the README.

Full setup, auth modes, and the AGPL-3.0 network-service obligation are all
documented in ${dir}/README.md.`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.error) {
    process.stderr.write(`create-prism: ${args.error}\n\n${HELP}\n`);
    process.exit(EXIT.USAGE);
  }
  if (args.help) {
    process.stdout.write(`${HELP}\n`);
    process.exit(EXIT.OK);
  }
  if (args.version) {
    process.stdout.write(`${PKG_VERSION}\n`);
    process.exit(EXIT.OK);
  }

  if (!existsSync(TEMPLATE_DIR) || !statSync(TEMPLATE_DIR).isDirectory()) {
    fail(
      EXIT.TEMPLATE_MISSING,
      "bundled template/ is missing from this package. This is a packaging bug; " +
        "please report it at https://github.com/skyphusion-labs/prism/issues",
    );
  }

  const target = resolve(process.cwd(), args.dir);

  if (isNonEmptyDir(target)) {
    fail(
      EXIT.TARGET_NOT_EMPTY,
      `target "${args.dir}" already exists and is not empty. ` +
        "Choose a new directory name or empty this one first; nothing was written.",
    );
  }

  try {
    mkdirSync(target, { recursive: true });
    cpSync(TEMPLATE_DIR, target, { recursive: true });
    // Restore the dotfile name npm strips from published tarballs.
    const shippedGitignore = join(target, "gitignore");
    if (existsSync(shippedGitignore)) renameSync(shippedGitignore, join(target, ".gitignore"));
  } catch (err) {
    fail(EXIT.IO, `failed to copy the template: ${err && err.message ? err.message : err}`);
  }

  setAppName(target, toPackageName(args.dir));

  process.stdout.write(`${nextSteps(args.dir)}\n`);
  process.exit(EXIT.OK);
}

main();
