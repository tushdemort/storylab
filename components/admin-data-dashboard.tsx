"use client";

import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Activity, CheckCircle2, ChevronLeft, ChevronRight, Clock, Eye, Keyboard,
  MessageSquare, RefreshCw, Search, ShieldAlert, Users, X,
} from "lucide-react";
import { Button, Card, ErrorNote, Spinner } from "@/components/ui";
import { apiMessage } from "@/lib/utils";

const datasetDefinitions = [
  { key: "attempts", label: "Attempts", description: "Consent, attention responses, stages, and participant activity.", columns: ["participantId", "stage", "attentionResponse", "pairSessionId", "startedAt", "lastSeenAt"] },
  { key: "pairs", label: "Pairs", description: "Current collaboration phase, phase timer, shared outline, final story, and completion state.", columns: ["participantIds", "status", "phase", "pairedAt", "phaseStartedAt", "phaseEndsAt", "sharedOutline", "finalStory"] },
  { key: "queue", label: "Queue", description: "Waiting-room entries and their expiry status.", columns: ["participantId", "status", "joinedAt", "expiresAt", "attemptId"] },
  { key: "members", label: "Pair members", description: "Participant-to-pair membership, aliases, and readiness.", columns: ["participantId", "alias", "readyAt", "pairSessionId"] },
  { key: "messages", label: "Messages", description: "Persisted chat messages in server order.", columns: ["participantId", "body", "createdAt", "pairSessionId"] },
  { key: "ideationDrafts", label: "Ideation drafts", description: "Each participant's private ideation draft; never exposed to their partner.", columns: ["participantId", "body", "updatedAt", "pairSessionId"] },
  { key: "phaseApprovals", label: "Phase approvals", description: "Readiness decisions used to advance ideation, discussion, and outline atomically.", columns: ["participantId", "phase", "decidedAt", "pairSessionId"] },
  { key: "outlineOperations", label: "Live outline edits", description: "Append-only collaborative edit batches used to reconstruct the shared outline without overwrites.", columns: ["participantId", "operations", "createdAt", "pairSessionId"] },
  { key: "outlineRevisions", label: "Outline snapshots", description: "Canonical shared-outline snapshots retained when participants advance from outlining.", columns: ["participantId", "body", "createdAt", "pairSessionId"] },
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
type StudyAnalytics = {
  attemptStages: Record<string, number>;
  pairStatuses: Record<string, number>;
  integrityTypes: Record<string, number>;
  approvalDecisions: Record<string, number>;
  proposalStatuses: Record<string, number>;
  activity: Array<{ date: string; attempts: number; messages: number; integrity: number }>;
  kpis: {
    completionRate: number;
    pairingRate: number;
    agreementRate: number;
    averageMessagesPerPair: number;
    averageKeystrokesPerAttempt: number;
    integrityPerAttempt: number;
    averageApprovalMinutes: number;
    completedAttempts: number;
    pairedAttempts: number;
    approvedPairs: number;
  };
};
type SummaryResponse = { counts: Record<Dataset, number>; analytics: StudyAnalytics };

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

function compactNumber(value: number) {
  return new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(value);
}

function AnalyticsOverview({
  summary,
  loading,
  lastRefreshed,
  onRefresh,
}: {
  summary: SummaryResponse | null;
  loading: boolean;
  lastRefreshed: Date | null;
  onRefresh: () => void;
}) {
  const counts = summary?.counts;
  const analytics = summary?.analytics;
  const kpis = analytics?.kpis;
  const cards = [
    { label: "Completion rate", value: kpis ? `${kpis.completionRate}%` : "—", detail: kpis && counts ? `${kpis.completedAttempts} of ${counts.attempts} participants` : "Completed assessments", icon: <CheckCircle2 size={19} />, tone: "green" },
    { label: "Pairing rate", value: kpis ? `${kpis.pairingRate}%` : "—", detail: kpis && counts ? `${kpis.pairedAttempts} participants paired` : "Participants reaching a pair", icon: <Users size={19} />, tone: "blue" },
    { label: "Agreement rate", value: kpis ? `${kpis.agreementRate}%` : "—", detail: analytics ? `${analytics.approvalDecisions.agree ?? 0} agree decisions` : "Story approval decisions", icon: <Activity size={19} />, tone: "gold" },
    { label: "Messages per pair", value: kpis ? String(kpis.averageMessagesPerPair) : "—", detail: counts ? `${counts.messages.toLocaleString()} messages total` : "Collaboration volume", icon: <MessageSquare size={19} />, tone: "violet" },
    { label: "Events per attempt", value: kpis ? compactNumber(kpis.averageKeystrokesPerAttempt) : "—", detail: counts ? `${counts.keystrokes.toLocaleString()} keystroke events` : "Typing-event density", icon: <Keyboard size={19} />, tone: "slate" },
    { label: "Time to approval", value: kpis ? `${kpis.averageApprovalMinutes}m` : "—", detail: kpis ? `${kpis.approvedPairs} pairs approved a story` : "Average after chat begins", icon: <Clock size={19} />, tone: "coral" },
  ];

  return <section className="analytics-dashboard" aria-label="Study analytics">
    <Card className="analytics-hero">
      <div><span className="card-kicker">Research intelligence</span><h2>Study performance at a glance</h2><p>Live operational and behavioral statistics calculated from the collected Supabase records.</p></div>
      <div className="analytics-refresh"><span><i />{lastRefreshed ? `Updated ${lastRefreshed.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Loading live data"}</span><Button className="secondary small" onClick={onRefresh} disabled={loading}><RefreshCw className={loading ? "spin-icon" : ""} size={15} />{loading ? "Refreshing…" : "Refresh"}</Button></div>
    </Card>
    <div className="analytics-kpi-grid">{cards.map((card) => <Card key={card.label} className="analytics-kpi"><div className={`analytics-kpi-icon ${card.tone}`}>{card.icon}</div><div><span>{card.label}</span><strong>{card.value}</strong><small>{card.detail}</small></div></Card>)}</div>
    <div className="analytics-chart-grid primary-charts">
      <ActivityChart activity={analytics?.activity ?? []} />
      <PairOutcomeChart analytics={analytics ?? null} totalPairs={counts?.pairs ?? 0} />
    </div>
    <div className="analytics-chart-grid secondary-charts">
      <ParticipantPipeline stages={analytics?.attemptStages ?? {}} totalAttempts={counts?.attempts ?? 0} />
      <IntegrityChart types={analytics?.integrityTypes ?? {}} total={counts?.integrity ?? 0} rate={kpis?.integrityPerAttempt ?? 0} />
    </div>
    <DataVolumeChart counts={counts ?? null} />
  </section>;
}

function ActivityChart({ activity }: { activity: StudyAnalytics["activity"] }) {
  const series = [
    { key: "attempts", label: "New attempts", className: "attempts" },
    { key: "messages", label: "Messages", className: "messages-series" },
    { key: "integrity", label: "Integrity events", className: "integrity" },
  ] as const;
  const maximum = Math.max(1, ...activity.flatMap((day) => series.map((item) => day[item.key])));
  const total = activity.reduce((sum, day) => sum + day.attempts + day.messages + day.integrity, 0);
  return <Card className="analytics-chart activity-chart-card"><div className="chart-heading"><div><span className="card-kicker">Last 7 days</span><h3>Study activity</h3></div><strong>{total.toLocaleString()}<small> recorded actions</small></strong></div><div className="chart-legend">{series.map((item) => <span key={item.key}><i className={item.className} />{item.label}</span>)}</div><div className="activity-plot" aria-label="Seven-day study activity bar chart">{activity.map((day) => <div className="activity-day" key={day.date}><div className="activity-bars">{series.map((item) => <i key={item.key} className={item.className} style={{ height: `${(day[item.key] / maximum) * 100}%` }} title={`${item.label}: ${day[item.key]}`} />)}</div><span>{new Date(`${day.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: "short" })}</span><small>{new Date(`${day.date}T12:00:00Z`).getUTCDate()}</small></div>)}</div></Card>;
}

