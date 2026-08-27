import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { requireParticipant, safeError } from "@/lib/api";
import { outlineSnapshot } from "@/lib/collaborative-outline";
import { camelizeRow } from "@/lib/utils";
import type { OutlineOperationBatch } from "@/lib/types";

const outlineRunSchema = z.object({
  id: z.string().min(1).max(100),
  afterId: z.string().min(1).max(120).nullable(),
  text: z.string().min(1).max(20000),
});
const outlineOperationSchema = z.object({
  id: z.uuid(),
  insertRuns: z.array(outlineRunSchema).max(4),
  deleteIds: z.array(z.string().min(1).max(120)).max(20000),
}).refine((operation) => operation.insertRuns.length > 0 || operation.deleteIds.length > 0);

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("submitAttention"), response: z.string().trim().min(1) }),
  z.object({ action: z.literal("retryQueue") }),
  z.object({ action: z.literal("ready") }),
  z.object({ action: z.literal("approvePhase"), phase: z.enum(["ideation", "discussion", "outline"]) }),
  z.object({ action: z.literal("saveIdeation"), body: z.string().max(20000) }),
  z.object({ action: z.literal("saveOutline"), body: z.string().max(20000) }),
  z.object({
    action: z.literal("outlineOperations"),
    batches: z.array(z.object({
      clientBatchId: z.uuid(),
      operations: z.array(outlineOperationSchema).min(1).max(100),
    })).min(1).max(10),
  }),
  z.object({ action: z.literal("heartbeat") }),
  z.object({ action: z.literal("leavePair") }),
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

async function readOutlineBatches(supabase: SupabaseClient, pairId: string) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await supabase.from("outline_operation_batches")
      .select("client_batch_id,sender_attempt_id,operations,created_at")
      .eq("pair_session_id", pairId)
      .order("id", { ascending: true })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if (!data || data.length < pageSize) break;
  }
  return rows.map((row) => camelizeRow<OutlineOperationBatch>(row));
}

async function materializeOutline(supabase: SupabaseClient) {
  const { data: attempt, error: attemptError } = await supabase.from("attempts")
    .select("pair_session_id")
    .single();
  if (attemptError) throw attemptError;
  const pairId = String(attempt.pair_session_id ?? "");
  if (!pairId) throw new Error("Shared outline is unavailable.");

  let lastError: unknown;
  for (let pass = 0; pass < 4; pass += 1) {
    const { data: document, error: documentError } = await supabase.from("outline_documents")
      .select("operation_count")
      .eq("pair_session_id", pairId)
      .maybeSingle();
    if (documentError) throw documentError;
    const batches = await readOutlineBatches(supabase, pairId);
    const operationCount = Number(document?.operation_count ?? 0);
    const body = outlineSnapshot(batches).text;
    const result = await supabase.rpc("save_shared_outline_snapshot", {
      p_body: body,
      p_operation_count: operationCount,
    });
    if (!result.error) return;
    lastError = result.error;
    if (!result.error.message.toLocaleLowerCase().includes("outline changed")) throw result.error;
  }
  throw lastError ?? new Error("The shared outline is still syncing. Try again.");
}

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
      case "approvePhase":
        if (body.phase === "outline") await materializeOutline(supabase);
        result = await supabase.rpc("approve_phase", { p_phase: body.phase }); break;
      case "saveIdeation":
        result = await supabase.rpc("save_ideation_draft", { p_body: body.body }); break;
      case "saveOutline":
        result = await supabase.rpc("save_shared_outline", { p_body: body.body }); break;
      case "outlineOperations":
        result = await supabase.rpc("append_outline_operation_batches", { p_batches: body.batches }); break;
      case "heartbeat":
        result = await supabase.rpc("record_heartbeat"); break;
      case "leavePair":
        result = await supabase.rpc("mark_pair_departure"); break;
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
