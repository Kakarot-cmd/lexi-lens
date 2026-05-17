/**
 * revenuecatWebhook.test.ts — RC entitlement → schema tier mapping
 *
 * Pins tierFromProductId against the REAL Product IDs this project
 * actually registered (incl. the asymmetric annual IDs that caused
 * real pain during RC setup). A regression here is invisible until a
 * customer complains they paid and didn't unlock.
 */

import { tierFromProductId } from "./revenuecatWebhook";

describe("rc.tierFromProductId — real registered Product IDs", () => {
  it("maps both monthly variants (Apple + Google) to tier1", () => {
    expect(tierFromProductId("lexilens_premium_monthly")).toBe("tier1");
    expect(tierFromProductId("lexilens_premium_monthly:monthly-v2")).toBe("tier1");
  });

  it("maps the asymmetric annual IDs (Apple v2 + Google base-plan) to tier1", () => {
    expect(tierFromProductId("lexilens_premium_annual_v2")).toBe("tier1");
    expect(tierFromProductId("lexilens_premium_annual:annual")).toBe("tier1");
  });

  it("routes family-tier products to family regardless of period", () => {
    expect(tierFromProductId("lexilens_family_monthly")).toBe("family");
    expect(tierFromProductId("lexilens_family_annual:annual")).toBe("family");
  });

  it("routes a hypothetical pro tier to tier2", () => {
    expect(tierFromProductId("lexilens_pro_monthly")).toBe("tier2");
  });
});

describe("rc.tierFromProductId — precedence & edge cases", () => {
  it("is case-insensitive", () => {
    expect(tierFromProductId("LEXILENS_FAMILY_MONTHLY")).toBe("family");
    expect(tierFromProductId("LexiLens_Premium_Annual_V2")).toBe("tier1");
  });

  it("family wins over pro when both substrings somehow appear", () => {
    // documents current precedence: family check runs before pro
    expect(tierFromProductId("family_pro_bundle")).toBe("family");
  });

  it("null / undefined / empty → free (no entitlement)", () => {
    expect(tierFromProductId(null)).toBe("free");
    expect(tierFromProductId(undefined)).toBe("free");
    expect(tierFromProductId("")).toBe("free");
  });

  it("unknown non-empty product defaults to tier1, never free", () => {
    // intentional design: any active entitlement grants at least tier1
    expect(tierFromProductId("some_unmapped_sku")).toBe("tier1");
  });
});