function PairOutcomeChart({ analytics, totalPairs }: { analytics: StudyAnalytics | null; totalPairs: number }) {
  const statuses = analytics?.pairStatuses ?? {};
  const slices = [
    { label: "Complete", value: statuses.complete ?? 0, color: "#26735f" },
    { label: "Story approved", value: statuses.approved ?? 0, color: "#5ca58c" },
    { label: "In progress", value: (statuses.instruction ?? 0) + (statuses.chat ?? 0) + (statuses.finalizing ?? 0), color: "#d3a74f" },
    { label: "Aborted", value: statuses.aborted ?? 0, color: "#d8786e" },
  ];
  let cursor = 0;
  const segments = slices.map((slice) => {
    const start = cursor;
    cursor += totalPairs ? (slice.value / totalPairs) * 100 : 0;
    return `${slice.color} ${start}% ${cursor}%`;
  });
  const donutBackground = totalPairs ? `conic-gradient(${segments.join(", ")})` : "#e9edea";
  const agreementRate = analytics?.kpis.agreementRate ?? 0;
  return <Card className="analytics-chart pair-outcome-card"><div className="chart-heading"><div><span className="card-kicker">Pair outcomes</span><h3>Session health</h3></div></div><div className="pair-outcome-body"><div className="donut-chart" style={{ background: donutBackground }}><div><strong>{totalPairs}</strong><span>pairs</span></div></div><div className="donut-legend">{slices.map((slice) => <div key={slice.label}><i style={{ background: slice.color }} /><span>{slice.label}</span><strong>{slice.value}</strong></div>)}</div></div><div className="agreement-meter"><div><span>Agreement decisions</span><strong>{agreementRate}%</strong></div><div className="meter-track"><i style={{ width: `${agreementRate}%` }} /></div><small>{analytics?.proposalStatuses.accepted ?? 0} accepted and {analytics?.proposalStatuses.rejected ?? 0} rejected story versions</small></div></Card>;
}

