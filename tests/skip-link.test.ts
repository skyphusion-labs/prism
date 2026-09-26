// The skip link, as an artifact check (fleet-chezmoi#1700).
//
// WHAT THIS GUARD CAN SEE: the template and the stylesheet. It is a text read,
// so it proves the rules and attributes are present and self-consistent.
//
// WHAT IT STRUCTURALLY CANNOT SEE, stated here rather than in a PR comment: it
// cannot prove the focused link is VISIBLE. A `:focus` rule with a non-negative
// `left` can still be painted under something, clipped, or transparent, and no
// file read would notice. That half was measured against a real browser with a
// real Tab press (report on the PR) and stays a separate act. What this guard
// buys is that the measured state cannot silently regress: every field below
// was in its failing state before #1700, so the suite has been watched going
// red on the real defect rather than assumed capable of it.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const pub = (f: string) =>
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/", f), "utf8");

// Anything that takes sequential keyboard focus by default, plus an explicit
// positive tabindex. Deliberately crude: it only has to find the FIRST one.
const FOCUSABLE = /<(?:a\s[^>]*href|button|input|select|textarea)\b/i;

/** The body, so head <link>/<script> can never be mistaken for page content. */
function body(html: string): string {
  const m = html.match(/<body[^>]*>([\s\S]*)<\/body>/i);
  if (!m) throw new Error("no <body> in index.html");
  return m[1];
}

/** The declaration block of a rule whose selector matches exactly. */
function rule(css: string, selector: string): string | null {
  const re = new RegExp(
    `(?:^|})\\s*${selector.replace(/[.#*+?^$()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const m = css.match(re);
  return m ? m[1] : null;
}

/** The opening tag that carries id="<id>", or null. */
function tagWithId(html: string, id: string): string | null {
  const m = html.match(new RegExp(`<[a-z][^>]*\\sid="${id}"[^>]*>`, "i"));
  return m ? m[0] : null;
}

describe("control: the matchers discriminate", () => {
  it("FOCUSABLE fires on focusable markup and not on inert markup", () => {
    expect(FOCUSABLE.test('<a href="#x">y</a>')).toBe(true);
    expect(FOCUSABLE.test("<button type=\"button\">y</button>")).toBe(true);
    expect(FOCUSABLE.test('<input id="u">')).toBe(true);
    // The negative half: these must NOT read as a focus stop, or "the skip link
    // is first" would pass on a page where it is not.
    expect(FOCUSABLE.test("<div><span>hello</span><!-- a comment --></div>")).toBe(false);
    expect(FOCUSABLE.test('<a name="anchor">no href</a>')).toBe(false);
  });

  it("rule() extracts the block it names and not a longhand neighbour", () => {
    const css = ".skip-link { left: -9999px; }\n.skip-link:focus { left: 8px; }\n";
    expect(rule(css, ".skip-link")).toContain("-9999px");
    expect(rule(css, ".skip-link")).not.toContain("8px");
    expect(rule(css, ".skip-link:focus")).toContain("8px");
    expect(rule(css, ".nope")).toBeNull();
  });

  it("tagWithId finds the tag and reports a missing id as missing", () => {
    expect(tagWithId('<main class="c" id="main-content" tabindex="-1">', "main-content"))
      .toContain("tabindex");
    expect(tagWithId("<main>", "main-content")).toBeNull();
  });
});

describe("the skip link is the first thing a keyboard user reaches", () => {
  it("is the first focusable element in the body", () => {
    const b = body(pub("index.html"));
    const at = b.search(FOCUSABLE);
    expect(at).toBeGreaterThan(-1);
    // The first focus stop in the document is the skip link itself.
    expect(b.slice(at, at + 200)).toContain('class="skip-link"');
  });

  it("has a non-empty text label, so the focus stop is identifiable", () => {
    const m = pub("index.html").match(/<a class="skip-link"[^>]*>([^<]*)<\/a>/);
    expect(m).not.toBeNull();
    const label = (m as RegExpMatchArray)[1].trim();
    expect(label.length).toBeGreaterThan(0);
    // An `aria-hidden` skip link would be a focus stop with no name at all.
    expect(pub("index.html")).not.toMatch(/<a class="skip-link"[^>]*aria-hidden/);
  });
});

describe("the skip link goes somewhere that exists and is rendered", () => {
  const html = pub("index.html");
  const href = (html.match(/<a class="skip-link"[^>]*href="#([^"]+)"/) || [])[1];

  it("targets a same-document fragment", () => {
    expect(href).toBeTruthy();
  });

  it("the target id is present in the document", () => {
    expect(tagWithId(html, href as string)).not.toBeNull();
  });

  // The defect this one exists for: the link used to point at #auth-screen,
  // which carries `hidden` and is revealed only in public mode with no session.
  // On every signed-in page it therefore aimed focus at a hidden element.
  it("the target is not hidden by default", () => {
    const tag = tagWithId(html, href as string) as string;
    expect(tag).not.toMatch(/\shidden(\s|>|=)/);
  });

  it("the target accepts programmatic focus", () => {
    const tag = tagWithId(html, href as string) as string;
    expect(tag).toMatch(/tabindex="-1"/);
  });
});

describe("focus moves the link on-screen", () => {
  const css = pub("styles.css");

  // The #177 / fc#1646 CSP invariant: the offscreen positioning is a stylesheet
  // rule, never an inline style attribute. Enforcing style-src-attr drops the
  // attribute and renders the link on the page.
  it("the offscreen positioning is in the stylesheet", () => {
    const base = rule(css, ".skip-link");
    expect(base).not.toBeNull();
    expect(base as string).toMatch(/position:\s*absolute/);
    expect(base as string).toMatch(/left:\s*-9999px/);
    expect(pub("index.html")).not.toMatch(/<a class="skip-link"[^>]*\sstyle\s*=/);
  });

  // The whole point of #1700. Before the fix there was NO :focus rule at all,
  // and the element's box was measured still at x = -9999 after .focus().
  it("a :focus rule exists and its left is not offscreen", () => {
    const focused = rule(css, ".skip-link:focus");
    expect(focused).not.toBeNull();
    const left = (focused as string).match(/left:\s*(-?[\d.]+)/);
    expect(left).not.toBeNull();
    expect(Number((left as RegExpMatchArray)[1])).toBeGreaterThanOrEqual(0);
  });

  it("the revealed link is painted above the auth screen and the sidebar", () => {
    const base = rule(css, ".skip-link") as string;
    const z = base.match(/z-index:\s*(\d+)/);
    expect(z).not.toBeNull();
    // .auth-screen is z-index 100; a reveal underneath it is not a reveal.
    expect(Number((z as RegExpMatchArray)[1])).toBeGreaterThan(100);
  });
});

describe("the auth gate state has no block to bypass", () => {
  // body.auth-active .layout is display:none, so the sidebar and the skip
  // target are both out of the layout. A skip link there would be a focus stop
  // pointing at nothing, which is the defect #1700 fixed, re-introduced.
  it("the skip link leaves the tab order while the auth gate is up", () => {
    const css = pub("styles.css");
    expect(rule(css, "body.auth-active .skip-link")).toMatch(/display:\s*none/);
    // Control: the rule this one depends on is still what makes the shell absent.
    expect(rule(css, "body.auth-active .layout")).toMatch(/display:\s*none/);
  });
});
