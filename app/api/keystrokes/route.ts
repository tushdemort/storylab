import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireParticipant, safeError } from "@/lib/api";

const nullableInt = z.number().int().nullable();
const eventSchema = z.object({
  attemptId: z.uuid(), pairSessionId: z.uuid(), fieldType: z.enum(["chat", "story"]),
  fieldInstanceId: z.uuid(), clientEventId: z.uuid(), clientSequence: z.number().int().nonnegative(),
  correlationId: z.uuid().nullable(),
  eventKind: z.enum(["keydown", "beforeinput", "input", "paste", "compositionstart", "compositionupdate", "compositionend"]),
  keyValue: z.string().nullable(), codeValue: z.string().nullable(), inputType: z.string().nullable(), eventData: z.string().nullable(),
  clientWallTime: z.iso.datetime(), clientElapsedMs: z.number().nonnegative(),
  selectionStart: nullableInt, selectionEnd: nullableInt, selectionStartAfter: nullableInt, selectionEndAfter: nullableInt,
  ctrlKey: z.boolean(), altKey: z.boolean(), shiftKey: z.boolean(), metaKey: z.boolean(),
  isRepeat: z.boolean(), keyLocation: z.number().int(), isComposing: z.boolean(),
});

export async function POST(request: NextRequest) {
  try {
    const auth = await requireParticipant(request);
    if ("error" in auth) return auth.error;
    const { events } = z.object({ events: z.array(eventSchema).min(1).max(200) }).parse(await request.json());
    const { data, error } = await auth.scoped.client.rpc("append_keystroke_batch", { p_events: events });
    if (error) throw error;
    return NextResponse.json({ accepted: data, acknowledged: events.map((event) => event.clientEventId) });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }
}
