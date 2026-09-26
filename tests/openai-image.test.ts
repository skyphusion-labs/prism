// Unit tests for OpenAI transparent-PNG BYOK body shape (v0.174.0).
// Network is stubbed; we only assert the request OpenAI receives.

import { describe, it, expect, vi, afterEach } from "vitest";
import { generateOpenAIImage, resolveOpenAIImageKey } from "../src/providers/openai-image";
import type { Env } from "../src/env";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateOpenAIImage", () => {
  it("POSTs transparent png params to api.openai.com and strips openai/ prefix", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ b64_json: "aGVsbG8=" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const gen = await generateOpenAIImage("sk-test", "openai/gpt-image-1.5", "a coin");
    expect(gen.mime).toBe("image/png");
    expect(gen.bytes.length).toBeGreaterThan(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({
      model: "gpt-image-1.5",
      prompt: "a coin",
      size: "1024x1024",
      quality: "high",
      background: "transparent",
      output_format: "png",
    });
  });

  it("surfaces OpenAI error status + message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ error: { message: "billing hard limit" } }), { status: 429 }),
    ));
    await expect(generateOpenAIImage("sk-test", "openai/gpt-image-2", "x"))
      .rejects.toThrow(/OpenAI image API 429: billing hard limit/);
  });
});

// prism#193 (v1.0.5): the deployer key is off-limits in public mode.
describe("resolveOpenAIImageKey", () => {
  const envOf = (e: Partial<Env>) => e as Env;

  it("returns null in public mode even when OPENAI_API_KEY is set", () => {
    expect(resolveOpenAIImageKey(envOf({ AUTH_MODE: "public", OPENAI_API_KEY: "sk-host" }))).toBeNull();
  });

  it("returns the key in access mode and when AUTH_MODE is unset", () => {
    expect(resolveOpenAIImageKey(envOf({ AUTH_MODE: "access", OPENAI_API_KEY: "sk-host" }))).toBe("sk-host");
    expect(resolveOpenAIImageKey(envOf({ OPENAI_API_KEY: "sk-host" }))).toBe("sk-host");
  });

  it("returns null when the key is unset or blank", () => {
    expect(resolveOpenAIImageKey(envOf({}))).toBeNull();
    expect(resolveOpenAIImageKey(envOf({ OPENAI_API_KEY: "  " }))).toBeNull();
  });
});
