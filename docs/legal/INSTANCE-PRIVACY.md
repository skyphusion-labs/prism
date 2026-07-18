# Privacy notice: the hosted Prism instance (play.skyphusion.org)

**Scope.** This notice applies only to the one public Prism instance that Skyphusion Labs operates at
play.skyphusion.org. Prism is self-hosted software (AGPL-3.0-only). If you run your own Prism
instance, this notice does not apply to you: you are the operator of your instance, your data lives on
your own Cloudflare account, and Skyphusion Labs never sees it (see the project's README for the
self-hosted posture). This is a plain-language description of how the hosted instance handles data. It
is not legal advice.

## Our headline, and the one honest exception

Across Skyphusion Labs the rule is simple: we do not want your data. The hosted Prism instance is the
one place where that is not literally zero. To give you a working playground with an account that
remembers your work, the hosted instance stores your account and the content you create. We keep it to
what is mechanically necessary to run the playground, and you can delete all of it yourself at any
time.

## You sign in with a first-party account

The hosted instance uses its own username and password accounts. There is no Cloudflare Access, no
one-time-PIN email, and no third-party identity provider (Google, GitHub, and the like) in the path.
You sign up directly on play.skyphusion.org with a username and a password, and nothing else.

**We do not collect your email.** This release has no email, no password-reset, and no account-recovery
flow, so signup never asks for an email address and none is stored. Keep your password safe: if you
lose it, we have no way to email you a reset.

## What the hosted instance stores (under your account)

- **Your account:** the username you choose, and your password stored **only** as a one-way hash
  (PBKDF2-HMAC-SHA-256, with a per-account random salt and a high iteration count). We never store,
  log, or transmit your password in plain text, and the hash cannot be reversed back into your
  password.
- **Your session:** when you sign in, the instance sets an opaque session cookie. Server-side it keeps
  only a SHA-256 hash of that session token (never the token itself), tied to your account and an
  expiry. Logging out or deleting your account revokes the session immediately.
- **Your content:** the prompts and chats you write, and the images, video, music, and voice you
  generate, plus any documents you add for retrieval (RAG). These are stored in the instance D1
  database and R2 bucket, keyed to your account by a stable, opaque account id.
- **Your AI Gateway settings:** the gateway slug and Cloudflare AI Gateway token you enter so the
  instance can run models on **your** account (see "How model inference is billed and routed" below).
- **Operational records** mechanically required to run the service: request and job state, and
  abuse-control counters (see "Abuse controls" below).

## Where it is stored

Everything above lives on Skyphusion Labs' own Cloudflare account: account and chat metadata, RAG
chunk text, session records, and your gateway settings in **D1**; all binary artifacts (uploads and
generated media) in **R2**; RAG embeddings in **Vectorize**. Nothing binary is stored in D1; chat rows
reference R2 keys.

## How model inference is billed and routed (bring your own gateway)

The hosted instance does **not** pay for your model inference. Before you can run a paid or proxied
model you enter your own **Cloudflare AI Gateway** slug and an AI Gateway token in Account settings.
The instance stores those in its D1 database and uses them to send your model requests through **your**
AI Gateway, so inference is billed to **your** Cloudflare Unified Billing account, not ours. The
hosted worker has no gateway credentials of its own; with your settings unset, paid model calls fail
closed with a clear prompt to configure your gateway, rather than silently billing anyone else.

Treat the AI Gateway token you enter as you would any API credential. It is held in the instance
database solely to authorize your model calls, and deleting your account (below) removes it along with
everything else.

## Abuse controls (transient IP processing)

To keep signup and login from being abused, the instance rate-limits those requests. It does this by
counting recent attempts against the caller's IP address (the address Cloudflare reports at the edge)
and, for login, the username being tried. IP addresses are processed for this abuse-control purpose
only; we do not use them to profile you, build a history, or track you across sessions.

## What we do not do

No tracking, no advertising, no analytics or ad-tech, no profiling, no third-party data brokers. We do
not sell your data and we do not share it, with the single exception of the abuse bright line below
(CSAM / NCII), which we report as required by law.

## Third parties in the path

The hosted instance runs on Cloudflare (Workers, D1, R2, Vectorize). Your model requests are sent
through the AI Gateway **you** configure, on your own Cloudflare account; the model providers reachable
through that gateway receive your prompt content in order to return a result, and handle it under their
own and your gateway's terms rather than ours.

**Web search is opt-in and does not use any third-party search API.** Prism has a per-turn web search
toggle. When you switch it on for a turn, the text of that one query is sent to the instance's own
self-hosted search service (SearXNG, run by Skyphusion Labs) and to keyless public sources such as
Wikipedia. No third-party search-API provider (and no per-provider API key) is in the path. The
snippets that come back are stored with the turn as retrieved context, the same way your RAG chunks
are. Your chat history, your uploaded documents, and your generated media are never sent out for
search. Leave the toggle off and no query leaves the instance.

## Deleting your data

Account deletion is built into the app. From Account settings you delete your account (re-entering your
password to confirm), and it **cascades**: it removes your account record and sessions, your chats and
conversations, every generated artifact and uploaded document in R2, your RAG embeddings in Vectorize,
your projects, and your stored AI Gateway settings. Deletion is on you and takes effect on the
instance; we do not keep a shadow copy. If you self-host Prism instead, deletion is entirely in your
hands on your own instance.

## The one bright line

This minimal-data, hands-off stance is not a shield for child sexual abuse material or non-consensual
intimate imagery. See the [instance Acceptable Use notice](INSTANCE-ACCEPTABLE-USE.md): that is the
one category we will act on and report.

## Operator and contact

The hosted instance is operated by Skyphusion Labs. Data questions: **privacy@skyphusion.org**.

Not legal advice.
