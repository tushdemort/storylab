import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { requireParticipant, safeError } from "@/lib/api";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submitAttention"), response: z.string().trim().min(1) }),
  z.object({ action: z.literal("retryQueue") }),
  z.object({ action: z.literal("ready") }),
  z.object({ action: z.literal("heartbeat") }),
  z.object({
    action: z.literal("message"), body: z.string().trim().min(1).max(2000),
    clientMessageId: z.uuid(), fieldInstanceId: z.uuid(),
  }),
  z.object({ action: z.literal("proposeStory"), body: z.string().trim().min(1), fieldInstanceId: z.uuid() }),
  z.object({ action: z.literal("decideStory"), proposalId: z.uuid(), decision: z.enum(["agree", "disagree"]) }),
  z.object({ action: z.literal("submitQuiz"), answers: z.record(z.string(), z.string()) }),
  z.object({
    action: z.literal("integrity"), incidentId: z.uuid(),
    eventType: z.enum(["tab_hidden", "window_blur", "fullscreen_exit", "fullscreen_error"]),
    clientOccurredAt: z.iso.datetime(), details: z.record(z.string(), z.unknown()).optional(),
  }),
]);

export async function POST(request: NextRequest) {
  try {
    const auth = await requireParticipant(request);
    if ("error" in auth) return auth.error;
    const body = actionSchema.parse(await request.json());
    const supabase = auth.scoped.client;
    let result;
    switch (body.action) {
      case "submitAttention":
        result = await supabase.rpc("submit_attention", { p_response: body.response }); break;
      case "retryQueue":
        result = await supabase.rpc("join_waiting_room"); break;
      case "ready":
        result = await supabase.rpc("mark_ready"); break;
      case "heartbeat":
        result = await supabase.rpc("record_heartbeat"); break;
      case "message":
        result = await supabase.rpc("send_message", {
          p_body: body.body, p_client_message_id: body.clientMessageId, p_field_instance_id: body.fieldInstanceId,
        }); break;
      case "proposeStory":
        result = await supabase.rpc("propose_story", { p_body: body.body, p_field_instance_id: body.fieldInstanceId }); break;
      case "decideStory":
        result = await supabase.rpc("decide_story", { p_proposal_id: body.proposalId, p_decision: body.decision }); break;
      case "submitQuiz":
        result = await supabase.rpc("submit_quiz", { p_answers: body.answers }); break;
      case "integrity":
        result = await supabase.rpc("record_integrity_event", {
          p_incident_id: body.incidentId, p_event_type: body.eventType,
          p_client_occurred_at: body.clientOccurredAt, p_details: body.details ?? {},
        }); break;
    }
    if (result.error) throw result.error;
    return NextResponse.json({ ok: true, data: result.data ?? null });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 400 });
  }
}
