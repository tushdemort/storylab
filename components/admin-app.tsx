"use client";

import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  BarChart3, Database, Download, FileUp, KeyRound, LogOut, RefreshCw, Save, Search, Settings2,
  ShieldCheck, Trash2, Users,
} from "lucide-react";
import { AdminDataDashboard } from "@/components/admin-data-dashboard";
import { Button, Card, ErrorNote, Shell, Spinner } from "@/components/ui";
import type { StudyConfig } from "@/lib/types";
import { apiMessage } from "@/lib/utils";

type AdminAttempt = {
  id: string;
  participantCodeId: string;
  participantId: string;
  codeStatus: string;
  stage: string;
  pairSessionId: string | null;
  startedAt: string;
  completedAt: string | null;
  lastSeenAt: string;
};

type AdminPair = {
  id: string;
  status: string;
  pairedAt: string;
  chatEndsAt: string | null;
  completedAt: string | null;
  abortedAt: string | null;
};

type AdminParticipantCode = {
  id: string;
  participantId: string;
  status: "available" | "active" | "completed";
  currentAttemptId: string | null;
  createdAt: string;
  updatedAt: string;
};

type AdminState = {
  config: StudyConfig;
  attempts: AdminAttempt[];
  participantCodes: AdminParticipantCode[];
  pairs: AdminPair[];
  counts: Record<string, number>;
  adminEmail: string;
};

async function requestJson(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(apiMessage(body));
  return body;
}

