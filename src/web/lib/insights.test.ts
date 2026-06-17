import { describe, expect, it } from "vitest";
import { csvField, scaleBars, toCsv } from "./insights";
import { sanitizeFilename } from "./download";

describe("scaleBars", () => {
  it("maps the max value to maxPx and scales the rest linearly", () => {
    expect(scaleBars([0, 5, 10], 100)).toEqual([0, 50, 100]);
  });

  it("returns zeros for an empty or all-zero series", () => {
    expect(scaleBars([], 100)).toEqual([]);
    expect(scaleBars([0, 0, 0], 100)).toEqual([0, 0, 0]);
  });

  it("clamps strictly-positive values up to at least minPx", () => {
    const bars = scaleBars([1, 1000], 100, 4);
    expect(bars[0]).toBe(4);
    expect(bars[1]).toBe(100);
  });

  it("returns zeros when maxPx is non-positive", () => {
    expect(scaleBars([1, 2, 3], 0)).toEqual([0, 0, 0]);
  });
});

describe("csvField", () => {
  it("leaves plain values unquoted", () => {
    expect(csvField("repo")).toBe("repo");
    expect(csvField(42)).toBe("42");
  });

  it("quotes and escapes values with commas, quotes, or newlines", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('he said "hi"')).toBe('"he said ""hi"""');
    expect(csvField("line1\nline2")).toBe('"line1\nline2"');
  });
});

describe("toCsv", () => {
  it("serializes rows with an explicit header order", () => {
    const csv = toCsv(
      [
        { repository: "o/r", sessions: 3 },
        { repository: "o/s", sessions: 1 },
      ],
      ["repository", "sessions"],
    );
    expect(csv).toBe("repository,sessions\r\no/r,3\r\no/s,1");
  });

  it("infers headers from the first row when omitted", () => {
    const csv = toCsv([{ date: "2024-01-01", sessions: 2 }]);
    expect(csv).toBe("date,sessions\r\n2024-01-01,2");
  });

  it("emits only a header line for an empty row list with headers", () => {
    expect(toCsv([], ["a", "b"])).toBe("a,b");
  });
});

describe("sanitizeFilename", () => {
  it("replaces unsafe characters and collapses separators", () => {
    expect(sanitizeFilename("a/b:c*d?.json")).toBe("a-b-c-d-.json");
  });

  it("falls back when the cleaned name is empty", () => {
    expect(sanitizeFilename("///", "fallback")).toBe("fallback");
  });
});
