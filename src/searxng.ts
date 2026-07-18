// SearXNG web retrieval (v0.166.0).
//
// Self-hosted metasearch source, slotted in beside the keyless Wikipedia
// retriever (replacing the retired Tavily + Brave SaaS sources, prism#93).
// Requests the JSON API: GET {SEARXNG_URL}/search?q=...&format=json.
//
// When the instance is gated by Cloudflare Access (our deploy at
// search.skyphusion.org is), a per-function Access service token is sent as
// the standard CF-Access-Client-Id / CF-Access-Client-Secret headers. A
// self-hoster running an un-gated instance sets neither, and no Access headers
// are sent.

export interface SearxngHit {
  title: string;
  url: string;
  snippet: string;
}

// Pure parser for the SearXNG JSON response. The relevant shape is
// { results: [ { url, title, content }, ... ] }; other top-level keys
// (query, number_of_results, suggestions, ...) are ignored. Rows missing a
// url or title are dropped; content is the snippet (may be absent).
export function mapSearxngResults(data: unknown, maxResults: number): SearxngHit[] {
  const root = data as {
    results?: Array<{ title?: string; url?: string; content?: string }>;
  };
  const items = root.results ?? [];
  return items
    .filter((r) => r.url && r.title)
    .slice(0, maxResults)
    .map((r) => ({
      title: r.title!,
      url: r.url!,
      snippet: normalizeSearxngSnippet(r.content ?? ""),
    }));
}

function normalizeSearxngSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export async function searchSearxngWeb(
  baseUrl: string,
  query: string,
  opts: {
    maxResults: number;
    timeoutMs: number;
    accessClientId?: string;
    accessClientSecret?: string;
  },
): Promise<SearxngHit[]> {
  // baseUrl may or may not carry a trailing slash; URL() with an absolute
  // "/search" path normalizes either way.
  const url = new URL("/search", baseUrl);
  url.searchParams.set("q", query);
  url.searchParams.set("format", "json");

  const headers: Record<string, string> = { Accept: "application/json" };
  // Access service-token headers are sent ONLY when both halves are set, so an
  // un-gated self-hosted instance is reached with no headers.
  if (opts.accessClientId && opts.accessClientSecret) {
    headers["CF-Access-Client-Id"] = opts.accessClientId;
    headers["CF-Access-Client-Secret"] = opts.accessClientSecret;
  }

  const resp = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  if (!resp.ok) {
    throw new Error(`SearXNG ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  }
  const data: unknown = await resp.json();
  return mapSearxngResults(data, opts.maxResults);
}
