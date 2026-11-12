// prism#233: operator logs never carry a user identity.
//
// Two layers. A behavioural test drives a shipped log path with an access-mode identity. A source
// guard reads every console.* call in src/ (the whole argument list, across lines) and fails if it
// interpolates an identity variable. The guard is a string match, so it catches the common shape
// (`${userEmail}` in a log template), not every possible leak; the behavioural tests are the proof
// for the paths they drive.

import { describe, it, expect, vi, afterEach } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { resolveProjectForChat } from "../src/routes/projects";
import type { Env } from "../src/env";

const EMAIL = "carol@example.net";

afterEach(() => vi.restoreAllMocks());

/** Every console.* call in `text`, with its full argument list (balanced parens). */
export function consoleCalls(text: string): string[] {
  const out: string[] = [];
  const re = /console\.(?:warn|log|error|info|debug)\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    let depth = 1;
    let i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
    }
    out.push(text.slice(m.index, i));
  }
  return out;
}

const IDENTITY_IN_LOG = /\$\{\s*(?:userEmail|email|identity|user_email)\b|user_email='/;

function srcFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
  });
}

describe("source guard: no console.* call interpolates an identity", () => {
  const files = srcFiles(join(__dirname, "..", "src"));

  it("scans a real denominator", () => {
    const calls = files.flatMap((f) => consoleCalls(readFileSync(f, "utf8")));
    expect(files.length).toBeGreaterThan(20);
    expect(calls.length).toBeGreaterThanOrEqual(5);
  });

  it("finds none in src/", () => {
    const hits = files.flatMap((f) =>
      consoleCalls(readFileSync(f, "utf8"))
        .filter((c) => IDENTITY_IN_LOG.test(c))
        .map((c) => `${f}: ${c.slice(0, 120)}`),
    );
    expect(hits).toEqual([]);
  });

  it("NEGATIVE CONTROL: goes red on both pre-prism#233 log shapes, across lines", () => {
    const zeroJoin = "console.warn(\n  \"retrieveContext:\",\n  `Vectorize returned ${n} matches. user_email='${userEmail}', sample`,\n);";
    const project = "console.warn(\n  `Chat referenced unknown project_id=${id} for user_email='${userEmail}'; ` +\n  `falling back`\n);";
    for (const src of [zeroJoin, project]) {
      const calls = consoleCalls(src);
      expect(calls).toHaveLength(1);
      expect(IDENTITY_IN_LOG.test(calls[0])).toBe(true);
    }
    expect(IDENTITY_IN_LOG.test("console.warn(`zero-join matches=${n} held_by_caller=${own}`)")).toBe(false);
  });
});

describe("resolveProjectForChat: unknown project log", () => {
  it("names the opaque project id and not the caller", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = {
      DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
    } as unknown as Env;
    const r = await resolveProjectForChat(env, EMAIL, { project_id: 77 } as never);
    expect(r.project).toBeNull();
    const log = warn.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(log).not.toContain(EMAIL);
    expect(log).not.toMatch(/@/);
    expect(log).toContain("project_id=77");
  });
});
