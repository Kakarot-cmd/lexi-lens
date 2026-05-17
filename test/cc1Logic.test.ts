/**
 * cc1Logic.test.ts — CC1 child-safety + canonical sanitisation
 *
 * Why this matters: sanitizeOutput is the LAST line of defense before a
 * canonical is cached and shown to a child. The model prompt forbids
 * human-body and generic outputs, but models drift — this guard must
 * hold regardless. These tests pin that contract.
 */

import {
  sanitizeOutput,
  GENERIC_LABELS,
  HUMAN_BODY_BLOCKLIST,
} from "./cc1Logic";

describe("cc1.sanitizeOutput — child-safety override", () => {
  it("forces every human-body term to \"object\" and drops aliases", () => {
    for (const term of HUMAN_BODY_BLOCKLIST) {
      const out = sanitizeOutput({ canonical: term, aliases: ["x", "y"] });
      expect(out.canonical).toBe("object");
      expect(out.aliases).toEqual([]);
    }
  });

  it("catches human-body term even behind a leading article", () => {
    const out = sanitizeOutput({ canonical: "the face", aliases: ["smile"] });
    expect(out.canonical).toBe("object");
    expect(out.aliases).toEqual([]);
  });

  it("strips a human-body alias from an otherwise-safe canonical", () => {
    const out = sanitizeOutput({ canonical: "mirror", aliases: ["face", "glass"] });
    expect(out.canonical).toBe("mirror");
    expect(out.aliases).not.toContain("face");
    expect(out.aliases).toContain("glass");
  });
});

describe("cc1.sanitizeOutput — generic collapse", () => {
  it("maps every generic label to \"object\"", () => {
    for (const g of GENERIC_LABELS) {
      const out = sanitizeOutput({ canonical: g, aliases: ["banana"] });
      expect(out.canonical).toBe("object");
      expect(out.aliases).toEqual([]);
    }
  });

  it("treats empty/whitespace canonical as generic", () => {
    expect(sanitizeOutput({ canonical: "   ", aliases: [] }).canonical).toBe("object");
  });
});

describe("cc1.sanitizeOutput — happy path & hygiene", () => {
  it("preserves a legitimate canonical and cleans aliases", () => {
    const out = sanitizeOutput({
      canonical: "a red apple",
      aliases: ["the fruit", "apple", "object", ""],
    });
    expect(out.canonical).toBe("red apple");
    expect(out.aliases).toContain("fruit");
    expect(out.aliases).not.toContain("object");
    expect(out.aliases).not.toContain("");
    expect(out.aliases).not.toContain("red apple"); // alias == canonical removed
  });

  it("is idempotent — sanitising twice changes nothing", () => {
    const once = sanitizeOutput({ canonical: "the wooden spoon", aliases: ["spoon"] });
    const twice = sanitizeOutput(once);
    expect(twice).toEqual(once);
  });
});
