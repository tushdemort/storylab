import { describe, expect, it } from "vitest";
import { detectBrowserSupport } from "@/lib/browser";

const chrome = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36";
const safari = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/18.6 Safari/605.1.15";

describe("detectBrowserSupport", () => {
  it("accepts desktop Chrome and Safari with fullscreen", () => {
    expect(detectBrowserSupport(chrome, "Win32", 0, true)).toMatchObject({ supported: true, browser: "chrome" });
    expect(detectBrowserSupport(safari, "MacIntel", 0, true)).toMatchObject({ supported: true, browser: "safari" });
  });

  it("rejects Edge, mobile Safari, and missing fullscreen support", () => {
    expect(detectBrowserSupport(`${chrome} Edg/140.0`, "Win32", 0, true).supported).toBe(false);
    expect(detectBrowserSupport(safari, "MacIntel", 5, true).supported).toBe(false);
    expect(detectBrowserSupport(chrome, "Win32", 0, false).reason).toMatch(/Fullscreen/);
  });
});
