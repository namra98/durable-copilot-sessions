import { describe, expect, it } from "vitest";
import { fuzzyMatch, fuzzyRank } from "./fuzzy";

describe("fuzzyMatch", () => {
  it("treats an empty query as a neutral match", () => {
    const r = fuzzyMatch("", "anything");
    expect(r.matched).toBe(true);
    expect(r.score).toBe(1);
    expect(r.positions).toEqual([]);
  });

  it("matches a subsequence case-insensitively and records positions", () => {
    const r = fuzzyMatch("ot", "Open Terminals");
    expect(r.matched).toBe(true);
    expect(r.positions).toEqual([0, 5]);
  });

  it("rejects characters that are out of order", () => {
    expect(fuzzyMatch("to", "Open Terminals").matched).toBe(false);
  });

  it("rejects when a query character is missing", () => {
    expect(fuzzyMatch("xyz", "Open Graph").matched).toBe(false);
  });

  it("scores a contiguous prefix higher than a scattered match", () => {
    const contiguous = fuzzyMatch("graph", "Open Graph");
    const scattered = fuzzyMatch("oga", "Open Graph");
    expect(contiguous.matched).toBe(true);
    expect(scattered.matched).toBe(true);
    expect(contiguous.score).toBeGreaterThan(scattered.score);
  });
});

describe("fuzzyRank", () => {
  const candidates = [
    { item: "memory", text: "Open Memory" },
    { item: "graph", text: "Open Graph" },
    { item: "snapshot", text: "Snapshot now" },
  ];

  it("returns every candidate in original order for an empty query", () => {
    const ranked = fuzzyRank("", candidates);
    expect(ranked.map((r) => r.item)).toEqual(["memory", "graph", "snapshot"]);
  });

  it("keeps only matches, ordered by descending score", () => {
    const ranked = fuzzyRank("open", candidates);
    expect(ranked.map((r) => r.item).sort()).toEqual(["graph", "memory"]);
  });

  it("ranks a strong contiguous match ahead of a weak scattered one", () => {
    const ranked = fuzzyRank("snap", candidates);
    expect(ranked[0].item).toBe("snapshot");
  });
});
