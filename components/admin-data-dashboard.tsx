"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Eye, RefreshCw, Search, X } from "lucide-react";
import { Button, Card, ErrorNote, Spinner } from "@/components/ui";
import { apiMessage } from "@/lib/utils";

const datasetDefinitions = [
  { key: "attempts", label: "Attempts", description: "Consent, attention responses, stages, and participant activity.", columns: ["participantId", "stage", "attentionResponse", "pairSessionId", "startedAt", "lastSeenAt"] },
  { key: "pairs", label: "Pairs", description: "Pair status, shared timers, final stories, and completion state.", columns: ["participantIds", "status", "pairedAt", "chatStartedAt", "chatEndsAt", "finalStory"] },
  { key: "queue", label: "Queue", description: "Waiting-room entries and their expiry status.", columns: ["participantId", "status", "joinedAt", "expiresAt", "attemptId"] },
  { key: "members", label: "Pair members", description: "Participant-to-pair membership, aliases, and readiness.", columns: ["participantId", "alias", "readyAt", "pairSessionId"] },
  { key: "messages", label: "Messages", description: "Persisted chat messages in server order.", columns: ["participantId", "body", "createdAt", "pairSessionId"] },
  { key: "proposals", label: "Story proposals", description: "Every proposed final-story version, including rejected versions.", columns: ["participantId", "version", "status", "body", "createdAt", "decidedAt"] },
  { key: "approvals", label: "Story approvals", description: "Each participant's decision for a story proposal.", columns: ["participantId", "decision", "decidedAt", "proposalId"] },
  { key: "quizzes", label: "Quiz responses", description: "Submitted answers for every required quiz question.", columns: ["participantId", "questionId", "answer", "submittedAt"] },
  { key: "integrity", label: "Integrity events", description: "Tab, focus, and fullscreen incidents recorded during assessments.", columns: ["participantId", "eventType", "clientOccurredAt", "clientDetails", "serverReceivedAt"] },
  { key: "keystrokes", label: "Keystrokes", description: "Raw chat and story field events, including input and composition data.", columns: ["participantId", "fieldType", "eventKind", "keyValue", "codeValue", "inputType", "eventData", "clientSequence", "clientWallTime"] },
] as const;

type Dataset = typeof datasetDefinitions[number]["key"];
type DataRow = Record<string, unknown>;
type DatasetResponse = {
  dataset: Dataset;
  rows: DataRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
};
type SummaryResponse = { counts: Record<Dataset, number> };

async function fetchJson<T>(url: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(apiMessage(body));
  return body as T;
}

function humanize(value: string) {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/^./, (letter) => letter.toUpperCase());
}

function isDateField(key: string) {
  return /(At|Time)$/.test(key) && key !== "clientElapsedMs";
}

function displayValue(value: unknown, key: string, compact = false): ReactNode {
  if (value === null || value === undefined || value === "") return <span className="empty-value">—</span>;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return value.length ? value.map(String).join(", ") : <span className="empty-value">—</span>;
  if (typeof value === "object") {
    const serialized = JSON.stringify(value, null, compact ? 0 : 2);
    return compact && serialized.length > 90 ? `${serialized.slice(0, 87)}…` : serialized;
  }
  if (typeof value === "string" && isDateField(key)) {
    const timestamp = new Date(value);
    if (!Number.isNaN(timestamp.getTime())) return timestamp.toLocaleString();
  }
  const text = String(value);
  return compact && text.length > 100 ? `${text.slice(0, 97)}…` : text;
}

function rowMatches(row: DataRow, query: string) {
  if (!query) return true;
  return Object.values(row).some((value) => {
    const text = typeof value === "object" ? JSON.stringify(value) : String(value ?? "");
    return text.toLocaleLowerCase().includes(query);
  });
}

