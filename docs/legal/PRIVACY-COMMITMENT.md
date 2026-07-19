# The privacy commitment

> **This document is canonical at the constellation hub, and only there.**
> Read it at
> [`vivijure docs/legal/PRIVACY-COMMITMENT.md`](https://github.com/skyphusion-labs/vivijure/blob/main/docs/legal/PRIVACY-COMMITMENT.md).

The privacy commitment is **product-wide**. It covers every product Skyphusion Labs ships (the
Vivijure constellation, Postern, Prism, Slate), so it lives at the hub in one copy and every product
repository points at it rather than carrying its own. A commitment that exists in six places is a
commitment that will eventually say six different things.

This file is a pointer so they can never drift. Do not paste the text here.

## What it says, in one line

Privacy, autonomy, and agency are the primary goal, ranked above feature completeness rather than
traded against it; when a feature cannot be built without violating that, **we drop the feature, not
the line**; public source is the audit mechanism that makes the promise checkable; and the CSAM and
NCII bright line is the one stated exception.

## Why the pointer sits here, said plainly

**Prism is one of the places where "we hold nothing" is not literally true**, and the
canonical document names it in bold rather than leaving a reader to discover it. We operate the
public instance at `play.skyphusion.org`, and it holds an account (username, and a password stored
as a one-way hash) plus the content you create with it.

Two facts keep that consistent with the commitment rather than an exception to it:

- **No email address is collected.** The usual identity hook for a hosted account is simply not
  there.
- **It holds what the product mechanically needs and nothing beyond it**, it is documented against
  the code in [`INSTANCE-PRIVACY.md`](INSTANCE-PRIVACY.md), the content is deletable by you at any
  time, and the self-host route is real.

The commitment is not "we never hold anything." It is that we hold only what the thing you asked for
actually requires, we say so out loud, and the source is public so you can check.

## The tripwire

**If this instance ever starts collecting a field the product does not mechanically need (an email
address, an analytics identifier, a behavioural profile), the commitment stops being true, and
whoever adds it owns updating the canonical document in the same PR.** See the canonical copy for
the full set of drift tripwires.
