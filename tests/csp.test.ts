// Pure-logic tests for the CSP policy string and the violation projection
// (fleet-chezmoi#1646). The DB half is covered against the real fetch handler
// and real local D1 in tests-integration/worker.test.ts; these two suites cover
// different failure modes and neither substitutes for the other.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CSP_FIELD_CAPS,
  CSP_HEADER,
  CSP_HEADER_REPORT_ONLY,
  CSP_REPORT_MAX_BYTES,
  buildCspPolicy,
  extractCspReport,
  stripUrlNoise,
} from "../src/csp";

describe("the header name is the enforcing one", () => {
  // The mode lives in the header NAME, not in the policy string, so a correct
  // policy under the wrong name is a control that refuses nothing while every
  // assertion about its directives keeps passing. Both names are asserted:
  // the live one by value, the retired one by NOT being the live one, because
  // "the report-only header is absent" is otherwise satisfied by a typo.
  it("emits the enforcing header and not the report-only one", () => {
    expect(CSP_HEADER).toBe("content-security-policy");
    expect(CSP_HEADER).not.toBe(CSP_HEADER_REPORT_ONLY);
  });

  // Separate fact, and the one that actually decides the mode on the wire: the
  // Worker must SET the constant rather than a literal typed a second time. A
  // hand-typed header name in index.ts satisfies every assertion above while
  // emitting whatever that literal happens to say.
  it("the worker sets the header from the shared constant, not a literal", () => {
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
      "utf8",
    );
    expect(src).toContain("headers.set(CSP_HEADER, buildCspPolicy())");
    expect(src).not.toContain('"content-security-policy-report-only"');
  });

  // Control: the retired constant really does hold the report-only spelling,
  // so the assertion above is comparing against the right thing rather than
  // against a value that could never have matched.
  it("control: the retired constant is the report-only spelling", () => {
    expect(CSP_HEADER_REPORT_ONLY).toBe("content-security-policy-report-only");
  });
});

