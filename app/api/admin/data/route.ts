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

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const url = new URL(request.url);
    const requestedDataset = url.searchParams.get("dataset");
    if (requestedDataset === "summary") {
      return NextResponse.json({ counts: await datasetCounts() }, {
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
