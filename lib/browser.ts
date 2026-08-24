export type BrowserSupport = {
  supported: boolean;
  browser: "chrome" | "safari" | "unsupported";
  reason?: string;
};

export function detectBrowserSupport(
  userAgent: string,
  platform: string,
  maxTouchPoints: number,
  fullscreenEnabled: boolean,
): BrowserSupport {
  const ua = userAgent.toLowerCase();
  const isMobile = /android|iphone|ipad|ipod|mobile/.test(ua)
    || (platform === "MacIntel" && maxTouchPoints > 1);
  if (isMobile) {
    return { supported: false, browser: "unsupported", reason: "A desktop computer is required." };
  }

  const isEdge = /edg\//.test(ua);
  const isOpera = /opr\//.test(ua);
  const isChrome = /chrome\//.test(ua) && !isEdge && !isOpera;
  const isSafari = /safari\//.test(ua) && /version\//.test(ua) && !/chrome\//.test(ua);
  const browser = isChrome ? "chrome" : isSafari ? "safari" : "unsupported";

  if (browser === "unsupported") {
    return { supported: false, browser, reason: "Open this assessment in desktop Chrome or Safari." };
  }
  if (!fullscreenEnabled) {
    return { supported: false, browser, reason: "Fullscreen mode is unavailable in this browser." };
  }
  return { supported: true, browser };
}
