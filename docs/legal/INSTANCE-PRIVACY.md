# Privacy notice: the hosted Prism instance (play.skyphusion.org)

**Scope.** This notice applies only to the one public Prism instance that Skyphusion Labs operates at
play.skyphusion.org. Prism is self-hosted software (AGPL-3.0-only). If you run your own Prism
instance, this notice does not apply to you: you are the operator of your instance, your data lives on
your own Cloudflare account, and Skyphusion Labs never sees it (see the project's README for the
self-hosted posture). This is a plain-language description of how the hosted instance handles data. It
is not legal advice.

## Our headline, and the one honest exception

Across Skyphusion Labs the rule is simple: we do not want your data. The hosted Prism instance is the
one place where that is not literally zero. To give you a working playground that remembers your work,
the hosted instance retains the content you create, stored under your username. We keep it to what is
mechanically necessary to run the playground, and you can have it cleared.

## What the hosted instance retains (under your username)

- **Your identity:** the email/identity that Cloudflare Access uses to sign you in.
- **Your content:** the prompts and chats you write, and the images, video, music, and voice you
  generate, plus any documents you add for retrieval (RAG). These are stored in the instance D1
  database and R2 bucket, keyed to your username.
- **Operational records** mechanically required to run the service (for example request and job
  state).

## What we do not do

No tracking, no advertising, no analytics or ad-tech, no profiling, no third-party data brokers. We do
not sell your data and we do not share it, with the single exception of the abuse bright line below
(CSAM / NCII), which we report as required by law.

## Third parties in the path

The hosted instance runs on Cloudflare (Workers, D1, R2, Vectorize, AI Gateway) and routes model
inference through the Cloudflare AI Gateway. Your prompts and content pass through these providers so
the instance can return a result.

**Web search is the one path that leaves Cloudflare, and only when you ask for it.** Prism has an
opt-in, per-turn web search toggle. When you switch it on for a turn, the text of that one query is
sent out to fetch snippets:

- **Wikipedia** (en.wikipedia.org) needs no API key, so it is queried on every web-search turn.
- **Tavily** and **Brave Search** are queried when the instance has been configured with that
  provider's API key, and are silently skipped when it has not.

Those providers receive **the query text only**, and handle it under their own privacy policies rather
than ours. Your chat history, your uploaded documents, and your generated media are never sent to
them. The snippets that come back are stored with the turn as retrieved context, the same way your RAG
chunks are. Leave the toggle off and nothing leaves Cloudflare.

Beyond Cloudflare and the search sources above, we add no others.

## Deleting your data

A self-service deletion method is planned. Until it ships, email **privacy@skyphusion.org** and we
will clear the data held under your username on the hosted instance. If you self-host Prism instead,
deletion is entirely in your hands on your own instance.

## The one bright line

This minimal-data, hands-off stance is not a shield for child sexual abuse material or non-consensual
intimate imagery. See the [instance Acceptable Use notice](INSTANCE-ACCEPTABLE-USE.md): that is the
one category we will act on and report.

## Operator and contact

The hosted instance is operated by Skyphusion Labs. Data questions and deletion requests:
**privacy@skyphusion.org**.

Not legal advice.
