import { afterEach, describe, expect, it, vi } from "vitest";
import { KeystrokeRecorder } from "@/lib/keystrokes";

describe("KeystrokeRecorder", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("serializes raw key data and acknowledges an idempotent batch", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { events: Array<{ clientEventId: string }> };
      return new Response(JSON.stringify({ acknowledged: body.events.map((event) => event.clientEventId) }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const recorder = new KeystrokeRecorder("00000000-0000-4000-8000-000000000001");
    recorder.enqueue({
      attemptId: "00000000-0000-4000-8000-000000000001",
      pairSessionId: "00000000-0000-4000-8000-000000000002",
      fieldType: "chat",
      fieldInstanceId: "00000000-0000-4000-8000-000000000003",
    }, {
      eventKind: "keydown",
      keyValue: "A",
      codeValue: "KeyA",
      shiftKey: true,
      selectionStart: 0,
      selectionEnd: 0,
    });
    await recorder.flush(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const request = fetchMock.mock.calls[0][1];
    const payload = JSON.parse(String(request?.body));
    expect(payload.events[0]).toMatchObject({
      fieldType: "chat",
      eventKind: "keydown",
      keyValue: "A",
      codeValue: "KeyA",
      shiftKey: true,
    });
    await recorder.stop();
  });
});