export function AdminDataDashboard() {
  const [dataset, setDataset] = useState<Dataset>("attempts");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DatasetResponse | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Dataset, number>>>({});
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DataRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const definition = datasetDefinitions.find((item) => item.key === dataset) ?? datasetDefinitions[0];

  useEffect(() => {
    const controller = new AbortController();
    void fetchJson<SummaryResponse>("/api/admin/data?dataset=summary", controller.signal)
      .then((response) => setCounts(response.counts))
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Unable to load data totals.");
        }
      });
    return () => controller.abort();
  }, [refreshToken]);

  useEffect(() => {
    const controller = new AbortController();
    void fetchJson<DatasetResponse>(`/api/admin/data?dataset=${dataset}&page=${page}&pageSize=50`, controller.signal)
      .then((response) => { setResult(response); setCounts((current) => ({ ...current, [dataset]: response.total })); setError(""); })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Unable to load study data.");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [dataset, page, refreshToken]);

  const filteredRows = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return (result?.rows ?? []).filter((row) => rowMatches(row, normalizedQuery));
  }, [query, result]);

  const selectDataset = (nextDataset: Dataset) => {
    if (nextDataset === dataset) return;
    setDataset(nextDataset); setPage(1); setQuery(""); setSelected(null); setLoading(true); setError("");
  };
  const changePage = (nextPage: number) => {
    setPage(nextPage); setQuery(""); setSelected(null); setLoading(true); setError("");
  };
  const refresh = () => { setLoading(true); setError(""); setRefreshToken((current) => current + 1); };
  const firstRecord = result?.total ? ((result.page - 1) * result.pageSize) + 1 : 0;
  const lastRecord = result ? Math.min(result.page * result.pageSize, result.total) : 0;

  return <>
    <div className="data-summary-grid">
      {(["attempts", "pairs", "messages", "keystrokes"] as const).map((key) => {
        const item = datasetDefinitions.find((candidate) => candidate.key === key)!;
        return <Card key={key}><span>{item.label}</span><strong>{counts[key] ?? "—"}</strong><small>stored records</small></Card>;
      })}
    </div>
    <Card className="data-browser-card">
      <div className="section-heading data-browser-heading"><div><span className="card-kicker">Research records</span><h2>Browse collected study data</h2><p>Open any row to inspect every stored field. Tables are loaded 50 records at a time.</p></div><Button className="secondary small" onClick={refresh} disabled={loading}><RefreshCw size={15} />Refresh data</Button></div>
      <div className="dataset-tabs" role="tablist" aria-label="Study datasets">
        {datasetDefinitions.map((item) => <button key={item.key} role="tab" aria-selected={dataset === item.key} className={dataset === item.key ? "active" : ""} onClick={() => selectDataset(item.key)}><span>{item.label}</span>{counts[item.key] !== undefined && <small>{counts[item.key]!.toLocaleString()}</small>}</button>)}
      </div>
      <div className="data-toolbar"><div><h3>{definition.label}</h3><p>{definition.description}</p></div><label className="search-control"><Search size={16} /><input aria-label={`Search current ${definition.label} page`} placeholder="Search this page" value={query} onChange={(event) => setQuery(event.target.value)} /></label></div>
      {error && <ErrorNote>{error}</ErrorNote>}
      {loading ? <Spinner label={`Loading ${definition.label.toLocaleLowerCase()}…`} /> : <>
        <div className="table-wrap data-table"><table><thead><tr>{definition.columns.map((column) => <th key={column}>{humanize(column)}</th>)}<th /></tr></thead><tbody>{filteredRows.map((row, index) => <tr key={`${dataset}-${String(row.id ?? row.attemptId ?? row.proposalId ?? "record")}-${index}`}>{definition.columns.map((column) => <td key={column} className={column === "body" || column === "finalStory" || column === "attentionResponse" || column === "eventData" ? "wide-data-cell" : ""}>{column === "status" || column === "stage" || column === "decision" ? <span className={`status-pill ${String(row[column] ?? "")}`}>{displayValue(row[column], column, true)}</span> : displayValue(row[column], column, true)}</td>)}<td><button className="table-action" onClick={() => setSelected(row)}><Eye size={14} />View</button></td></tr>)}{!filteredRows.length && <tr><td colSpan={definition.columns.length + 1} className="empty-cell">{query ? "No records on this page match your search." : "No records have been collected in this dataset."}</td></tr>}</tbody></table></div>
        <div className="data-pagination"><span>{firstRecord.toLocaleString()}–{lastRecord.toLocaleString()} of {(result?.total ?? 0).toLocaleString()}</span><div><Button className="secondary small" disabled={!result || result.page <= 1} onClick={() => changePage((result?.page ?? 1) - 1)}><ChevronLeft size={15} />Previous</Button><span>Page {result?.page ?? 1} of {result?.totalPages ?? 1}</span><Button className="secondary small" disabled={!result || result.page >= result.totalPages} onClick={() => changePage((result?.page ?? 1) + 1)}>Next<ChevronRight size={15} /></Button></div></div>
      </>}
    </Card>
    {selected && <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelected(null); }}><Card className="data-detail-card"><div className="data-detail-header"><div><span className="card-kicker">Complete database record</span><h2>{definition.label}</h2></div><button aria-label="Close record details" onClick={() => setSelected(null)}><X size={20} /></button></div><dl>{Object.entries(selected).map(([key, value]) => <div key={key}><dt>{humanize(key)}</dt><dd className={typeof value === "object" || String(value ?? "").length > 120 ? "long-value" : ""}>{typeof value === "object" && value !== null ? <pre>{JSON.stringify(value, null, 2)}</pre> : displayValue(value, key)}</dd></div>)}</dl></Card></div>}
  </>;
}
