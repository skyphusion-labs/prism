import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { searchWeb } from "../src/routes/rag";
import {
  askSkyphusionSearch,
  mapAskChunks,
  parseAskSse,
  type SearchBinding,
} from "../src/skyphusion-search";

const WIKI_HIT = {
  query: {
    search: [{ title: "Ada Lovelace", snippet: "Mathematician", pageid: 42 }],
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

function chunkSse(): string {
  const chunks = [{
    text: "  prism   workers ",
    score: 0.42,
    item: {
      key: "prism/README.md.txt",
      metadata: { repo: "prism", path: "README.md" },
    },
  }];
  return `event: chunks\ndata: ${JSON.stringify(chunks)}\n\ndata: [DONE]\n\n`;
}

function binding(fetchImpl: SearchBinding["fetch"]): Env {
  return { SEARCH: { fetch: fetchImpl } } as unknown as Env;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseAskSse / mapAskChunks", () => {
  it("maps a chunks event into a github citation and ignores answer deltas", () => {
    const body = [
      chunkSse().trimEnd(),
      'data: {"choices":[{"delta":{"content":"answer"}}]}',
      "",
    ].join("\n\n");
    const hits = mapAskChunks(parseAskSse(body), 5);
    expect(hits).toEqual([{
      title: "prism/README.md",
      url: "https://github.com/skyphusion-labs/prism/blob/main/README.md",
      snippet: "prism workers",
      score: 0.42,
    }]);
  });

  it("treats an error event as a failure, not as zero hits", () => {
    const body = 'event: chunks\ndata: [{"text":"x","item":{"key":"prism/README.md"}}]\n\nevent: error\ndata: {"error":"upstream"}\n\n';
    expect(() => parseAskSse(body)).toThrow(/stream error: upstream/);
  });

  it("drops a chunk whose path is not a safe corpus path", () => {
    expect(mapAskChunks([{
      text: "nope",
      item: { key: "prism/../etc/passwd", metadata: { repo: "prism", path: "../etc/passwd" } },
    }], 5)).toEqual([]);
  });
});

describe("searchWeb sources", () => {
  it("binding returns hits", async () => {
    const wiki = installWikipediaFetch();
    let seen: { url: string; init: RequestInit } | undefined;
    const env = binding(async (input, init) => {
      seen = {
        url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
        init: init ?? {},
      };
      return new Response(chunkSse(), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    });
    const out = await searchWeb(env, "prism workers");
    expect(seen?.url).toBe("https://skyphusion-search/ask");
    expect(seen?.init.method).toBe("POST");
    const headers = seen?.init.headers as Record<string, string>;
    expect(headers.origin).toBe("https://skyphusion.net");
    expect(JSON.parse(String(seen?.init.body))).toEqual({ question: "prism workers" });
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

  it("binding errors: status failed, Wikipedia still answers", async () => {
    const wiki = installWikipediaFetch();
    const env = binding(async () => new Response(
      JSON.stringify({ error: "search_unavailable" }),
      { status: 502, headers: { "content-type": "application/json" } },
    ));
    const out = await searchWeb(env, "prism workers");
    expect(out.sources.web.status).toBe("failed");
    expect(out.sources.web.count).toBe(0);
    expect(out.sources.web.error).toBe("skyphusion-search 502: search_unavailable");
    expect(out.error).toBe("skyphusion-search 502: search_unavailable");
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

  it("a 2xx stream with no chunks is zero hits, not a failure", async () => {
    installWikipediaFetch();
    const env = binding(async () => new Response("data: [DONE]\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const out = await searchWeb(env, "prism workers");
    expect(out.sources.web).toEqual({ status: "ok", count: 0 });
    expect(out.error).toBeNull();
    expect(out.results.map((r) => r.source)).toEqual(["wikipedia"]);
  });
});

describe("askSkyphusionSearch", () => {
  it("sends only the question field and caps it at 2000 characters", async () => {
    let body = "";
    const bindingFetch: SearchBinding["fetch"] = async (_input, init) => {
      body = String(init?.body ?? "");
      return new Response("data: [DONE]\n\n", {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
    const question = "q".repeat(2005);
    await askSkyphusionSearch({ fetch: bindingFetch }, question, {
      timeoutMs: 1000,
      maxResults: 5,
      origin: "https://skyphusion.net",
    });
    expect(JSON.parse(body).question).toHaveLength(2000);
    expect(JSON.parse(body).turnstileToken).toBeUndefined();
  });
});
