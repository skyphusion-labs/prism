# Mobile feasibility note: native Android and iOS for Prism

Status: research for review, not a decision. Author: Ernst (legal-affairs helper), Sprint 1, issue #82.
Assumes **paid subscription mobile** per Conrad, 2026-07-17 (issue #82 comment), not a free thin client of
the public web playground. Nothing here is legal advice; the legal-structural section flags items for a
licensed reviewer.

## Recommendation (lead with it)

**DEFER to a later sprint, gated on #80.** Do not start mobile until first-party auth (#80) is merged and an
entitlement API exists on the Worker. When it does start, ship a **cross-platform app (React Native or
Flutter), chat-only MVP, with Skyphusion-hosted metered inference** behind an App Store / Play auto-renewing
subscription. BYOK stays the web posture; it is a poor fit for a paid mobile tier and is noted as a later
"advanced" tier, not the MVP.

This is a **defer**, not a **no-go**: the product case (a paid, polished mobile client) is coherent, but the
two hard prerequisites (a durable identity plane and a server-side entitlement check) do not exist yet, and
building either against today's Cloudflare Access identity plane would be throwaway work.

Go / no-go / defer, one line each:
- **Go now:** no. Prerequisites (#80 auth, entitlement API) are not in place.
- **No-go forever:** no. The subscription product is viable once the groundwork lands.
- **Defer:** yes. Revisit at the top of the sprint after #80 merges; treat the entitlement API as its own issue.

## v1 approach under a subscription model

Compared against the issue's four options:

| Approach | Subscription fit | Effort | Verdict |
|---|---|---|---|
| Responsive PWA | Weak. No first-class store subscription; iOS PWA cannot use StoreKit, so no App Store IAP. | Low | Non-goal for the paid tier |
| Wrapper (Capacitor) | Marginal. Store binary is fast, but Apple review scrutinizes "just a website" wrappers, and you still bolt on a native IAP plugin. | Low-medium | Non-goal |
| **Cross-platform (React Native / Flutter / KMP)** | **Strong.** One codebase, mature IAP plugins (RevenueCat, react-native-iap, Flutter in_app_purchase), real native UX, StoreKit / Play Billing via plugin. | Medium-high | **Recommended** |
| Fully native (Swift + Kotlin) | Strongest platform fit (StoreKit 2, Play Billing native). | Highest (two codebases) | Overkill for MVP |

**Pick: cross-platform, React Native or Flutter.** It is the only option that gives a credible auto-renewing
subscription story without paying twice for two native codebases. RN vs Flutter is an engineering call for the
frontend lane (Joan); RN leans toward reusing JS/TS skills already in this repo, Flutter toward smoother
media UI. Either satisfies this note.

**Explicit non-goals for v1:**
- Not a PWA and not a Capacitor wrapper of `public/` (weak subscription story, review risk).
- Not two fully-native codebases (cost not justified pre-revenue).
- Not multimodal parity at launch (see feature cut).
- Not BYOK as the MVP entitlement model (see next section).
- Not a self-hosted-install companion. Self-hosters run their own Worker and have no Skyphusion subscription;
  mobile is a hosted-only, Skyphusion-billed product. Self-host stays web/PWA if anything.

## MVP stance: BYOK vs Skyphusion-hosted inference

**Recommend Skyphusion-hosted, metered inference for the paid MVP.** BYOK as a later "advanced/pro" tier.

Reasoning:
- A paying subscriber expects to open the app and use it. Forcing them to create a Cloudflare account, stand
  up an AI Gateway, mint a token, and paste it into a phone is a hostile onboarding for a paid product and
  will drive refunds and one-star reviews.
- BYOK also collides with store rules: if the subscription unlocks a digital feature (inference), Apple and
  Google generally require that unlock to run through IAP, not an external key the user supplies. A BYOK-only
  paid app invites rejection and confuses the entitlement story.
- Hosted inference means the subscription actually pays for something concrete (model usage, billed to
  Skyphusion's Unified Billing, offset by the subscription price), which is a clean product and a clean IAP.

Consequence to flag for the infra/backend lanes (not legal): hosted inference **reintroduces a worker-side
gateway secret** (`GATEWAY_ID` / `CF_AIG_TOKEN`) for the mobile tier, which #80's public web design
deliberately removes (public web is fail-closed, per-user BYOK, no worker secret). Mobile and public web are
therefore **different SKUs with different secret postures**: web public = BYOK, no worker secret; mobile paid
= hosted, worker holds the gateway secret and meters usage per entitled account. This must be an explicit,
capped, per-account-metered path, not a shared unbounded key. Abuse and cost-runaway controls (per-account
quotas, rate limits) are a hard requirement before this ships, not a follow-up.

Later tier: BYOK "bring your own gateway" for power users who want unlimited usage on their own CF billing,
sold as a cheaper or free "advanced" tier without hosted inference. Note only; not MVP.

## Dependency on #80 and the entitlement-API gap

**Hard blocker: #80 (first-party auth).** Cloudflare Access (`Cf-Access-Authenticated-User-Email`, the only
identity plane today) is an interactive browser SSO gate and is a poor fit for a long-lived native app
session. Mobile needs the first-party username/password identity plane #80 introduces, or a
subscription-linked variant of it. Do not build mobile auth on Access; it would be throwaway.

**Second blocker, and it does not exist yet: a server-side entitlement API on the Worker.** The current
`/api/*` surface has no concept of "is this account a paid subscriber." Mobile needs, at minimum:
- **Receipt / signal validation:** validate an App Store Server Notification / Play Real-time Developer
  Notification (or delegate to a billing provider such as RevenueCat) so the Worker knows subscription state
  server-side. Client-reported "I paid" is never trusted.
- **Server-side entitlement gate:** the Worker issues a session/JWT (or entitlement claim) only when the
  subscription is active, and hosted-inference routes check that claim before spending on models.
- **Restore purchases:** map a store transaction back to the first-party account on reinstall / new device,
  an Apple and Google requirement.

This entitlement API is net-new work, is not in #80's scope, and should be **its own issue** sequenced after
#80. It is the single largest backend item in the whole effort. Flag: the identity plane (#80) and the
entitlement plane (new) are related but distinct; #80 is necessary but not sufficient.

## MVP feature cut vs full web parity

Ship **chat first**, defer everything else. The Worker API surface splits cleanly by client complexity:

| Modality | Worker mechanism | Mobile client work | MVP? |
|---|---|---|---|
| Chat (streaming) | SSE, `POST /api/chat/stream` | SSE reader (standard) | **Yes** |
| Chat (non-stream), history, models | plain JSON `/api/*` | trivial | **Yes** |
| Image / video / music gen | Workflows + `GET /api/job/:id` / `/api/import/:id` polling | poll loop, artifact fetch | Later |
| R2 artifacts | `GET /api/artifact/*` | authed download | Later (with media) |
| Voice chat | WebSocket (`stt-session.ts`) | native WS + audio capture, most complex | Later |
| RAG upload | multipart `POST /api/documents` | file picker + upload | Later |

Chat-only MVP proves the whole hard path end to end: auth (#80), subscription, entitlement, hosted-inference
metering, and SSE streaming. Every other modality is additive on top of a proven spine. Voice (WebSocket +
live audio) is the most expensive client and should be last.

## Rough effort band

Order-of-magnitude only, not an estimate; assumes #80 already merged.

- **Prerequisite (backend, blocks everything): entitlement API** on the Worker (receipt validation,
  entitlement gate, restore, per-account metering + quotas): **medium-large**, its own issue.
- **Chat-only MVP app** (cross-platform, auth + subscription IAP + SSE chat + history): **large.** New
  frontend surface, two store setups (App Store + Play), IAP integration, review cycles, signing, crash
  reporting, release pipeline.
- **Full parity** (media polling, artifacts, voice WS, RAG upload): **additional large**, incremental after
  MVP.

Non-engineering standing costs: two developer program memberships (Apple 99 USD/yr, Google 25 USD once),
store review latency on every release, subscription support burden (refunds, billing questions), and the
legal/ops items below.

## Legal-structural section (my lane; flag for review, not policy)

Framed as structured research to be reviewed by Conrad and, where noted, a licensed attorney. I am not a
lawyer and this is not legal advice. None of this is settled here; each item is a flag.

### 1. AGPL-3.0 vs store binaries (FLAG for legal review; do not merge mobile without a decision)

Prism is **AGPL-3.0**. This is the sharpest legal item and it needs a real decision before any mobile binary
ships.

- **The tension:** AGPL-3.0 requires that recipients of the binary can get the corresponding source under
  AGPL, and it forbids adding restrictions beyond the license. App Store and Play distribution terms impose
  restrictions (DRM, anti-tamper, no-redistribution, store-controlled delivery) that are widely read as
  incompatible with GPL-family "no further restrictions" terms. This is the well-known "GPL app on the App
  Store" problem (the historical VLC / GNU Go removals). It is a real, documented conflict, not hypothetical.
- **Additional AGPL wrinkle:** AGPL's network-use clause (section 13) is triggered by users interacting with
  the software over a network. A native app talking to the Prism Worker raises the question of what counts as
  "the program" and who must be offered source; this needs analysis, not a guess.
- **Structural options to research (a lawyer picks):**
  1. **Sole-copyright relicensing / dual-license.** If Skyphusion (Conrad) holds copyright to all of Prism,
     the copyright holder can license the *mobile distribution* under different (proprietary/commercial)
     terms while the public repo stays AGPL. This is the standard path (the "open core sells a commercial
     license to itself" pattern). Requires confirming there are **no third-party AGPL/GPL contributions** in
     the tree that Skyphusion does not own; if outside contributors exist, a CLA would have been needed to
     relicense. Check contributor history before relying on this.
  2. **Store-distribution exception.** Add an explicit license exception (like the ones projects add for App
     Store distribution) permitting distribution under store terms. Copyright-holder-only action.
  3. **Separate the app.** Keep the AGPL Worker as-is; build the mobile client as a **separately licensed
     codebase** (its own repo, its own license) that merely talks to the Worker API. Whether this cleanly
     avoids AGPL obligations depends on how much AGPL code the app reuses; a from-scratch client that shares
     no source is the cleanest, a wrapper of AGPL `public/` is the least clean.
- **Recommendation to Conrad:** this is a copyright-holder decision with real legal exposure; route it to a
  licensed attorney before committing engineering. The cross-platform-from-scratch approach recommended above
  is partly chosen because it keeps the app a **separate codebase**, which gives the cleanest licensing story
  among the options, but it does **not** by itself resolve the AGPL question. Do not invent the policy here.

### 2. Auto-renewing subscription store rules (research, for product + legal)

Apple (App Store Review Guideline 3.1) and Google (Play Billing policy) both require:
- Digital features unlocked in-app must use the store's IAP / billing, not an external payment or an external
  BYO key that unlocks paid function. Reinforces the hosted-inference recommendation over BYOK for the paid
  tier.
- Auto-renewing subscriptions must disclose, before purchase: title, length, price per period, what it
  unlocks, and a functional link to Terms and Privacy. Auto-renew and how to cancel must be clearly stated.
- Free trials, if offered, have specific disclosure rules.
These are product-and-legal copy requirements to satisfy at store-submission time; list them as acceptance
criteria on the eventual build issue.

### 3. Account deletion (hard store requirement)

Both stores now **require** that an app which supports account creation also supports **in-app account
deletion** (not just deactivation, and not "email us"). Since mobile depends on #80 accounts, #80's account
model must expose a deletion path that the app surfaces, and deletion must cascade to the user's data
(history, R2 artifacts, RAG docs, vectors, subscription linkage). Flag to the #80 lane: account deletion is
now a mobile blocker, not a nice-to-have. Note that store account-deletion and subscription cancellation are
distinct; deleting the account does not by itself refund or cancel an active store subscription.

### 4. Privacy nutrition labels (Apple) / Data safety form (Google)

Both stores require a declaration of data collected and how it is used. Prism collects account identity
(#80), chat content and uploads (D1 + R2), and, for hosted inference, prompts routed to model providers.
The labels must be accurate and consistent with the privacy policy. Draft these against the actual data flow
once #80 and the entitlement API are settled; an inaccurate label is itself a compliance problem.

### 5. ToS and privacy policy for a paid service

The existing `docs/legal/INSTANCE-PRIVACY.md` and `INSTANCE-ACCEPTABLE-USE.md` are templates for **self-hosted
instance operators**, not a first-party paid consumer service. A Skyphusion-operated paid mobile app needs
its own **hosted-service ToS and privacy policy** covering: the paying customer relationship, subscription
terms, hosted-inference data handling (prompts sent to third-party model providers via the gateway),
retention and deletion, and consumer-protection disclosures. This is net-new legal drafting (my lane to
structure, a licensed attorney to review), separate from the instance-operator templates. It is a
prerequisite for store submission, since both stores require working ToS/privacy links.

### 6. Refunds, tax, VAT ops (flag for ops + finance, note only)

- **Refunds:** on both stores, the store handles the refund transaction, but Skyphusion still owns the
  support burden and any usage already spent on hosted inference against a refunded subscription (a
  cost-recovery gap to accept or bound with quotas).
- **Tax / VAT:** Apple and Google act as merchant of record in most jurisdictions and remit consumer sales
  tax / VAT for IAP, which offloads much of the tax operational burden versus billing customers directly.
  Confirm this coverage per target market; it is a reason to prefer store IAP over a direct billing provider
  for the consumer subscription. Where a billing provider (RevenueCat, Stripe) sits in front, re-check who is
  merchant of record. This is an ops/finance flag, not a legal-drafting item.

## Blockers summary

1. **#80 first-party auth** (hard; do not build on Cloudflare Access).
2. **Entitlement API on the Worker** (net-new; its own issue; receipt validation + server-side gate +
   restore + per-account metering). Largest backend item.
3. **AGPL-3.0 vs store distribution** (legal; copyright-holder decision; route to a licensed attorney).
4. **Account deletion in #80's account model** (store requirement; flag to the #80 lane).
5. **Hosted-service ToS / privacy + store privacy labels** (net-new legal drafting; store-submission
   prerequisite).

## Follow-up issues (only if Conrad says go)

Draft, not filed:
- Entitlement API on the Worker (receipt validation, entitlement gate, restore, per-account metering + quotas).
- Cross-platform chat-only MVP app (auth via #80, subscription IAP, SSE chat, history).
- AGPL / commercial-license decision and, if chosen, the license exception or separate-repo split (legal).
- Hosted-service ToS + privacy policy + store data-safety labels (legal).
- Later: media polling + artifacts, voice WebSocket, RAG upload (parity tiers).
