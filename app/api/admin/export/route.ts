import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import Papa from "papaparse";
import { requireAdmin, safeError } from "@/lib/api";
import { createAdminClient } from "@/lib/supabase/server";

type Row = Record<string, unknown>;

async function allRows(table: string, filters?: { column: string; values: string[] }) {
  const admin = createAdminClient();
  const rows: Row[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    let query = admin.from(table).select("*").range(from, from + pageSize - 1);
    if (filters?.values.length) query = query.in(filters.column, filters.values);
    const { data, error } = await query;
    if (error) throw error;
    rows.push(...((data ?? []) as Row[]));
    if (!data || data.length < pageSize) break;
  }
  return rows;
}

export async function GET(request: NextRequest) {
  try {
    const auth = await requireAdmin(request);
    if ("error" in auth) return auth.error;
    const url = new URL(request.url);
    const status = url.searchParams.get("status");
    const fromDate = url.searchParams.get("from");
    const toDate = url.searchParams.get("to");
    const versionId = url.searchParams.get("studyVersionId");
    const admin = createAdminClient();
    const { data: codeData, error: codeError } = await admin.rpc("admin_codes_for_export");
    if (codeError) throw codeError;
    let attempts = await allRows("attempts");
    attempts = attempts.filter((attempt) => {
      const started = new Date(String(attempt.started_at)).getTime();
      return (!status || attempt.stage === status)
        && (!fromDate || started >= new Date(fromDate).getTime())
        && (!toDate || started <= new Date(`${toDate}T23:59:59.999Z`).getTime())
        && (!versionId || attempt.study_version_id === versionId);
    });
    const attemptIds = attempts.map((row) => String(row.id));
    const pairIds = [...new Set(attempts.map((row) => row.pair_session_id).filter(Boolean).map(String))];
    const [pairs, members, messages, ideationDrafts, phaseApprovals, outlineOperations, outlineRevisions, proposals, approvals, quizzes, integrity, keystrokes] = await Promise.all([
      pairIds.length ? allRows("pair_sessions", { column: "id", values: pairIds }) : [],
      pairIds.length ? allRows("pair_members", { column: "pair_session_id", values: pairIds }) : [],
      pairIds.length ? allRows("messages", { column: "pair_session_id", values: pairIds }) : [],
      attemptIds.length ? allRows("ideation_drafts", { column: "attempt_id", values: attemptIds }) : [],
      pairIds.length ? allRows("pair_phase_approvals", { column: "pair_session_id", values: pairIds }) : [],
      pairIds.length ? allRows("outline_operation_batches", { column: "pair_session_id", values: pairIds }) : [],
      pairIds.length ? allRows("outline_revisions", { column: "pair_session_id", values: pairIds }) : [],
      pairIds.length ? allRows("story_proposals", { column: "pair_session_id", values: pairIds }) : [],
      attemptIds.length ? allRows("story_approvals", { column: "attempt_id", values: attemptIds }) : [],
      attemptIds.length ? allRows("quiz_responses", { column: "attempt_id", values: attemptIds }) : [],
      attemptIds.length ? allRows("integrity_events", { column: "attempt_id", values: attemptIds }) : [],
      attemptIds.length ? allRows("keystroke_events", { column: "attempt_id", values: attemptIds }) : [],
    ]);
    const codes = (codeData ?? []) as Row[];
    const codeById = new Map(codes.map((code) => [String(code.id), code.code_display]));
    attempts = attempts.map((attempt) => ({
      ...attempt,
      participant_id: codeById.get(String(attempt.participant_code_id)) ?? "",
    }));

    const zip = new JSZip();
    const files: Record<string, Row[]> = {
      attempts, pairs, pair_members: members, messages, ideation_drafts: ideationDrafts,
      phase_approvals: phaseApprovals,
      outline_operation_batches: outlineOperations.map((row) => ({
        ...row,
        operations: JSON.stringify(row.operations ?? []),
      })),
      outline_revisions: outlineRevisions, story_proposals: proposals,
      story_approvals: approvals, quiz_responses: quizzes, integrity_events: integrity, keystroke_events: keystrokes,
    };
    for (const [name, rows] of Object.entries(files)) {
      zip.file(`${name}.csv`, Papa.unparse(rows, { escapeFormulae: true, newline: "\r\n" }));
    }
    const content = await zip.generateAsync({ type: "uint8array", compression: "DEFLATE" });
    const responseBody = content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;
    return new NextResponse(responseBody, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="assessment-export-${new Date().toISOString().slice(0, 10)}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json({ error: safeError(error) }, { status: 500 });
  }
}
