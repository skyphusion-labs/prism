# prism

This file is the guide for any coding agent and any contributor. Follow it.

## What this project is

prism is a multimodal AI playground.
It is one Cloudflare Worker.
There is no framework.
The public demo is [https://play.skyphusion.org](https://play.skyphusion.org).
That demo uses `AUTH_MODE=public` (first-party accounts).
A private self-host can use `AUTH_MODE=access` with Cloudflare Access.

The repo was renamed from `skyphusion-llm-public`.
The template Worker, D1, R2, and Vectorize names stay `skyphusion-llm`.
See `wrangler.example.toml`.
Those names are intentional.

The catalog is `src/models.ts`.
Re-count models there.
Do not copy a count into this file.
`GET /api/models` returns the live catalog.

Chat, image, TTS, STT, video, and music go through `env.AI.run` or an AI Gateway provider endpoint.
The default bill is Cloudflare AI Gateway Unified Billing.
The one deployer-key exception is optional `OPENAI_API_KEY`.
That key is only for transparent `openai/gpt-image-*` PNG.
Do not set it on a public `AUTH_MODE=public` deploy.
Chat and every other provider stay on Unified Billing.

Opt-in web search uses the `SEARCH` service binding plus keyless Wikipedia.
You can omit the binding.
Wikipedia still runs.
The source then reports the search binding absent.

The version is root `package.json`.
Also read `packages/create-prism/package.json` and `src/version.ts`.
Do not copy a version into this file.
See the latest `v*` tag.

Sibling repos are separate.
Read each repo for its own version.
`prism-control-plane` is the metered proxy.
`prism-ios` and `prism-android` are native clients.
`prism-mcp` is the MCP door.

Control-plane mode is optional.
User prefs may store a `pcp_` client key and a control-plane URL.
When that is set, chat goes through the proxy.
History and RAG stay in this Worker.
See `src/control-plane.ts`.

## How to work

```bash
npm run bootstrap
npm run dev
npm run typecheck
npm test
npm run db:migrate:local
```

`npm run typecheck` is the CI gate.
Vitest does not run it.
Run it before you push.
`npm run dev` has no Access session and no public session.
Do not expose a local dev port on the public internet.

`npm run deploy` is for a Worker you own.
Production deploy of the public demo is tag-gated.
See [.github/workflows/deploy.yml](.github/workflows/deploy.yml).
A merge to `main` runs [.github/workflows/ci.yml](.github/workflows/ci.yml).
It does not redeploy the public demo.

`wrangler.toml` is gitignored.
Change `wrangler.example.toml`.
`npm run bootstrap` copies the example once.
It does not overwrite an existing file.

`schema.sql` is for a fresh database only.
Upgrade an existing database with the `migrate-v*.sql` files.
Steps are in the changelog and [README.md](README.md).
Do not run `schema.sql` again on a populated database.

The pull request flow is [CONTRIBUTING.md](CONTRIBUTING.md).

## Architecture

`src/index.ts` is the router.
Route handlers live in `src/routes/`.
RAG lives in `src/routes/rag.ts`.

`src/models.ts` is the catalog.
An entry's `id` is the routing key.
`type` picks the dispatcher.
Adding an entry updates `GET /api/models` and the picker.

`src/providers/` calls each provider.
`src/parsers/` adapts each stream format.
`src/ai-binding.ts` wraps `env.AI.run`.
When user credentials include an account id, it calls the REST API on that account.
Do not call `env.AI.run` with a user's gateway directly.
The binding only addresses the Worker account.

`src/env.ts` is the hand-authored `Env` interface.
Mirror every binding there.
Do not commit a generated `worker-configuration.d.ts`.

`public/` is vanilla JS, HTML, and CSS.
Workers Assets serve it.
Do not add a framework or a build step.
[CONTRIBUTING.md](CONTRIBUTING.md) rejects that change.

D1 holds chat metadata, RAG text, and projects.
No binary goes in D1.
R2 holds binaries.
`GET /api/artifact/*` checks `customMetadata.user_email` before it streams an object.
Vectorize holds RAG embeddings (768-dim, cosine).

Video and music use Cloudflare Workflows (`LongRunWorkflow`).
They do not fit in `ctx.waitUntil`.
Workflows do not run under `wrangler dev --remote`.
Deploy to test Unified Billing video or music.
Zip import uses the same workflow.
The client polls `GET /api/import/:id`.

Route list and auth details are in [README.md](README.md).
`resolveIdentity` in `src/auth.ts` is the only identity seam.

Two Vitest projects run under `npm test`.
Put pure tests in `tests/`.
Put fetch-handler tests in `tests-integration/`.
The integration suite stubs AI, Vectorize, and Workflows.
It is safe for a public CI run.

Runtime deps stay minimal.
Today they are `unpdf` and `xlsx`.
A new runtime dep needs a reason.

## Secrets

Set secrets with `npx wrangler secret put`.
Do not commit them.
Local values go in `.dev.vars`.

| Secret | When |
| --- | --- |
| `GATEWAY_ID` | Private install. Omit it on the public demo. Users set their own gateway. |
| `CF_AIG_TOKEN` | Private install, for paid third-party models. Public demo stores a per-user token. |
| `OPENAI_API_KEY` | Optional. Transparent `openai/gpt-image-*` PNG only. Leave it unset on public play. |

In public mode the Worker ignores its own `GATEWAY_ID`, `CF_AIG_TOKEN`, and `OPENAI_API_KEY`.
Users store account id, gateway id, and token in D1.
All three are required.
Credentials with no account id get `412 gateway_account_id_required`.
There is no fallback to the binding.

## Release

Bump three files together: root `package.json`, `packages/create-prism/package.json`, and `src/version.ts`.
`src/version.ts` is what `/health` reports.
`tests/version.test.ts` fails if the literal lags.
[.github/workflows/tag-version.yml](.github/workflows/tag-version.yml) checks the tag against root `package.json`.

Add a `## vX.Y.Z` entry at the top of `CHANGELOG.md`.
Document a new binding or schema change as a copy-paste block.
An existing deployer applies that block by hand.

Tag the merge commit:

```bash
git fetch origin main && git checkout main && git pull --ff-only
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

Confirm the live site, not only the green check.
npm publish of `@skyphusion/create-prism` runs when a GitHub Release is published.
See `.github/workflows/publish-npm.yml`.

A version changes only in a release pull request.
Feature and fix pull requests do not bump it.
Put the tag on that pull request's merge commit.
If that version already has a tag, the cycle is closed.
The next release pull request bumps.
If the manifest version has no tag, stop.
Find why before you bump again.

## Docs

Write Simplified Technical English.
Use short sentences.
Use one idea per sentence.
Use the active present tense.
Use plain words.
Use the same word every time.

Do not use an em dash (U+2014) or an en dash (U+2013) in source or docs.
Use a comma, a semicolon, parentheses, or two hyphens (`--`).

State the limit next to the capability.
Do not turn a measured result into a promise.
Use Conventional Commits.
The body says why.

## Safety

Do not put a secret in a tracked file.
Do not put a secret in a log.
Do not put a secret in an issue.
Do not add telemetry that sends user data to a third party.
New inference stays on Workers AI or AI Gateway Unified Billing, except the one PNG exception above.
Verify a new Workers AI model id against `developers.cloudflare.com/workers-ai/models/`.
