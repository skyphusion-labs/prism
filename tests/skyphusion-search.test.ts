import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { searchWeb } from "../src/routes/rag";
import { mapSearchChunks } from "../src/skyphusion-search";

const RPC_ERRORS = [
  "empty_question",
  "question_too_long",
  "rate_limited",
  "search_unavailable",
] as const;

const WIKI_HIT = {
  query: {
    search: [{ title: "Ada Lovelace", snippet: "Mathematician", pageid: 42 }],
  },
};

const CHUNK = {
  text: "  prism   workers ",
  score: 0.42,
  item: {
    key: "prism/README.md.txt",
    metadata: { repo: "prism", path: "README.md" },
  },
};

function wikiResponse(): Response {
  return new Response(JSON.stringify(WIKI_HIT), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function installWikipediaFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
    if (!url.includes("https://en.wikipedia.org/w/api.php")) {
      throw new Error(`unexpected global fetch: ${url}`);
    }
    return wikiResponse();
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function binding(search: (question: string) => Promise<{ chunks: unknown[] }>): Env {
  return { SEARCH: { search } } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("mapSearchChunks", () => {
  it("maps a chunk to a github blob link", () => {
    expect(mapSearchChunks([CHUNK], 5)).toEqual([{
      title: "prism/README.md",
      url: "https://github.com/skyphusion-labs/prism/blob/main/README.md",
      snippet: "prism workers",
      score: 0.42,
    }]);
  });

  it("drops a chunk whose path is not a safe corpus path", () => {
    expect(mapSearchChunks([{
      text: "nope",
      item: { key: "prism/../etc/passwd", metadata: { repo: "prism", path: "../etc/passwd" } },
    }], 5)).toEqual([]);
  });
});

describe("searchWeb sources", () => {
  it("binding returns hits", async () => {
    const wiki = installWikipediaFetch();
    const search = vi.fn(async (_question: string) => ({ chunks: [CHUNK] }));
    const out = await searchWeb(binding(search), "prism workers");
    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0]).toEqual(["prism workers"]);
    expect(out.error).toBeNull();
    expect(out.sources.web).toEqual({ status: "ok", count: 1 });
    expect(out.sources.wikipedia.status).toBe("ok");
    expect(out.sources.wikipedia.count).toBe(1);
    expect(out.results.map((r) => r.source)).toEqual(["skyphusion-search", "wikipedia"]);
    expect(out.results[0]).toMatchObject({
      title: "prism/README.md",
      url: "https://github.com/skyphusion-labs/prism/blob/main/README.md",
      snippet: "prism workers",
    });
    expect(out.results[1]).toMatchObject({
      title: "Ada Lovelace",
      url: "https://en.wikipedia.org/?curid=42",
    });
    expect(wiki).toHaveBeenCalled();
  });

  it.each(RPC_ERRORS)("%s: web source failed, Wikipedia still answers", async (code) => {
    const wiki = installWikipediaFetch();
    const search = vi.fn(async () => {
      throw new Error(code);
    });
    const out = await searchWeb(binding(search), "prism workers");
    expect(search).toHaveBeenCalledTimes(1);
    expect(out.sources.web).toEqual({ status: "failed", count: 0, error: code });
    expect(out.error).toBe(code);
    expect(out.sources.wikipedia).toEqual({ status: "ok", count: 1 });
    expect(out.results.map((r) => r.source)).toEqual(["wikipedia"]);
    expect(wiki).toHaveBeenCalled();
  });

  it("a thrown binding is failed and does not clear Wikipedia", async () => {
    installWikipediaFetch();
    const env = binding(async () => {
      throw new Error("binding down");
    });
    const out = await searchWeb(env, "prism workers");
    expect(out.sources.web).toEqual({ status: "failed", count: 0, error: "binding down" });
    expect(out.results.map((r) => r.source)).toEqual(["wikipedia"]);
  });

  it("binding absent is not a failure and not zero hits", async () => {
    const wiki = installWikipediaFetch();
    const out = await searchWeb({} as Env, "prism workers");
    expect(out.sources.web).toEqual({ status: "absent", count: 0 });
    expect(out.error).toBeNull();
    expect(out.sources.wikipedia).toEqual({ status: "ok", count: 1 });
    expect(out.results.map((r) => r.source)).toEqual(["wikipedia"]);
    expect(wiki).toHaveBeenCalled();
  });

  it("an empty chunks array is zero hits, not a failure", async () => {
    installWikipediaFetch();
    const env = binding(async () => ({ chunks: [] }));
    const out = await searchWeb(env, "prism workers");
    expect(out.sources.web).toEqual({ status: "ok", count: 0 });
    expect(out.error).toBeNull();
    expect(out.results.map((r) => r.source)).toEqual(["wikipedia"]);
  });
});
