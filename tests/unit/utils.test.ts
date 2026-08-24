import { describe, expect, it } from "vitest";
import { countWords, formatClock, secondsRemaining } from "@/lib/utils";

describe("assessment utilities", () => {
  it("counts whitespace-separated words", () => {
    expect(countWords("  one\n two   three ")).toBe(3);
    expect(countWords("   ")).toBe(0);
  });

  it("calculates a non-negative, ceiling-based countdown", () => {
    expect(secondsRemaining("2026-01-01T00:00:10.001Z", Date.parse("2026-01-01T00:00:00Z"))).toBe(11);
    expect(secondsRemaining("2026-01-01T00:00:00Z", Date.parse("2026-01-01T00:00:01Z"))).toBe(0);
    expect(formatClock(125)).toBe("02:05");
  });
});
