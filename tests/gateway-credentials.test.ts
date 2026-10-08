import { describe, expect, it } from "vitest";
import {
  buildGatewayStatus,
  gatewaySource,
  isValidGatewayId,
  maskSecret,
  normalizeAccountId,
  resolveGateway,
  resolveGatewayFromParts,
} from "../src/gateway-credentials";
import type { Env } from "../src/env";

function env(partial: Partial<Env> = {}): Env {
  return partial as Env;
}

const VALID_PCP = `pcp_${"a".repeat(16)}_${"A".repeat(43)}`;

describe("resolveGatewayFromParts", () => {
  it("returns null when no gateway id is available", () => {
    expect(resolveGatewayFromParts(null, env())).toBeNull();
    expect(resolveGatewayFromParts({ gateway_id: "  " }, env())).toBeNull();
  });

  it("merges user prefs over worker secrets field-by-field", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw", cf_aig_token: "user-token" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "user-token", accountId: null });
  });

  it("falls back to worker secrets for unset user fields", () => {
    const resolved = resolveGatewayFromParts(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(resolved).toEqual({ gatewayId: "user-gw", cfAigToken: "worker-token", accountId: null });
  });
});

describe("gatewaySource", () => {
  it("labels pure user credentials", () => {
    expect(gatewaySource(
      { gateway_id: "gw", cf_aig_token: "tok" },
      env(),
    )).toBe("user");
  });

  it("labels worker-only credentials", () => {
    expect(gatewaySource(null, env({ GATEWAY_ID: "gw" }))).toBe("worker");
  });

  it("labels mixed overrides", () => {
    expect(gatewaySource(
      { gateway_id: "user-gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    )).toBe("mixed");
  });
});

describe("maskSecret", () => {
  it("masks long secrets with trailing preview", () => {
    expect(maskSecret("abcdefghijklmnop")).toBe("••••••••••••mnop");
  });

  it("returns null for empty values", () => {
    expect(maskSecret(undefined)).toBeNull();
    expect(maskSecret("   ")).toBeNull();
  });
});

describe("buildGatewayStatus", () => {
  it("is unconfigured with no gateway and no pcp_ key", () => {
    const s = buildGatewayStatus(null, env());
    expect(s.configured).toBe(false);
    expect(s.control_plane_configured).toBe(false);
    expect(s.control_plane_key_set).toBe(false);
  });

  it("access mode: counts gateway id alone as configured (host-account binding)", () => {
    const s = buildGatewayStatus({ gateway_id: "my-gw" }, env());
    expect(s.configured).toBe(true);
    expect(s.gateway_id).toBe("my-gw");
    expect(s.control_plane_configured).toBe(false);
  });

  it("counts a pcp_ key alone as configured (no gateway slug)", () => {
    // Hard-refresh boot probe used to miss this: loadGatewayStatus only looked
    // at gateway id, so the SPA banner said "configure instance" while prefs
    // still showed control-plane mode on.
    const s = buildGatewayStatus({ control_plane_key: VALID_PCP }, env());
    expect(s.configured).toBe(true);
    expect(s.control_plane_configured).toBe(true);
    expect(s.control_plane_key_set).toBe(true);
    expect(s.gateway_id).toBeNull();
  });

  it("rejects a malformed pcp_ key", () => {
    const s = buildGatewayStatus({ control_plane_key: "pcp_not_valid" }, env());
    expect(s.configured).toBe(false);
    expect(s.control_plane_configured).toBe(false);
    expect(s.control_plane_key_set).toBe(true);
  });
});

// v1.1.0: the account id is what routes a call to the user's own gateway. The
// AI binding can only reach this worker's account, so user credentials without
// one must never resolve in public mode.
const ACCT = "0123456789abcdef0123456789abcdef";
const PUBLIC = { AUTH_MODE: "public" } as Partial<Env>;

describe("normalizeAccountId / isValidGatewayId", () => {
  it("accepts 32 hex and lowercases", () => {
    expect(normalizeAccountId(ACCT)).toBe(ACCT);
    expect(normalizeAccountId(` ${ACCT.toUpperCase()} `)).toBe(ACCT);
  });

  it("rejects anything that is not 32 hex", () => {
    for (const bad of ["", "abc", ACCT + "0", ACCT.slice(1) + "g", "../" + ACCT.slice(3), null, undefined]) {
      expect(normalizeAccountId(bad as string)).toBeNull();
    }
  });

  it("pins the gateway slug charset (it becomes a URL segment and a header)", () => {
    expect(isValidGatewayId("my-gw_1")).toBe(true);
    for (const bad of ["", "../other", "a/b", "gw?x=1", "-lead", "a".repeat(65), "gw\r\nx: y"]) {
      expect(isValidGatewayId(bad)).toBe(false);
    }
  });
});

describe("resolveGateway (v1.1.0 account scoping)", () => {
  it("public mode: slug + token without an account id is refused, not resolved on our binding", () => {
    const r = resolveGateway({ gateway_id: "gw", cf_aig_token: "tok" }, env(PUBLIC));
    expect(r.creds).toBeNull();
    expect(r.problem).toBe("gateway_account_id_required");
  });

  it("public mode: a lone slug (the pre-v1.1.0 minimum) is also account_id_required", () => {
    expect(resolveGateway({ gateway_id: "gw" }, env(PUBLIC)).problem).toBe("gateway_account_id_required");
  });

  it("public mode: nothing saved is plain not-configured", () => {
    expect(resolveGateway(null, env(PUBLIC)).problem).toBe("gateway_not_configured");
  });

  it("resolves full user credentials to the user's account", () => {
    const r = resolveGateway({ account_id: ACCT, gateway_id: "gw", cf_aig_token: "tok" }, env(PUBLIC));
    expect(r).toEqual({ creds: { gatewayId: "gw", cfAigToken: "tok", accountId: ACCT }, problem: null });
  });

  it("requires the token once an account id is set (REST needs it for every call)", () => {
    const r = resolveGateway({ account_id: ACCT, gateway_id: "gw" }, env(PUBLIC));
    expect(r.problem).toBe("cf_aig_token_required");
  });

  it("requires the slug once an account id is set", () => {
    const r = resolveGateway({ account_id: ACCT, cf_aig_token: "tok" }, env(PUBLIC));
    expect(r.problem).toBe("gateway_not_configured");
  });

  it("access mode: an account-scoped user never borrows worker secrets", () => {
    const r = resolveGateway(
      { account_id: ACCT, gateway_id: "gw" },
      env({ GATEWAY_ID: "worker-gw", CF_AIG_TOKEN: "worker-token" }),
    );
    expect(r.creds).toBeNull();
    expect(r.problem).toBe("cf_aig_token_required");
  });

  it("an invalid stored account id is treated as absent (public: refused)", () => {
    const r = resolveGateway({ account_id: "nope", gateway_id: "gw", cf_aig_token: "tok" }, env(PUBLIC));
    expect(r.problem).toBe("gateway_account_id_required");
  });
});

describe("buildGatewayStatus (v1.1.0)", () => {
  it("flags a pre-v1.1.0 public user and still echoes their saved slug", () => {
    const s = buildGatewayStatus({ gateway_id: "gw", cf_aig_token: "tok" }, env(PUBLIC));
    expect(s.configured).toBe(false);
    expect(s.account_id_required).toBe(true);
    expect(s.gateway_id).toBe("gw");
    expect(s.cf_aig_token_set).toBe(true);
    expect(s.account_id).toBeNull();
  });

  it("is configured with all three, account id echoed", () => {
    const s = buildGatewayStatus({ account_id: ACCT, gateway_id: "gw", cf_aig_token: "tok" }, env(PUBLIC));
    expect(s.configured).toBe(true);
    expect(s.account_id_required).toBe(false);
    expect(s.account_id).toBe(ACCT);
  });

  it("a pcp_ key alone still configures a pre-v1.1.0 user (chat via control plane)", () => {
    const s = buildGatewayStatus({ gateway_id: "gw", control_plane_key: VALID_PCP }, env(PUBLIC));
    expect(s.configured).toBe(true);
    expect(s.account_id_required).toBe(true);
  });
});
