import { NextResponse, type NextRequest } from "next/server";
import { requireParticipant, safeError } from "@/lib/api";
import { camelizeRow } from "@/lib/utils";
import type {
  Attempt,
  ChatMessage,
  PairMember,
  PairState,
  ParticipantState,
  QueueState,
  StoryApproval,
  StoryProposal,
  StudyConfig,
} from "@/lib/types";

export const dynamic = "force-dynamic";

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
        .select("id,version,consent_markdown,keystroke_disclosure,attention_prompt,instruction_markdown,wait_seconds,chat_seconds,reconnect_seconds,quiz_questions")
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
    let proposal: StoryProposal = null;
    if (attemptRow.pair_session_id) {
      const pairId = attemptRow.pair_session_id;
      const [pairResult, presenceResult, messagesResult, proposalsResult] = await Promise.all([
        scoped.client.from("pair_sessions")
          .select("id,status,paired_at,chat_started_at,chat_ends_at,final_story")
          .eq("id", pairId).single(),
        scoped.client.rpc("get_pair_presence", { p_pair_id: pairId }),
        scoped.client.from("messages")
          .select("id,sender_attempt_id,client_message_id,field_instance_id,body,created_at")
          .eq("pair_session_id", pairId).order("created_at", { ascending: true }),
        scoped.client.from("story_proposals")
          .select("id,proposer_attempt_id,version,body,field_instance_id,status,created_at")
          .eq("pair_session_id", pairId).order("version", { ascending: false }).limit(1),
      ]);
      if (pairResult.error) throw pairResult.error;
      if (presenceResult.error) throw presenceResult.error;
      if (messagesResult.error) throw messagesResult.error;
      if (proposalsResult.error) throw proposalsResult.error;

      const members = ((presenceResult.data ?? []) as Record<string, unknown>[]).map((row) => ({
        ...camelizeRow<Omit<PairMember, "isSelf">>(row),
        isSelf: row.attempt_id === attemptRow.id,
      }));
      pair = { ...camelizeRow<Omit<NonNullable<PairState>, "members">>(pairResult.data), members };
      messages = (messagesResult.data ?? []).map((row) => camelizeRow<ChatMessage>(row));

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
      proposal,
      quizResponses: Object.fromEntries((responses ?? []).map((row) => [row.question_id, row.answer])),
      serverNow: new Date().toISOString(),
    };
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