export function AdminApp() {
  const [state, setState] = useState<AdminState | null>(null);
  const [loading, setLoading] = useState(true);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"overview" | "ids" | "participants" | "content" | "dashboard" | "data">("overview");

  const refresh = useCallback(async () => {
    try {
      const result = await requestJson("/api/admin/state");
      setState(result as AdminState); setSignedOut(false); setError("");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Unable to load admin data.";
      if (/sign-in|required/i.test(message)) setSignedOut(true);
      else setError(message);
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (loading) return <Shell><Spinner label="Opening researcher console…" /></Shell>;
  if (signedOut || !state) return <AdminLogin onSuccess={refresh} error={error} />;

  const logout = async () => {
    await requestJson("/api/admin/logout", { method: "POST" });
    setState(null); setSignedOut(true);
  };

  return (
    <div className="admin-shell">
      <aside className="admin-nav">
        <a className="brand admin-brand" href="/admin"><span className="brand-mark">S</span><span>StoryLab</span></a>
        <div className="admin-label">Research console</div>
        <nav>
          <button className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}><BarChart3 size={18} />Overview</button>
          <button className={tab === "ids" ? "active" : ""} onClick={() => setTab("ids")}><KeyRound size={18} />Participant IDs</button>
          <button className={tab === "participants" ? "active" : ""} onClick={() => setTab("participants")}><Users size={18} />Attempts</button>
          <button className={tab === "content" ? "active" : ""} onClick={() => setTab("content")}><Settings2 size={18} />Study content</button>
          <button className={tab === "dashboard" ? "active" : ""} onClick={() => setTab("dashboard")}><Database size={18} />Study data</button>
          <button className={tab === "data" ? "active" : ""} onClick={() => setTab("data")}><Download size={18} />Data export</button>
        </nav>
        <div className="admin-user"><span>{state.adminEmail}</span><button onClick={() => void logout()}><LogOut size={16} />Sign out</button></div>
      </aside>
      <main className="admin-main">
        <header className="admin-top"><div><span className="eyebrow">Study version {state.config.version}</span><h1>{tab === "overview" ? "Study overview" : tab === "ids" ? "Approved participant IDs" : tab === "participants" ? "Participant attempts" : tab === "content" ? "Study content" : tab === "dashboard" ? "Study data dashboard" : "Export study data"}</h1></div><Button className="secondary small" onClick={() => void refresh()}><RefreshCw size={16} />Refresh</Button></header>
        {error && <ErrorNote>{error}</ErrorNote>}
        {tab === "overview" && <Overview state={state} />}
        {tab === "ids" && <ParticipantIds state={state} refresh={refresh} setError={setError} />}
        {tab === "participants" && <Participants state={state} refresh={refresh} setError={setError} />}
        {tab === "content" && <ContentEditor config={state.config} refresh={refresh} setError={setError} />}
        {tab === "dashboard" && <AdminDataDashboard />}
        {tab === "data" && <DataExport config={state.config} />}
      </main>
    </div>
  );
}

function AdminLogin({ onSuccess, error: outerError }: { onSuccess: () => Promise<void>; error: string }) {
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [error, setError] = useState(outerError); const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await requestJson("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email, password }) });
      await onSuccess();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Sign-in failed."); }
    finally { setBusy(false); }
  };
  return <Shell><Card className="login-card"><ShieldCheck className="feature-icon" size={34} /><div className="card-kicker">Researcher access</div><h1>Sign in to StoryLab</h1><p>Only email addresses listed in the deployment allowlist can access participant data.</p><form onSubmit={submit}><label className="field-label" htmlFor="admin-email">Email</label><input id="admin-email" className="text-input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" /><label className="field-label" htmlFor="admin-password">Password</label><input id="admin-password" className="text-input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />{error && <ErrorNote>{error}</ErrorNote>}<Button type="submit" disabled={busy || !email || !password}>{busy ? "Signing in…" : "Sign in"}</Button></form></Card></Shell>;
}

function Overview({ state }: { state: AdminState }) {
  const active = (state.counts.waiting ?? 0) + (state.counts.instruction ?? 0) + (state.counts.chat ?? 0) + (state.counts.finalizing ?? 0) + (state.counts.quiz ?? 0);
  const cards = [
    ["Active now", active, "Participants currently in progress"],
    ["Waiting", state.counts.waiting ?? 0, "Available for random matching"],
    ["Completed", state.counts.complete ?? 0, "Individual quiz submissions"],
    ["Aborted", state.counts.aborted ?? 0, "Attempts requiring researcher review"],
  ] as const;
  return <><div className="metric-grid">{cards.map(([label, value, detail]) => <Card key={label} className="metric"><span>{label}</span><strong>{value}</strong><small>{detail}</small></Card>)}</div><Card><div className="section-heading"><div><span className="card-kicker">Recent activity</span><h2>Latest attempts</h2></div></div><AttemptTable attempts={state.attempts.slice(0, 8)} /></Card></>;
}

function ParticipantIds({ state, refresh, setError }: { state: AdminState; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [result, setResult] = useState(""); const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"all" | AdminParticipantCode["status"]>("all");
  const filteredCodes = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase();
    return state.participantCodes
      .filter((code) => status === "all" || code.status === status)
      .filter((code) => !normalizedQuery || code.participantId.toLocaleLowerCase().includes(normalizedQuery))
      .sort((left, right) => left.participantId.localeCompare(right.participantId, undefined, { numeric: true }));
  }, [query, state.participantCodes, status]);
  const statusCounts = useMemo(() => state.participantCodes.reduce<Record<AdminParticipantCode["status"], number>>((counts, code) => {
    counts[code.status] += 1;
    return counts;
  }, { available: 0, active: 0, completed: 0 }), [state.participantCodes]);
  const upload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      const form = new FormData(event.currentTarget);
      const response = await requestJson("/api/admin/participants", { method: "POST", body: form }) as { inserted: number; duplicates: number };
      setResult(`${response.inserted} IDs imported; ${response.duplicates} duplicates skipped.`); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Import failed."); }
    finally { setBusy(false); }
  };
  const reset = async (code: AdminParticipantCode) => {
    if (!confirm(`Reset ${code.participantId}? Its current attempt will be marked aborted and the ID will become available again.`)) return;
    try { await requestJson("/api/admin/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resetCode", codeId: code.id }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Reset failed."); }
  };
  return <><Card><div className="section-heading"><div><span className="card-kicker">ID roster</span><h2>Import approved IDs</h2><p>Upload a CSV whose first column contains one ID per row. A header row is optional.</p></div><form className="upload-form" onSubmit={upload}><label className="file-button"><FileUp size={17} /><span>Choose CSV</span><input name="file" type="file" accept=".csv,text/csv" required /></label><Button type="submit" disabled={busy}>{busy ? "Importing…" : "Import IDs"}</Button></form></div>{result && <div className="success-note">{result}</div>}</Card><div className="id-metric-grid"><Card><span>Total approved</span><strong>{state.participantCodes.length}</strong></Card><Card><span>Available</span><strong>{statusCounts.available}</strong></Card><Card><span>In use</span><strong>{statusCounts.active}</strong></Card><Card><span>Completed</span><strong>{statusCounts.completed}</strong></Card></div><Card><div className="section-heading id-roster-heading"><div><span className="card-kicker">Allowlist</span><h2>Approved participant IDs</h2><p>Only IDs in this list can begin the assessment.</p></div><div className="id-filters"><label className="search-control"><Search size={16} /><input aria-label="Search participant IDs" placeholder="Search IDs" value={query} onChange={(event) => setQuery(event.target.value)} /></label><select aria-label="Filter participant IDs by status" value={status} onChange={(event) => setStatus(event.target.value as typeof status)}><option value="all">All statuses</option><option value="available">Available</option><option value="active">In use</option><option value="completed">Completed</option></select></div></div><div className="table-wrap"><table><thead><tr><th>Participant ID</th><th>Status</th><th>Added</th><th>Last updated</th><th /></tr></thead><tbody>{filteredCodes.map((code) => <tr key={code.id}><td><strong>{code.participantId}</strong></td><td><span className={`status-pill ${code.status}`}>{code.status === "active" ? "In use" : code.status}</span></td><td>{new Date(code.createdAt).toLocaleString()}</td><td>{new Date(code.updatedAt).toLocaleString()}</td><td>{code.status !== "available" && <button className="table-action" onClick={() => void reset(code)}><RefreshCw size={14} />Reset ID</button>}</td></tr>)}{!filteredCodes.length && <tr><td colSpan={5} className="empty-cell">{state.participantCodes.length ? "No IDs match these filters." : "No participant IDs have been imported."}</td></tr>}</tbody></table></div></Card></>;
}

function Participants({ state, refresh, setError }: { state: AdminState; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const reset = async (attempt: AdminAttempt) => {
    if (!confirm(`Reset ${attempt.participantId}? Its current attempt will be marked aborted.`)) return;
    try { await requestJson("/api/admin/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "resetCode", codeId: attempt.participantCodeId }) }); await refresh(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Reset failed."); }
  };
  return <Card><div className="section-heading"><div><span className="card-kicker">Attempts</span><h2>Participant status</h2></div></div><AttemptTable attempts={state.attempts} onReset={reset} /></Card>;
}

function AttemptTable({ attempts, onReset }: { attempts: AdminAttempt[]; onReset?: (attempt: AdminAttempt) => void }) {
  return <div className="table-wrap"><table><thead><tr><th>Participant ID</th><th>Stage</th><th>Started</th><th>Last seen</th>{onReset && <th />}</tr></thead><tbody>{attempts.map((attempt) => <tr key={attempt.id}><td><strong>{attempt.participantId}</strong></td><td><span className={`status-pill ${attempt.stage}`}>{attempt.stage}</span></td><td>{new Date(attempt.startedAt).toLocaleString()}</td><td>{new Date(attempt.lastSeenAt).toLocaleString()}</td>{onReset && <td><button className="table-action" onClick={() => onReset(attempt)}><RefreshCw size={14} />Reset ID</button></td>}</tr>)}{!attempts.length && <tr><td colSpan={onReset ? 5 : 4} className="empty-cell">No attempts yet.</td></tr>}</tbody></table></div>;
}

function ContentEditor({ config, refresh, setError }: { config: StudyConfig; refresh: () => Promise<void>; setError: (value: string) => void }) {
  const [form, setForm] = useState(config);
  const [quizJson, setQuizJson] = useState(() => JSON.stringify(config.quizQuestions, null, 2));
  const [busy, setBusy] = useState(false); const [success, setSuccess] = useState("");
  const update = (key: keyof StudyConfig, value: string | number) => setForm((current) => ({ ...current, [key]: value }));
  const publish = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError(""); setSuccess("");
    try {
      const quizQuestions = JSON.parse(quizJson);
      await requestJson("/api/admin/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, quizQuestions }) });
      setSuccess("A new study version was published. Existing attempts remain on their original version."); await refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Publishing failed."); }
    finally { setBusy(false); }
  };
  return <form onSubmit={publish}><Card className="form-card"><div className="section-heading"><div><span className="card-kicker">Versioned settings</span><h2>Participant-facing content</h2><p>Publishing creates a new immutable version for future attempts.</p></div></div><label className="field-label">Consent text (Markdown)</label><textarea className="admin-textarea" rows={6} value={form.consentMarkdown} onChange={(event) => update("consentMarkdown", event.target.value)} required /><label className="field-label">Mandatory keystroke disclosure</label><textarea className="admin-textarea" rows={5} value={form.keystrokeDisclosure} onChange={(event) => update("keystrokeDisclosure", event.target.value)} required /><label className="field-label">Attention prompt</label><textarea className="admin-textarea" rows={3} value={form.attentionPrompt} onChange={(event) => update("attentionPrompt", event.target.value)} required /><label className="field-label">Instruction card (Markdown)</label><textarea className="admin-textarea" rows={5} value={form.instructionMarkdown} onChange={(event) => update("instructionMarkdown", event.target.value)} required /></Card><Card className="form-card"><div className="section-heading"><div><span className="card-kicker">Timing and quiz</span><h2>Session rules</h2></div></div><div className="number-grid"><label>Waiting room (seconds)<input type="number" min={10} max={3600} value={form.waitSeconds} onChange={(event) => update("waitSeconds", Number(event.target.value))} /></label><label>Chat duration (seconds)<input type="number" min={10} max={14400} value={form.chatSeconds} onChange={(event) => update("chatSeconds", Number(event.target.value))} /></label><label>Reconnect grace (seconds)<input type="number" min={30} max={3600} value={form.reconnectSeconds} onChange={(event) => update("reconnectSeconds", Number(event.target.value))} /></label></div><label className="field-label">Multiple-choice questions (JSON)</label><textarea className="admin-textarea code-input" rows={18} value={quizJson} onChange={(event) => setQuizJson(event.target.value)} spellCheck={false} />{success && <div className="success-note">{success}</div>}<Button type="submit" disabled={busy}><Save size={17} />{busy ? "Publishing…" : "Publish new version"}</Button></Card></form>;
}

function DataExport({ config }: { config: StudyConfig }) {
  const [status, setStatus] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const url = useMemo(() => {
    const params = new URLSearchParams();
    if (status) params.set("status", status); if (from) params.set("from", from); if (to) params.set("to", to);
    return `/api/admin/export?${params}`;
  }, [from, status, to]);
  return <><Card><span className="card-kicker">Research dataset</span><h2>Download a filtered ZIP</h2><p>The archive contains separate CSV files for attempts, pairs, chat, raw keystrokes, story decisions, quiz responses, and integrity incidents.</p><div className="filter-grid"><label>Status<select value={status} onChange={(event) => setStatus(event.target.value)}><option value="">All statuses</option>{["attention","waiting","instruction","chat","finalizing","quiz","complete","aborted"].map((value) => <option key={value}>{value}</option>)}</select></label><label>From date<input type="date" value={from} onChange={(event) => setFrom(event.target.value)} /></label><label>To date<input type="date" value={to} onChange={(event) => setTo(event.target.value)} /></label></div><a className="button download-button" href={url}><Download size={17} />Download data</a></Card><Card className="danger-zone"><div><span className="card-kicker">Retention</span><h2>Manual deletion</h2><p>Data is retained until a researcher deletes a complete pair. Deletion removes both participants’ messages, stories, quizzes, integrity records, and keystrokes.</p></div><PairDeletion version={config.version} /></Card></>;
}

function PairDeletion({ version }: { version: number }) {
  const [pairId, setPairId] = useState(""); const [confirmation, setConfirmation] = useState(""); const [message, setMessage] = useState("");
  const remove = async () => {
    try { await requestJson("/api/admin/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "deletePair", pairId, confirmation }) }); setMessage("Pair data deleted."); setPairId(""); setConfirmation(""); }
    catch (cause) { setMessage(cause instanceof Error ? cause.message : "Deletion failed."); }
  };
  return <div className="delete-controls"><input className="text-input" placeholder="Pair UUID" value={pairId} onChange={(event) => setPairId(event.target.value)} /><input className="text-input" placeholder="Type DELETE" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /><Button className="danger" disabled={!pairId || confirmation !== "DELETE"} onClick={() => void remove()}><Trash2 size={17} />Delete pair</Button>{message && <small>{message} Study version {version} remains available.</small>}</div>;
}
