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
- **Your AI Gateway settings:** the Cloudflare account ID, the gateway slug, and the Cloudflare AI
  Gateway token you enter so the instance can run models on **your** account (see "How model inference
  is billed and routed" below).
- **Your control-plane client key, if you enter one:** the `pcp_` key that switches chat onto the
  Skyphusion-operated metered route (see "Metered chat through play-proxy" below). You only have one if
  Skyphusion Labs issued it to you.
- **Operational records** mechanically required to run the service: request and job state, and
  abuse-control counters (see "Abuse controls" below).

## Where it is stored

Everything above lives on Skyphusion Labs' own Cloudflare account: account and chat metadata, RAG
chunk text, session records, and your gateway settings in **D1**; all binary artifacts (uploads and
generated media) in **R2**; RAG embeddings in **Vectorize**. Nothing binary is stored in D1; chat rows
reference R2 keys.

## How model inference is billed and routed (bring your own gateway)

Before you can run a model you enter three things in Account settings: your **Cloudflare account ID**,
your **AI Gateway** slug, and a Cloudflare API token for that account. The instance stores them in its D1
database and uses them to send your model requests to **your** Cloudflare account and gateway, so that
inference is billed to **your** Cloudflare account, not ours. With any of the three missing, model calls
fail closed with a prompt naming what is missing, rather than running on our account. (The one route
that does not need the three is metered chat through play-proxy, below, which only exists if you have
entered a control-plane client key; everything other than chat still fails closed without them.)

**One exception: a few models run on our Cloudflare account.** Some Workers AI models cannot be routed
through an AI Gateway at all, so the instance runs them on its own Cloudflare account: live voice chat,
Deepgram file transcription, and six image models (FLUX.2 Klein 9B / Klein 4B / Dev, Leonardo Phoenix
1.0, Dreamshaper 8 LCM, Stable Diffusion XL). For those, your prompt or audio goes to Cloudflare Workers
AI under our account rather than yours, and we pay for them.

**Correction (v1.1.0).** Earlier versions of this notice said your requests went through your gateway
whenever you entered a slug and token. That was not true: without an account ID the instance could only
address gateways on our own Cloudflare account, so those requests never reached your gateway. The
instance now requires the account ID and routes to your account; settings saved without one are refused
until you add it.

Treat the API token you enter as you would any API credential. It is held in the instance database
solely to authorize your model calls, and deleting your account (below) removes it along with
everything else. Your account ID is not a secret (it appears in every gateway URL) but is stored and
deleted the same way.

## Metered chat through play-proxy (optional; a Skyphusion-operated route)

This section applies only if you have entered a **control-plane client key** (it starts with `pcp_`)
under Account settings > AI Gateway. Skyphusion Labs issues those keys by enrollment; if you never
entered one, nothing in this section happens and chat runs through your own gateway as described above.

**Correction.** Earlier versions of this notice did not mention this route at all, and said every model
request went through the gateway you configure. That was incomplete: the route has existed since Prism
v0.175.0 and the key has been stored with your gateway settings since then. The route itself is
unchanged; this section is the disclosure that was missing.

**Where your chat goes.** While a key is saved, your chat turns, and the conversation compaction that
summarizes older turns, are sent to `https://play-proxy.skyphusion.org`, a service called
prism-control-plane that Skyphusion Labs operates on its own Cloudflare account, instead of to your
gateway. That hostname is fixed in the software and checked against an allowlist on every call; you
cannot point it elsewhere from your account, and neither can anyone holding your key. Inference on this
route is metered against the control-plane account the key belongs to, not billed to your Cloudflare
account.

**What is sent.** For each chat turn: the model you chose; the system prompt in effect for that
conversation, which includes any compaction digest of earlier turns and, when you have retrieval or web
search switched on for the turn, the document excerpts and search snippets retrieved for it; the text of
the earlier turns still in context; your current message, including text extracted from any attachment;
and your client key, as the credential. Images are not forwarded on this route: a turn with an image
attached is refused with an error naming the control-plane route, rather than sent. Image, video, music,
and voice generation, transcription, document ingestion, and web search never use this route; they stay
exactly as described elsewhere in this notice.

**What comes back, and what this instance keeps.** The model's reply, token counts, and a request id.
The reply is stored with the turn in your chat the same way as on any other route, and the request id is
stored on that chat row. Both are deleted with your account.

**What the control plane keeps.** prism-control-plane is open source (AGPL-3.0-only) and publishes its
own retention statement as a binding part of its contract: it never stores prompt or completion text,
and a test in that repository fails the build if a column that could hold message text is ever added.
Its usage ledger keeps, per request, the token counts, the cost, the model id, the status, a request id,
and the id of the client key that made the call, plus a last-seen time on the key. That ledger is a
billing record; the control plane does not publish a deletion window for it, and deleting your Prism
account removes the key from this instance but does not touch that ledger. Read the statement itself:
[Privacy invariant in `docs/CONTRACT.md`](https://github.com/skyphusion-labs/prism-control-plane/blob/main/docs/CONTRACT.md#privacy-invariant-binding-on-every-version-of-this-contract)
and the matching section of its
[README](https://github.com/skyphusion-labs/prism-control-plane/blob/main/README.md#privacy-invariant).

**Beyond the control plane.** The control plane forwards your request to the provider that serves the
model you chose (the catalog names the provider) through an AI Gateway on Skyphusion Labs' Cloudflare
account with payload logging hard-wired off, so neither we nor Cloudflare keep the prompt or completion
bodies there. Cloudflare keeps a metadata row for each call (token counts, model, provider, status, cost,
duration; no content) under its own AI Gateway log retention. The model provider receives your prompt
content in order to return a result and handles it under its own terms, exactly as it would through
your own gateway.

**The key itself.** It is stored in the instance database alongside your gateway settings, shown back to
you only masked, cleared whenever you choose "clear control plane key" in Account settings, and deleted
with your account (below).

## Abuse controls (transient IP processing)

To keep signup and login from being abused, the instance rate-limits those requests. It does this by
counting recent attempts against the caller's IP address (the address Cloudflare reports at the edge)
and, for login, the username being tried. IP addresses are processed for this abuse-control purpose
only; we do not use them to profile you, build a history, or track you across sessions.

**How long those counters live: at most 24 hours.** A successful login clears its own counter
immediately, and every signup or login attempt also deletes any counter older than 24 hours, so an
address that stops coming back is erased on the next attempt by anyone. The counting windows
themselves are much shorter (15 minutes for login, 1 hour for signup); the 24-hour figure is the
outer bound on how long a row can sit in the database before it is removed. Earlier versions of this
notice called this processing "transient" without saying what that meant, and in fact nothing removed
a counter that never saw a successful login: those rows persisted indefinitely. That is fixed, and the
deletion now runs on the write path rather than depending on a scheduled job.

## What we do not do

No tracking, no advertising, no analytics or ad-tech, no profiling, no third-party data brokers. We do
not sell your data and we do not share it, with the single exception of the abuse bright line below
(CSAM / NCII), which we report as required by law.

## Third parties in the path

The hosted instance runs on Cloudflare (Workers, D1, R2, Vectorize). Your model requests are sent
through the AI Gateway **you** configure, on your own Cloudflare account; the model providers reachable
through that gateway receive your prompt content in order to return a result, and handle it under their
own and your gateway's terms rather than ours. There are two exceptions: the short list of models above
that run on our Cloudflare account, which Cloudflare Workers AI processes under our account; and, only
if you have entered a control-plane client key, chat through play-proxy as described in "Metered chat
through play-proxy" above.

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
your projects, and your stored AI Gateway settings, including any control-plane client key. Deletion is
on you and takes effect on the instance; we do not keep a shadow copy. What the control plane's billing
ledger holds about calls made with your key is not on this instance; see "What the control plane keeps"
above. If you self-host Prism instead, deletion is entirely in your hands on your own instance.

## The one bright line

This minimal-data, hands-off stance is not a shield for child sexual abuse material or non-consensual
intimate imagery. See the [instance Acceptable Use notice](INSTANCE-ACCEPTABLE-USE.md): that is the
one category we will act on and report.

## Operator and contact

The hosted instance is operated by Skyphusion Labs. Data questions: **privacy@skyphusion.org**.

Not legal advice.