describe("enforcing policy string", () => {
  const p = buildCspPolicy();

  it("names the collector on the only transport a report has been seen to arrive over", () => {
    expect(p).toContain("report-uri /api/csp-report");
  });

  // The collector is deliberately KEPT under enforcement. Dropping report-uri
  // at promotion retires the instrument at the moment it starts describing
  // real refusals, and the stored `disposition` is what separates an enforced
  // block from a phase-one observation.
  it("keeps reporting wired at whatever path the caller passes, not just the default", () => {
    expect(buildCspPolicy("/elsewhere/collect")).toContain("report-uri /elsewhere/collect");
    expect(buildCspPolicy("/elsewhere/collect")).not.toContain("report-uri /api/csp-report");
  });

  // REGRESSION GUARD, and it is the opposite of what it looks like. Adding
  // `report-to` is the obvious modernisation and it is what this shipped first;
  // measured, it SUPPRESSED delivery entirely while violations were still being
  // registered by the browser. Whoever re-adds it owes a report observed
  // ARRIVING over that transport.
  it("does not declare report-to, which was measured to suppress delivery", () => {
    expect(p).not.toContain("report-to");
  });

  it("carries the directives that make a strict baseline strict", () => {
    for (const d of [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "connect-src 'self'",
      "font-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ]) {
      expect(p).toContain(d);
    }
  });
});

describe("the two granted exceptions, and only those two", () => {
  const p = buildCspPolicy();
  // Each directive is read as its own segment. Substring matching cannot tell
  // `img-src 'self' data:` from a `data:` that leaked into some other
  // directive, and the whole value of this suite is that distinction.
  const seg = (name: string): string => {
    const found = p.split("; ").find((d) => d.startsWith(`${name} `));
    if (!found) throw new Error(`directive ${name} absent from policy`);
    return found;
  };

  it("control: the segment reader finds a directive that is definitely present", () => {
    expect(seg("default-src")).toBe("default-src 'self'");
  });

  it("control: the segment reader throws rather than returning empty for an absent directive", () => {
    expect(() => seg("child-src")).toThrow(/absent/);
  });

  // GRANT 1. Observed as `img-src | data` in the report-only phase: attachment
  // thumbnails, video-frame previews, and the downscale path, all rendering a
  // data: URL the page produced from a local file that is never uploaded.
  it("grants data: to img-src, which was observed violating", () => {
    expect(seg("img-src")).toBe("img-src 'self' data:");
  });

  // GRANT 2. Observed as `media-src | blob`: TTS playback wraps an Audio around
  // a blob: URL minted from a same-origin response.
  it("grants blob: to media-src, which was observed violating", () => {
    expect(seg("media-src")).toBe("media-src 'self' blob:");
  });

  // THE SCOPE OF THE RULING. Exactly two directives widened. Each of these is
  // asserted on its OWN directive rather than on the whole policy string, so a
  // failure names which directive drifted instead of reporting that something
  // somewhere contains "data:".
  it("does not leak data: into script-src", () => {
    expect(seg("script-src")).toBe("script-src 'self'");
  });

  it("does not leak blob: or data: into connect-src", () => {
    expect(seg("connect-src")).toBe("connect-src 'self'");
  });

  it("does not widen style-src, whose violations were fixed in the page instead", () => {
    expect(seg("style-src")).toBe("style-src 'self'");
  });

  it("does not widen font-src, which was measured to need nothing", () => {
    expect(seg("font-src")).toBe("font-src 'self'");
  });

  it("keeps object-src at none", () => {
    expect(seg("object-src")).toBe("object-src 'none'");
  });

  // The absences that make the grants a grant rather than a relaxation pass.
  it("admits no inline or eval execution anywhere in the policy", () => {
    expect(p).not.toContain("unsafe-inline");
    expect(p).not.toContain("unsafe-eval");
    expect(p).not.toContain("unsafe-hashes");
    expect(p).not.toContain("*");
  });

  // Counting is the guard a later reader is least likely to think of: it goes
  // red when a THIRD grant is added, even one this file never anticipated and
  // therefore has no named assertion for.
  it("exactly two directives carry a scheme source, and they are the two granted", () => {
    const widened = p
      .split("; ")
      .filter((d) => /(^|\s)(data|blob|https?|ws|wss|filesystem|mediastream):/.test(d));
    expect(widened.sort()).toEqual(["img-src 'self' data:", "media-src 'self' blob:"]);
  });

  it("control: the scheme matcher fires on a policy that carries a third grant", () => {
    const widened = "default-src 'self'; img-src 'self' data:; font-src 'self' https:"
      .split("; ")
      .filter((d) => /(^|\s)(data|blob|https?|ws|wss|filesystem|mediastream):/.test(d));
    expect(widened).toHaveLength(2);
    expect(widened).toContain("font-src 'self' https:");
  });
});

// ROUTE ORDERING, asserted here because the integration suite structurally
// cannot see it. That pool binds no AUTH_MODE, so `authMode(env)` is never
// "public" and the public-mode gate never executes there; an "unauthenticated
// access works" test would pass identically whether the collector sat above or
// below the gate. This is a source assertion and it says so, but it is a source
// assertion about the one property that decides whether the collector collects
// anything at all: browsers post violation reports WITHOUT credentials, so a
// session-gated collector is an empty table forever.
describe("the collector is routed above the public-mode auth gate", () => {
  const indexSrc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../src/index.ts"),
    "utf8",
  );

  const gateMarker = 'authMode(env) === "public" &&';
  const routeMarker = 'url.pathname === "/api/csp-report"';

  // Controls first, so a matcher that has stopped matching fails as a broken
  // instrument rather than as a passing ordering claim.
  it("both markers are present (control)", () => {
    expect(indexSrc).toContain(gateMarker);
    expect(indexSrc).toContain(routeMarker);
  });

  it("the collector route appears before the gate", () => {
    const routeAt = indexSrc.indexOf(routeMarker);
    const gateAt = indexSrc.indexOf(gateMarker);
    expect(routeAt).toBeGreaterThan(-1);
    expect(gateAt).toBeGreaterThan(-1);
    expect(
      routeAt,
      "the CSP collector must be routed ABOVE the public-mode gate; browsers " +
        "post violation reports with no credentials, so a gated collector " +
        "silently collects nothing",
    ).toBeLessThan(gateAt);
  });
});

describe("stripUrlNoise", () => {
  it("removes query and fragment", () => {
    expect(stripUrlNoise("https://play.skyphusion.org/x?a=1&b=2#frag")).toBe(
      "https://play.skyphusion.org/x",
    );
  });

  it("leaves a clean URL alone", () => {
    expect(stripUrlNoise("https://play.skyphusion.org/")).toBe("https://play.skyphusion.org/");
  });

  it("returns an unparseable value capped rather than dropping it", () => {
    // Knowing a violation happened somewhere unrecognisable beats a null.
    expect(stripUrlNoise("not a url")).toBe("not a url");
  });

  it("caps length", () => {
    const long = "https://x.example/" + "a".repeat(5000);
    expect(stripUrlNoise(long)!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.document_uri);
  });

  it("returns null for non-strings and blanks", () => {
    expect(stripUrlNoise(null)).toBeNull();
    expect(stripUrlNoise(42)).toBeNull();
    expect(stripUrlNoise("   ")).toBeNull();
  });
});

