import { describe, expect, it } from "vitest";
import { parseColorInput, toCssColor } from "./colors";

describe("parseColorInput", () => {
  it("accepts #RRGGBB and lowercases it", () => {
    const r = parseColorInput("#3B82F6");
    expect(r.valid).toBe(true);
    expect(r.stored).toBe("#3b82f6");
    expect(r.css).toBe("#3b82f6");
  });

  it("accepts bare hex and normalizes to #rrggbb", () => {
    const r = parseColorInput("EF4444");
    expect(r.valid).toBe(true);
    expect(r.stored).toBe("#ef4444");
  });

  it("accepts known Windows Terminal color names", () => {
    const r = parseColorInput("Blue");
    expect(r.valid).toBe(true);
    expect(r.stored).toBe("blue");
    expect(r.css).toBe("#3b82f6");
  });

  it("rejects empty, short, and unknown input", () => {
    expect(parseColorInput("").valid).toBe(false);
    expect(parseColorInput("#abc").valid).toBe(false);
    expect(parseColorInput("notacolor").valid).toBe(false);
    expect(parseColorInput("#12345g").valid).toBe(false);
  });
});

describe("toCssColor", () => {
  it("passes through hex, maps names, and prefixes bare hex", () => {
    expect(toCssColor("#fff000")).toBe("#fff000");
    expect(toCssColor("green")).toBe("#22c55e");
    expect(toCssColor("ef4444")).toBe("#ef4444");
    expect(toCssColor("")).toBe("");
  });
});
