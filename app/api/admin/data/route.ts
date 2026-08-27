import { NextResponse, type NextRequest } from "next/server";
import { requireAdmin, safeError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/server";
import { camelizeRow } from "@/lib/utils";

export const dynamic = "force-dynamic";

type Row = Record<string, unknown>;

const datasets = {
  attempts: { table: "attempts", order: "started_at" },
  pairs: { table: "pair_sessions", order: "paired_at" },
  queue: { table: "queue_entries", order: "joined_at" },
  members: { table: "pair_members", order: "ready_at" },
  messages: { table: "messages", order: "created_at" },
  ideationDrafts: { table: "ideation_drafts", order: "updated_at" },
  phaseApprovals: { table: "pair_phase_approvals", order: "decided_at" },
  outlineOperations: { table: "outline_operation_batches", order: "id" },
  outlineRevisions: { table: "outline_revisions", order: "created_at" },
  proposals: { table: "story_proposals", order: "created_at" },
  approvals: { table: "story_approvals", order: "decided_at" },
  quizzes: { table: "quiz_responses", order: "submitted_at" },
  integrity: { table: "integrity_events", order: "server_received_at" },
  keystrokes: { table: "keystroke_events", order: "id" },
} as const;

type Dataset = keyof typeof datasets;

function isDataset(value: string | null): value is Dataset {
  return value !== null && value in datasets;
}

function uniqueStrings(values: unknown[]) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function attemptReference(dataset: Dataset, row: Row): string | null {
  if (dataset === "attempts") return String(row.id);
  if (dataset === "messages") return String(row.sender_attempt_id);
  if (dataset === "proposals") return String(row.proposer_attempt_id);
  if (dataset === "outlineOperations") return String(row.sender_attempt_id);
  if (dataset === "outlineRevisions") return String(row.editor_attempt_id);
  if ("attempt_id" in row && row.attempt_id) return String(row.attempt_id);
  return null;
}

async function enrichRows(dataset: Dataset, rows: Row[]) {
  const admin = createAdminClient();
  const directAttemptIds = uniqueStrings(rows.map((row) => attemptReference(dataset, row)));
  const pairIds = dataset === "pairs" ? uniqueStrings(rows.map((row) => row.id)) : [];
  const attemptRows = dataset === "attempts"
    ? rows
    : await (async () => {
      const collected: Row[] = [];
      if (directAttemptIds.length) {
        const result = await admin.from("attempts")
          .select("id,participant_code_id,pair_session_id")
          .in("id", directAttemptIds);
        if (result.error) throw result.error;
        collected.push(...((result.data ?? []) as Row[]));
      }
      if (pairIds.length) {
        const result = await admin.from("attempts")
          .select("id,participant_code_id,pair_session_id")
          .in("pair_session_id", pairIds);
        if (result.error) throw result.error;
        collected.push(...((result.data ?? []) as Row[]));
      }
      return collected;
    })();

  const { data: codeData, error: codeError } = await admin.rpc("admin_codes_for_export");
  if (codeError) throw codeError;
  const codes = (codeData ?? []) as Row[];
  const codeById = new Map(codes.map((code) => [String(code.id), String(code.code_display)]));
  const participantByAttempt = new Map(attemptRows.map((attempt) => [
    String(attempt.id),
    codeById.get(String(attempt.participant_code_id)) ?? "Unavailable",
  ]));
  const participantsByPair = new Map<string, string[]>();
  for (const attempt of attemptRows) {
    if (!attempt.pair_session_id) continue;
    const pairId = String(attempt.pair_session_id);
    const participantId = participantByAttempt.get(String(attempt.id)) ?? "Unavailable";
    participantsByPair.set(pairId, [...(participantsByPair.get(pairId) ?? []), participantId]);
  }

  return rows.map((row) => {
    const output = camelizeRow<Row>(row);
    if (dataset === "pairs") {
      output.participantIds = participantsByPair.get(String(row.id)) ?? [];
    } else {
      const attemptId = attemptReference(dataset, row);
      if (attemptId) output.participantId = participantByAttempt.get(attemptId) ?? "Unavailable";
    }
    return output;
  });
}

async function datasetCounts() {
  const admin = createAdminClient();
  const entries = await Promise.all(Object.entries(datasets).map(async ([key, config]) => {
    const { count, error } = await admin.from(config.table).select("*", { count: "exact", head: true });
    if (error) throw error;
    return [key, count ?? 0] as const;
  }));
  return Object.fromEntries(entries) as Record<Dataset, number>;
}

async function allSelectedRows(
  table: string,
  columns: string,
  orderColumn: string,
  filter?: { column: string; value: string },
) {
  const admin = createAdminClient();
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = admin.from(table)
      .select(columns)
      .order(orderColumn, { ascending: true })
      .range(from, from + pageSize - 1);
    if (filter) query = query.gte(filter.column, filter.value);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as unknown as Row[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

function countBy(rows: Row[], column: string) {
  return rows.reduce<Record<string, number>>((counts, row) => {
    const value = String(row[column] ?? "unknown");
    counts[value] = (counts[value] ?? 0) + 1;
    return counts;
  }, {});
}

function percentage(numerator: number, denominator: number) {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

function isoDay(value: unknown) {
  const timestamp = new Date(String(value));
  return Number.isNaN(timestamp.getTime()) ? "" : timestamp.toISOString().slice(0, 10);
}

async function studyAnalytics(counts: Record<Dataset, number>) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const firstDay = new Date(today);
  firstDay.setUTCDate(firstDay.getUTCDate() - 6);
  const [attempts, pairs, recentMessages, integrity, approvals, proposals] = await Promise.all([
    allSelectedRows("attempts", "id,stage,started_at,completed_at,pair_session_id", "started_at"),
    allSelectedRows("pair_sessions", "id,status,paired_at,chat_started_at,approved_at,completed_at,aborted_at", "paired_at"),
    allSelectedRows("messages", "id,created_at", "created_at", { column: "created_at", value: firstDay.toISOString() }),
    allSelectedRows("integrity_events", "id,event_type,server_received_at", "id"),
    allSelectedRows("story_approvals", "proposal_id,attempt_id,decision,decided_at", "decided_at"),
    allSelectedRows("story_proposals", "id,status,created_at,decided_at", "created_at"),
  ]);
  const attemptStages = countBy(attempts, "stage");
  const pairStatuses = countBy(pairs, "status");
  const integrityTypes = countBy(integrity, "event_type");
  const approvalDecisions = countBy(approvals, "decision");
  const proposalStatuses = countBy(proposals, "status");
  const days = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(firstDay);
    date.setUTCDate(firstDay.getUTCDate() + index);
    return { date: date.toISOString().slice(0, 10), attempts: 0, messages: 0, integrity: 0 };
  });
  const dayByDate = new Map(days.map((day) => [day.date, day]));
  for (const attempt of attempts) {
    const bucket = dayByDate.get(isoDay(attempt.started_at));
    if (bucket) bucket.attempts += 1;
  }
  for (const message of recentMessages) {
    const bucket = dayByDate.get(isoDay(message.created_at));
    if (bucket) bucket.messages += 1;
  }
  for (const incident of integrity) {
    const bucket = dayByDate.get(isoDay(incident.server_received_at));
    if (bucket) bucket.integrity += 1;
  }
  const pairedAttempts = attempts.filter((attempt) => attempt.pair_session_id).length;
  const completedAttempts = attemptStages.complete ?? 0;
  const approvedPairs = pairs.filter((pair) => pair.approved_at).length;
  const agreementDecisions = approvalDecisions.agree ?? 0;
  const allDecisions = agreementDecisions + (approvalDecisions.disagree ?? 0);
  const approvalDurations = pairs.flatMap((pair) => {
    if (!pair.chat_started_at || !pair.approved_at) return [];
    const duration = new Date(String(pair.approved_at)).getTime() - new Date(String(pair.chat_started_at)).getTime();
    return duration >= 0 ? [duration / 60_000] : [];
  });
  const averageApprovalMinutes = approvalDurations.length
    ? Math.round((approvalDurations.reduce((sum, value) => sum + value, 0) / approvalDurations.length) * 10) / 10
    : 0;

  return {
    attemptStages,
    pairStatuses,
    integrityTypes,
    approvalDecisions,
    proposalStatuses,
    activity: days,
    kpis: {
      completionRate: percentage(completedAttempts, counts.attempts),
      pairingRate: percentage(pairedAttempts, counts.attempts),
      agreementRate: percentage(agreementDecisions, allDecisions),
      averageMessagesPerPair: counts.pairs ? Math.round((counts.messages / counts.pairs) * 10) / 10 : 0,
      averageKeystrokesPerAttempt: counts.attempts ? Math.round(counts.keystrokes / counts.attempts) : 0,
      integrityPerAttempt: counts.attempts ? Math.round((counts.integrity / counts.attempts) * 10) / 10 : 0,
      averageApprovalMinutes,
      completedAttempts,
      pairedAttempts,
      approvedPairs,
    },
  };
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const url = new URL(request.url);
    const requestedDataset = url.searchParams.get("dataset");
    if (requestedDataset === "summary") {
      const counts = await datasetCounts();
      return NextResponse.json({ counts, analytics: await studyAnalytics(counts) }, {
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (!isDataset(requestedDataset)) {
      return NextResponse.json({ error: "Choose a valid study dataset." }, { status: 400 });
    }

    const page = Math.max(1, Number.parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
    const requestedPageSize = Number.parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50;
    const pageSize = Math.min(100, Math.max(10, requestedPageSize));
    const from = (page - 1) * pageSize;
    const config = datasets[requestedDataset];
    const admin = createAdminClient();
    const { data, count, error } = await admin.from(config.table)
      .select("*", { count: "exact" })
      .order(config.order, { ascending: false, nullsFirst: false })
      .range(from, from + pageSize - 1);
    if (error) throw error;
    const rows = await enrichRows(requestedDataset, (data ?? []) as Row[]);
    const total = count ?? 0;
    return NextResponse.json({
      dataset: requestedDataset,
      rows,
      page,
      pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
