import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, safeError } from "@/lib/api";
import { camelizeRow } from "@/lib/utils";
import type { StudyConfig } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const supabase = auth.scoped.client;
    const [configResult, attemptsResult, pairsResult, queueResult, codesResult] = await Promise.all([
      supabase.from("study_versions")
        .select("id,version,consent_markdown,keystroke_disclosure,attention_prompt,instruction_markdown,wait_seconds,chat_seconds,reconnect_seconds,quiz_questions")
        .eq("status", "active").single(),
      supabase.from("attempts")
        .select("id,participant_code_id,stage,pair_session_id,started_at,completed_at,last_seen_at")
        .order("started_at", { ascending: false }).limit(500),
      supabase.from("pair_sessions")
        .select("id,status,paired_at,chat_ends_at,completed_at,aborted_at")
        .order("paired_at", { ascending: false }).limit(250),
      supabase.from("queue_entries").select("attempt_id,status,expires_at"),
      supabase.rpc("admin_codes_for_export"),
    ]);
    for (const result of [configResult, attemptsResult, pairsResult, queueResult, codesResult]) {
      if (result.error) throw result.error;
    }
    const codes = (codesResult.data ?? []) as Array<Record<string, unknown>>;
    const codeById = new Map(codes.map((code) => [String(code.id), code]));
    if (!configResult.data) throw new Error("No active study configuration was found.");
    const attempts: Array<Record<string, unknown>> = (attemptsResult.data ?? []).map((row) => ({
      ...camelizeRow<Record<string, unknown>>(row),
      participantId: codeById.get(row.participant_code_id)?.code_display ?? "Unavailable",
      codeStatus: codeById.get(row.participant_code_id)?.status ?? "unknown",
    }));
    const counts = attempts.reduce<Record<string, number>>((acc, attempt) => {
      const stage = String(attempt.stage);
      acc[stage] = (acc[stage] ?? 0) + 1;
      return acc;
    }, {});
    return NextResponse.json({
      config: camelizeRow<StudyConfig>(configResult.data),
      attempts,
      participantCodes: codes.map((code) => ({
        id: String(code.id),
        participantId: String(code.code_display),
        status: String(code.status),
        currentAttemptId: code.current_attempt_id ? String(code.current_attempt_id) : null,
        createdAt: String(code.created_at),
        updatedAt: String(code.updated_at),
      })),
      pairs: (pairsResult.data ?? []).map((row) => camelizeRow(row)),
      queue: (queueResult.data ?? []).map((row) => camelizeRow(row)),
      counts,
      adminEmail: auth.user.email,
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
