import { describe, expect, it, vi } from "vitest";
import { probeD1Schema, REQUIRED_D1_TABLES } from "../src/health-schema";

describe("probeD1Schema", () => {
  it("reports ok when every required table exists", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: (...names: string[]) => ({
          all: async () => ({
            results: names.map((name) => ({ name })),
          }),
        }),
      })),
    } as unknown as D1Database;

    const result = await probeD1Schema(db);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(REQUIRED_D1_TABLES).toContain("user_prefs");
  });

  it("lists missing tables", async () => {
    const db = {
      prepare: vi.fn(() => ({
        bind: () => ({
          all: async () => ({ results: [{ name: "chats" }] }),
        }),
      })),
    } as unknown as D1Database;

    const result = await probeD1Schema(db);
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("user_prefs");
  });
});
