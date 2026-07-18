# @skyphusion/create-prism

Scaffold a new [**prism**](https://github.com/skyphusion-labs/prism) deployment: a
multimodal AI playground (chat across many models, voice chat, image / video / music
generation, RAG, and web search) that runs as a single Cloudflare Worker.

This package is the scaffolder. It copies a fresh, deployable prism tree into a new
directory; you then wire your own Cloudflare resources and deploy. The full prism
source ships inside the tarball, so there is no separate clone step.

## Quick start

```
npm create @skyphusion/prism my-prism
cd my-prism
npm install
npm run bootstrap
```

`npm run bootstrap` copies `wrangler.example.toml` to `wrangler.toml` (your
per-deployer config; gitignored). From there the scaffolder prints numbered next
steps; the generated `README.md` has the complete walkthrough.

You can also run the scaffolder directly:

```
npx @skyphusion/create-prism my-prism
```

`my-prism` is optional (default `prism-app`). The command refuses to write into a
directory that already exists and is not empty; nothing is written in that case.

Requires **Node.js 20 or later**. Zero runtime dependencies.

## What you get

A working single-Worker app for the Cloudflare AI stack: chat over many models and
five providers, hands-free voice chat, image / TTS / STT / video / music generation,
RAG over uploaded files, projects, Discord ingestion, and opt-in web search. One web
UI, per-user history, R2 for all binary artifacts. No framework, no build step beyond
TypeScript.

## Cloudflare resources you provide

Everything bills through **Cloudflare Unified Billing** on your own AI Gateway; there
is no deployer BYOK key. Create these once and wire their ids into `wrangler.toml`
(the scaffolder prints the exact commands):

**Required bindings**

| Binding | Resource | Purpose |
|---|---|---|
| `AI` | Workers AI + AI Gateway | Every modality funnels through `env.AI.run()`; paid partners route through your gateway. |
| `DB` | D1 database | Chat metadata, conversations, RAG chunk text, projects, accounts. |
| `R2` | R2 bucket | All binary artifacts (inputs and generated output). Nothing binary touches D1. |
| `VEC` | Vectorize index | RAG embeddings, 768-dim BGE-base, cosine. |
| `LONGRUN` | Workflows | Durable execution for long-running video and music generation. |

Plus the `ASSETS` static-assets binding (the `public/` frontend) and the
`STT_SESSION` Durable Object for streaming voice, both already declared in the
template `wrangler.example.toml`.

**Optional**

- `SEARXNG_URL` (and the `SEARXNG_ACCESS_CLIENT_ID` / `SEARXNG_ACCESS_CLIENT_SECRET`
  halves when your SearXNG instance sits behind Cloudflare Access) enable the opt-in
  web-search source. Unset, web search silently skips SearXNG; keyless Wikipedia still
  runs.

## Auth: two modes, one identity seam (`AUTH_MODE`)

The scaffolded worker learns who a caller is one of two ways, chosen by the
`AUTH_MODE` var in `wrangler.toml`:

- **`access` (default, private self-host).** Cloudflare Access sits in front of the
  worker URL; identity comes from the `Cf-Access-Authenticated-User-Email` header.
  Inference bills the deployer, through the worker gateway secrets `GATEWAY_ID` and
  `CF_AIG_TOKEN`.
- **`public` (the open, first-party-signup service).** First-party username/password
  accounts behind an opaque server-side session cookie. Every user brings their own AI
  Gateway credentials (mandatory BYOK), so **the worker holds no gateway secrets and
  visitor inference never bills the host**. Do not set `GATEWAY_ID` / `CF_AIG_TOKEN` on
  a public worker; they are ignored in this mode. No Cloudflare Access needed.

Either way, one stable opaque account id scopes history and R2 ownership, so cross-user
access is impossible even if an id is guessed.

## License and the AGPL-3.0 network-service obligation

prism (and every app you scaffold from it) is **AGPL-3.0-only**. If you run it as a
network service for users, **AGPL-3.0 section 13 requires you to offer those users the
Corresponding Source of your running instance** under the same license. The template
satisfies this with an in-app "Source code" link in the account menu; if you modify the
worker and run it publicly, point that link at your own source. This is a legal
obligation, not a suggestion: publishing a public prism instance means publishing its
source.

## Note for offline / mirrored npm installs

The scaffolded app has one dependency that resolves from a URL rather than the npm
registry: `xlsx` (spreadsheet RAG) is pinned to a tarball on `cdn.sheetjs.com`
(`https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`), per the SheetJS distribution
policy. A normal `npm install` fetches it fine. If you install behind a private mirror,
an air-gapped proxy, or a lockfile-strict CI that blocks non-registry URLs, allowlist
`cdn.sheetjs.com` or vendor that tarball into your mirror. Everything else resolves from
the public npm registry.

## Links

- prism source and full docs: https://github.com/skyphusion-labs/prism
- Live instance: https://play.skyphusion.org
- Issues: https://github.com/skyphusion-labs/prism/issues

Licensed AGPL-3.0-only. See `LICENSE` and `NOTICE`.