describe("extractCspReport", () => {
  it("reads the legacy report-uri shape", () => {
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://play.skyphusion.org/?x=1",
        "violated-directive": "style-src 'self'",
        "effective-directive": "style-src-attr",
        "blocked-uri": "inline",
        disposition: "report",
        "status-code": 200,
        "line-number": 47,
      },
    });
    expect(r).not.toBeNull();
    expect(r!.document_uri).toBe("https://play.skyphusion.org/");
    expect(r!.effective_directive).toBe("style-src-attr");
    expect(r!.blocked_uri).toBe("inline");
    expect(r!.status_code).toBe(200);
    expect(r!.line_number).toBe(47);
  });

  it("reads the Reporting API shape", () => {
    const r = extractCspReport([
      {
        type: "csp-violation",
        body: {
          documentURL: "https://play.skyphusion.org/",
          effectiveDirective: "img-src",
          blockedURL: "data:image/png;base64,AAAA",
          disposition: "report",
        },
      },
    ]);
    expect(r).not.toBeNull();
    expect(r!.effective_directive).toBe("img-src");
    expect(r!.blocked_uri).toBe("data:image/png;base64,AAAA");
  });

  // Returning null rather than an all-null row is load-bearing: an empty row
  // records "a violation happened with no detail", which is indistinguishable
  // from a collector mangling its input.
  it("returns null when neither wire shape is present", () => {
    expect(extractCspReport({})).toBeNull();
    expect(extractCspReport([])).toBeNull();
    expect(extractCspReport({ nonsense: 1 })).toBeNull();
    expect(extractCspReport([{ type: "deprecation", body: {} }])).toBeNull();
    expect(extractCspReport("a string")).toBeNull();
    expect(extractCspReport(null)).toBeNull();
  });

  it("never persists script-sample under any key", () => {
    // Privacy call: script-sample can carry inline-script fragments from a page
    // that handles a credential. A violation is diagnosable without it.
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://play.skyphusion.org/",
        "script-sample": "const token = 'SUPER SECRET VALUE'",
        "effective-directive": "script-src",
      },
    });
    expect(r).not.toBeNull();
    expect(JSON.stringify(r)).not.toContain("SUPER SECRET");
    expect(Object.keys(r!)).not.toContain("script_sample");
  });

  it("caps every string field against a hostile oversized report", () => {
    const huge = "z".repeat(9000);
    const r = extractCspReport({
      "csp-report": {
        "document-uri": huge,
        referrer: huge,
        "violated-directive": huge,
        "effective-directive": huge,
        "blocked-uri": huge,
        disposition: huge,
        "source-file": huge,
      },
    })!;
    expect(r.referrer!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.referrer);
    expect(r.violated_directive!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.violated_directive);
    expect(r.effective_directive!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.effective_directive);
    expect(r.blocked_uri!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.blocked_uri);
    expect(r.disposition!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.disposition);
    expect(r.source_file!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.source_file);
    expect(r.document_uri!.length).toBeLessThanOrEqual(CSP_FIELD_CAPS.document_uri);
  });

  it("refuses non-numeric and out-of-range numerics rather than coercing", () => {
    const r = extractCspReport({
      "csp-report": {
        "document-uri": "https://x.example/",
        "status-code": "200",
        "line-number": -5,
        "column-number": 1e12,
      },
    })!;
    expect(r.status_code).toBeNull();
    expect(r.line_number).toBeNull();
    expect(r.column_number).toBeNull();
  });

  it("exports a body cap that is bounded and non-trivial", () => {
    expect(CSP_REPORT_MAX_BYTES).toBeGreaterThan(1024);
    expect(CSP_REPORT_MAX_BYTES).toBeLessThanOrEqual(65536);
  });
});