function ParticipantPipeline({ stages, totalAttempts }: { stages: Record<string, number>; totalAttempts: number }) {
  const stageDefinitions = [
    ["attention", "Attention"], ["waiting", "Waiting"], ["instruction", "Instructions"],
    ["chat", "Chat"], ["finalizing", "Finalizing"], ["quiz", "Quiz"], ["complete", "Complete"],
  ] as const;
  const maximum = Math.max(1, ...stageDefinitions.map(([key]) => stages[key] ?? 0));
  return <Card className="analytics-chart pipeline-card"><div className="chart-heading"><div><span className="card-kicker">Participant flow</span><h3>Current stage distribution</h3></div><strong>{totalAttempts}<small> attempts</small></strong></div><div className="pipeline-bars">{stageDefinitions.map(([key, label]) => { const value = stages[key] ?? 0; return <div key={key}><span>{label}</span><div><i style={{ width: `${(value / maximum) * 100}%` }} /></div><strong>{value}</strong></div>; })}</div>{(stages.aborted ?? 0) > 0 && <div className="aborted-summary"><ShieldAlert size={14} />{stages.aborted} aborted attempt{stages.aborted === 1 ? "" : "s"} require review</div>}</Card>;
}

function IntegrityChart({ types, total, rate }: { types: Record<string, number>; total: number; rate: number }) {
  const definitions = [
    ["tab_hidden", "Tab hidden"], ["window_blur", "Window blur"],
    ["fullscreen_exit", "Fullscreen exit"], ["fullscreen_error", "Fullscreen error"],
  ] as const;
  const maximum = Math.max(1, ...definitions.map(([key]) => types[key] ?? 0));
  return <Card className="analytics-chart integrity-card"><div className="chart-heading"><div><span className="card-kicker">Assessment integrity</span><h3>Focus incidents</h3></div><strong>{total}<small> total</small></strong></div>{total ? <div className="integrity-bars">{definitions.map(([key, label]) => { const value = types[key] ?? 0; return <div key={key}><div><span>{label}</span><strong>{value}</strong></div><div><i style={{ width: `${(value / maximum) * 100}%` }} /></div></div>; })}</div> : <div className="clean-integrity"><CheckCircle2 size={27} /><strong>No incidents recorded</strong><span>Focus and fullscreen checks are clean.</span></div>}<div className="integrity-rate"><span>Average per attempt</span><strong>{rate}</strong></div></Card>;
}

function DataVolumeChart({ counts }: { counts: Record<Dataset, number> | null }) {
  const maximumLog = Math.max(1, ...datasetDefinitions.map((item) => Math.log10((counts?.[item.key] ?? 0) + 1)));
  return <Card className="analytics-chart volume-card"><div className="chart-heading"><div><span className="card-kicker">Collection footprint</span><h3>Records by dataset</h3><p>Log-scaled so large keystroke volumes remain comparable with study-level records.</p></div><strong>{counts ? Object.values(counts).reduce((sum, value) => sum + value, 0).toLocaleString() : "—"}<small> total records</small></strong></div><div className="volume-grid">{datasetDefinitions.map((item) => { const value = counts?.[item.key] ?? 0; const width = value ? (Math.log10(value + 1) / maximumLog) * 100 : 0; return <div key={item.key}><div><span>{item.label}</span><strong>{value.toLocaleString()}</strong></div><div><i style={{ width: `${width}%` }} /></div></div>; })}</div></Card>;
}

export function AdminDataDashboard() {
  const [dataset, setDataset] = useState<Dataset>("attempts");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DatasetResponse | null>(null);
  const [counts, setCounts] = useState<Partial<Record<Dataset, number>>>({});
  const [summary, setSummary] = useState<SummaryResponse | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<DataRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [refreshToken, setRefreshToken] = useState(0);
  const definition = datasetDefinitions.find((item) => item.key === dataset) ?? datasetDefinitions[0];

  useEffect(() => {
    const controller = new AbortController();
    void fetchJson<SummaryResponse>("/api/admin/data?dataset=summary", controller.signal)
      .then((response) => { setSummary(response); setCounts(response.counts); setLastRefreshed(new Date()); })
      .catch((cause: unknown) => {
        if (!(cause instanceof DOMException && cause.name === "AbortError")) {
          setError(cause instanceof Error ? cause.message : "Unable to load data totals.");
        }
      })
      .finally(() => { if (!controller.signal.aborted) setSummaryLoading(false); });
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
  const refresh = () => { setLoading(true); setSummaryLoading(true); setError(""); setRefreshToken((current) => current + 1); };
  const firstRecord = result?.total ? ((result.page - 1) * result.pageSize) + 1 : 0;
  const lastRecord = result ? Math.min(result.page * result.pageSize, result.total) : 0;

  return <>
    <AnalyticsOverview summary={summary} loading={summaryLoading} lastRefreshed={lastRefreshed} onRefresh={refresh} />
    <Card className="data-browser-card">
      <div className="section-heading data-browser-heading"><div><span className="card-kicker">Research records</span><h2>Browse collected study data</h2><p>Open any row to inspect every stored field. Tables are loaded 50 records at a time.</p></div></div>
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
