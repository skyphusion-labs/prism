# Plan: prism#192 -- make the privacy notice true

**Single repo: `prism`. PUBLIC repo. The notice is a PUBLISHED privacy disclosure, so each gap is a
misstatement to a user, not a doc nit.**

## Three statements the code does not match

**1. Deletion is not a full cascade.** `docs/legal/INSTANCE-PRIVACY.md:96-99` says deletion
"cascades ... we do not keep a shadow copy", and `README.md:485` says "cascades every trace".
`src/auth.ts:307-319` deletes from chats, chunks, documents, project_documents, project_messages,
projects, sessions, user_prefs and users. It **never touches `conversation_compact`**
(`schema.sql:56-68`, keyed by `user_email`), whose `summary` column is a model-written digest of the
user's own chat turns. **A deleted user's chat summaries stay in D1 indefinitely.**

**2. "Transient IP processing" is indefinite retention.** `INSTANCE-PRIVACY.md:65` heads the
abuse-controls section "transient IP processing", but `auth_attempts` rows keyed `signup:<ip>` and
`login:<ip>:<username>` (`src/rate-limit.ts:46-59`) are pruned only by a successful login clearing its
own bucket (`:76`). `wrangler.example.toml:20` has `crons = []`, so nothing prunes on a schedule.

**3.** The third item is in the issue body. Read it there rather than from this plan.

## Order, and this is a correctness change before it is a docs change

**Fix the CODE first, then make the notice describe the fixed code.** Do not "fix" this by softening
the notice to match current behaviour unless a deletion is genuinely not wanted -- and if you conclude
that, stop and say so rather than editing the disclosure down.

1. Add the `conversation_compact` delete to the account-deletion path in `src/auth.ts`.
2. Prune `auth_attempts`. A cron is one option but `crons = []` is in the EXAMPLE config, so a prune
   that depends on an operator adding a cron is not a fix for a self-hoster who does not. Prefer a
   prune-on-write bound, and say what retention window you chose and why.
3. Only then reconcile `INSTANCE-PRIVACY.md` and `README.md` to the new behaviour.

## Acceptance, driven red first

- A test that **inserts a `conversation_compact` row, deletes the account, and asserts zero rows
  remain.** It must FAIL against current `main` -- run it there and show the failure before the fix.
- A test for the `auth_attempts` bound that likewise fails first.
- Say explicitly what the tests **cannot** see. These run against a test D1; they do not prove
  anything about rows already in the production database. **Existing orphaned `conversation_compact`
  rows for already-deleted users are NOT cleaned up by a code fix**, and that is a separate item to
  raise, not to quietly fix here.
- `npm run typecheck` is the gate and is NOT part of the vitest run. Chain with `&&`.

## Ground rules

- No em-dashes or en-dashes. Use `--`.
- Public repo: do not describe an unpatched weakness in the PR title, branch name or body beyond what
  the issue already states publicly. The issue is already public, so matching its level is fine;
  do not add exploitability detail.
- ONE PR, do not merge it, say FINAL when ready. `Refs #192`.
