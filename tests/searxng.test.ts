import { describe, it, expect } from "vitest";
import { mapSearxngResults } from "../src/searxng";

describe("mapSearxngResults", () => {
  it("maps results into title/url/snippet hits", () => {
    const data = {
      query: "cloudflare workers",
      number_of_results: 2,
      results: [
        { title: "Example", url: "https://example.com/a", content: "First hit." },
        { title: "Other", url: "https://example.com/b", content: "Second hit." },
      ],
    };
    expect(mapSearxngResults(data, 5)).toEqual([
      { title: "Example", url: "https://example.com/a", snippet: "First hit." },
      { title: "Other", url: "https://example.com/b", snippet: "Second hit." },
    ]);
  });

  it("drops rows missing title or url and respects maxResults", () => {
    const data = {
      results: [
        { title: "Keep", url: "https://example.com/keep", content: "ok" },
        { title: "No URL", content: "skip" },
        { url: "https://example.com/no-title", content: "skip" },
        { title: "Third", url: "https://example.com/third", content: "ok" },
      ],
    };
    expect(mapSearxngResults(data, 1)).toEqual([
      { title: "Keep", url: "https://example.com/keep", snippet: "ok" },
    ]);
  });

  it("collapses whitespace in snippets and tolerates a missing content field", () => {
    const data = {
      results: [
        { title: "Spacey", url: "https://example.com/s", content: "  multi   line\n\ttext " },
        { title: "NoContent", url: "https://example.com/n" },
      ],
    };
    expect(mapSearxngResults(data, 5)).toEqual([
      { title: "Spacey", url: "https://example.com/s", snippet: "multi line text" },
      { title: "NoContent", url: "https://example.com/n", snippet: "" },
    ]);
  });

  it("returns an empty array when results is missing", () => {
    expect(mapSearxngResults({}, 5)).toEqual([]);
    expect(mapSearxngResults({ results: [] }, 5)).toEqual([]);
  });
});
