import { NextResponse, type NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireParticipant, safeError } from "@/lib/api";
import { camelizeRow } from "@/lib/utils";
import type {
  Attempt,
  ChatMessage,
  PairMember,
  PairState,
  OutlineOperationBatch,
  PhaseApproval,
  ParticipantState,
  QueueState,
  StoryApproval,
  StoryProposal,
  StudyConfig,
} from "@/lib/types";

export const dynamic = "force-dynamic";

async function readOutlineBatches(client: SupabaseClient, pairId: string) {
  const rows: Record<string, unknown>[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await client.from("outline_operation_batches")
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

export async function GET(request: NextRequest) {
  try {
    const auth = await requireParticipant(request);
    if ("error" in auth) return auth.error;
    const { scoped, user } = auth;
    const { data: attemptRow, error: attemptError } = await scoped.client
      .from("attempts")
      .select("id,stage,pair_session_id,attention_response,started_at,completed_at,last_seen_at,study_version_id")
      .eq("auth_user_id", user.id)
      .maybeSingle();
    if (attemptError) throw attemptError;
    if (!attemptRow) return NextResponse.json({ error: "No participant attempt was found." }, { status: 404 });

    const [configResult, queueResult, responseResult] = await Promise.all([
      scoped.client.from("study_versions")
        .select("id,version,consent_markdown,keystroke_disclosure,attention_prompt,instruction_markdown,ideation_instruction_markdown,ideation_prompt,discussion_instruction_markdown,discussion_prompt,outline_instruction_markdown,outline_prompt,writing_instruction_markdown,writing_prompt,wait_seconds,chat_seconds,ideation_seconds,discussion_seconds,outline_seconds,writing_seconds,reconnect_seconds,quiz_questions")
        .eq("id", attemptRow.study_version_id)
        .single(),
      scoped.client.from("queue_entries")
        .select("status,joined_at,expires_at")
        .eq("attempt_id", attemptRow.id)
        .maybeSingle(),
      scoped.client.from("quiz_responses")
        .select("question_id,answer")
        .eq("attempt_id", attemptRow.id),
    ]);
    const { data: configRow, error: configError } = configResult;
    if (configError) throw configError;
    const { data: queueRow, error: queueError } = queueResult;
    if (queueError) throw queueError;
    const { data: responses, error: responseError } = responseResult;
    if (responseError) throw responseError;

    let pair: PairState = null;
    let messages: ChatMessage[] = [];
    let outlineOperationBatches: OutlineOperationBatch[] = [];
    let phaseApprovals: PhaseApproval[] = [];
    let ideationDraft = "";
    let proposal: StoryProposal = null;
    if (attemptRow.pair_session_id) {
      const pairId = attemptRow.pair_session_id;
      const [pairResult, presenceResult, messagesResult, proposalsResult, phaseApprovalsResult, ideationDraftResult, outlineBatchRows] = await Promise.all([
        scoped.client.from("pair_sessions")
          .select("id,status,paired_at,chat_started_at,chat_ends_at,phase,phase_started_at,phase_ends_at,shared_outline,shared_outline_updated_at,shared_outline_updated_by,disconnected_attempt_id,disconnect_detected_at,final_story")
          .eq("id", pairId).single(),
        scoped.client.rpc("get_pair_presence", { p_pair_id: pairId }),
        scoped.client.from("messages")
          .select("id,sender_attempt_id,client_message_id,field_instance_id,body,created_at")
          .eq("pair_session_id", pairId).order("created_at", { ascending: true }),
        scoped.client.from("story_proposals")
          .select("id,proposer_attempt_id,version,body,field_instance_id,status,created_at")
          .eq("pair_session_id", pairId).order("version", { ascending: false }).limit(1),
        scoped.client.from("pair_phase_approvals")
          .select("phase,attempt_id,decided_at")
          .eq("pair_session_id", pairId).order("decided_at", { ascending: true }),
        scoped.client.from("ideation_drafts")
          .select("body")
          .eq("attempt_id", attemptRow.id).maybeSingle(),
        readOutlineBatches(scoped.client, pairId),
      ]);
      let pairRow = pairResult.data as Record<string, unknown> | null;
      if (pairResult.error?.code === "42703") {
        // Keep existing sessions readable during a rolling deployment while the
        // reconnect migration is being applied to Supabase.
        const fallback = await scoped.client.from("pair_sessions")
          .select("id,status,paired_at,chat_started_at,chat_ends_at,final_story")
          .eq("id", pairId).single();
        if (fallback.error) throw fallback.error;
        pairRow = {
          ...(fallback.data as Record<string, unknown>),
          disconnected_attempt_id: null,
          disconnect_detected_at: null,
        };
      } else if (pairResult.error) {
        throw pairResult.error;
      }
      if (presenceResult.error) throw presenceResult.error;
      if (messagesResult.error) throw messagesResult.error;
      if (proposalsResult.error) throw proposalsResult.error;
      if (phaseApprovalsResult.error) throw phaseApprovalsResult.error;
      if (ideationDraftResult.error) throw ideationDraftResult.error;

      const members = ((presenceResult.data ?? []) as Record<string, unknown>[]).map((row) => ({
        ...camelizeRow<Omit<PairMember, "isSelf">>(row),
        isSelf: row.attempt_id === attemptRow.id,
      }));
      pair = { ...camelizeRow<Omit<NonNullable<PairState>, "members">>(pairRow!), members };
      messages = pair.phase === "ideation"
        ? []
        : (messagesResult.data ?? []).map((row) => camelizeRow<ChatMessage>(row));
      phaseApprovals = (phaseApprovalsResult.data ?? []).map((row) => camelizeRow<PhaseApproval>(row));
      ideationDraft = ideationDraftResult.data?.body ?? "";
      outlineOperationBatches = outlineBatchRows;

      const proposalRow = proposalsResult.data?.[0];
      if (proposalRow) {
        const { data: approvals, error: approvalError } = await scoped.client
          .from("story_approvals")
          .select("attempt_id,decision,decided_at")
          .eq("proposal_id", proposalRow.id);
        if (approvalError) throw approvalError;
        proposal = {
          ...camelizeRow<Omit<NonNullable<StoryProposal>, "approvals">>(proposalRow),
          approvals: (approvals ?? []).map((row) => camelizeRow<StoryApproval>(row)),
        };
      }
    }

    const state: ParticipantState = {
      attempt: camelizeRow<Attempt>(attemptRow),
      config: camelizeRow<StudyConfig>(configRow),
      queue: queueRow ? camelizeRow<NonNullable<QueueState>>(queueRow) : null,
      pair,
      messages,
      outlineOperationBatches,
      phaseApprovals,
      ideationDraft,
      proposal,
      quizResponses: Object.fromEntries((responses ?? []).map((row) => [row.question_id, row.answer])),
      serverNow: new Date().toISOString(),
    };
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