// ---------------------------------------------------------------------------
// SOURCE GUARDS FOR THE INLINE-CSS SURFACES (fleet-chezmoi#1646).
//
// The report-only collector observed exactly one of these, because it can only
// observe a page somebody loaded. These assert on the served files themselves,
// so a re-introduced inline style is a red test rather than a violation nobody
// happens to trip. Every matcher runs its positive control FIRST: a matcher
// that has stopped matching returns zero, and zero reads exactly like clean.
// ---------------------------------------------------------------------------
describe("the served documents carry no inline CSS", () => {
  const pub = (f: string) =>
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../public/", f), "utf8");

  const INLINE_STYLE_ATTR = /<[a-z][^>]*\sstyle\s*=\s*["']/i;
  const INLINE_STYLE_ELEM = /<style[\s>]/i;

  it("control: both matchers fire on a subject known to contain the thing", () => {
    expect(INLINE_STYLE_ATTR.test('<a class="x" style="left:-1px">y</a>')).toBe(true);
    expect(INLINE_STYLE_ELEM.test("<head>\n  <style>\n  .a { color: red; }\n  </style>")).toBe(true);
    // Negative half: neither may fire on the shape that must be allowed through.
    expect(INLINE_STYLE_ATTR.test('<link rel="stylesheet" href="/stt.css">')).toBe(false);
    expect(INLINE_STYLE_ELEM.test('<link rel="stylesheet" href="/styles.css">')).toBe(false);
  });

  // index.html:47 was the collector's first genuine finding:
  //   style-src-attr | inline | line 47. The offscreen positioning moved to a
  // stylesheet rule, where it stays. fc#1700 then renamed that rule from
  // `.seo-skip` to `.skip-link` and gave it the `:focus` reveal it never had;
  // the CSP invariant asserted here is unchanged by that, and the element is
  // still the first focusable element in the body. The accessibility half is
  // asserted in tests/skip-link.test.ts, not here.
  it("index.html has no inline style attribute", () => {
    expect(INLINE_STYLE_ATTR.test(pub("index.html"))).toBe(false);
  });

  it("index.html has no inline <style> element", () => {
    expect(INLINE_STYLE_ELEM.test(pub("index.html"))).toBe(false);
  });

  // stt.html carried a 19-rule inline <style> block. It never reported, because
  // the STT document was serving with no policy header at all (see below), so
  // an enforcing promotion would have taken the whole page layout with nothing
  // in the collector having predicted it.
  it("stt.html has no inline <style> element", () => {
    expect(INLINE_STYLE_ELEM.test(pub("stt.html"))).toBe(false);
  });

  it("stt.html has no inline style attribute", () => {
    expect(INLINE_STYLE_ATTR.test(pub("stt.html"))).toBe(false);
  });

  it("the rules stt.html used to inline are still served, from stt.css", () => {
    const css = pub("stt.css");
    expect(pub("stt.html")).toContain('<link rel="stylesheet" href="/stt.css">');
    for (const sel of [".stt-layout", ".stt-controls", "#stt-start", ".stt-live", ".stt-debug"]) {
      expect(css).toContain(sel);
    }
  });

  it("the offscreen positioning the skip link lost is present in styles.css", () => {
    const css = pub("styles.css");
    expect(css).toMatch(/\.skip-link\s*\{[^}]*position:\s*absolute/);
    expect(css).toMatch(/\.skip-link\s*\{[^}]*left:\s*-9999px/);
    expect(pub("index.html")).toContain('class="skip-link"');
    // No inline style attribute crept back onto the element itself.
    expect(pub("index.html")).not.toMatch(/<a class="skip-link"[^>]*\sstyle\s*=/);
  });
});

// WHAT THIS GUARD CANNOT SEE, stated here rather than in a PR comment: it reads
// the TEMPLATE. `wrangler.toml` is gitignored and per-deployer, so a green run
// says the template is right and says nothing about any live deploy. Confirming
// the header on the wire is a separate act and stays one.
describe("run_worker_first names the paths the documents are actually served at", () => {
  const toml = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "../wrangler.example.toml"),
    "utf8",
  );

  it("control: the setting is present in the template at all", () => {
    expect(toml).toContain("run_worker_first");
  });

  // MEASURED on a local dev server, not reasoned: `/stt.html` answers
  // `307 -> /stt`, and `/stt` answered `200 text/html` with NO policy header
  // while only the redirecting spelling was listed. Workers Assets drops the
  // `.html` by default, so the extensionless path is the one a browser holds
  // the document at. A listed path that only redirects fails silently: the page
  // carries no policy, reports nothing, and an empty collector reads as clean.
  it("covers the extensionless STT path, not only the redirecting one", () => {
    const line = toml.split("\n").find((l) => l.trim().startsWith("run_worker_first"));
    expect(line, "run_worker_first line not found in the template").toBeDefined();
    expect(line).toContain('"/stt"');
  });

  it("still covers the root document", () => {
    const line = toml.split("\n").find((l) => l.trim().startsWith("run_worker_first"));
    expect(line).toContain('"/"');
  });
});
