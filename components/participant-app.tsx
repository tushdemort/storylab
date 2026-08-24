"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle, Check, Clock3, CopyCheck, LockKeyhole, MessageCircle,
  MonitorCheck, RefreshCw, Send, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { Button, Card, ErrorNote, Shell, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { LoggedTextarea } from "@/components/logged-textarea";
import { detectBrowserSupport, type BrowserSupport } from "@/lib/browser";
import { KeystrokeRecorder } from "@/lib/keystrokes";
import type { ChatMessage, ParticipantState, StudyConfig } from "@/lib/types";
import { apiMessage, camelizeRow, countWords, formatClock, secondsRemaining } from "@/lib/utils";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type RecorderStatus = "synced" | "syncing" | "offline" | "error";

async function jsonRequest(url: string, init?: RequestInit) {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = await response.json();
  if (!response.ok) throw new Error(apiMessage(body));
  return body;
}

export function ParticipantApp() {
  const [support, setSupport] = useState<BrowserSupport | null>(null);
  const [publicConfig, setPublicConfig] = useState<StudyConfig | null>(null);
  const [state, setState] = useState<ParticipantState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [assessmentActive, setAssessmentActive] = useState(false);
  const [fullscreenViolation, setFullscreenViolation] = useState(false);
  const [clockTick, setClockTick] = useState(0);
  const [serverOffset, setServerOffset] = useState(0);
  const stateLoadInFlight = useRef<Promise<boolean> | null>(null);
  const stateLoadQueued = useRef(false);

  const loadState = useCallback(async (silent = false) => {
    if (stateLoadInFlight.current) {
      stateLoadQueued.current = true;
      return stateLoadInFlight.current;
    }

    const request = (async () => {
      let loaded = false;
      do {
        stateLoadQueued.current = false;
        try {
          const response = await fetch("/api/participant/state", { cache: "no-store" });
          if (response.status === 401 || response.status === 404) {
            loaded = false;
            continue;
          }
          const body = await response.json();
          if (!response.ok) throw new Error(apiMessage(body));
          const next = body as ParticipantState;
          setServerOffset(new Date(next.serverNow).getTime() - Date.now());
          setState((current) => {
            if (!current?.pair?.id || current.pair.id !== next.pair?.id) return next;
            const messages = new Map(current.messages.map((message) => [message.id, message]));
            next.messages.forEach((message) => messages.set(message.id, message));
            return {
              ...next,
              messages: [...messages.values()].sort((left, right) =>
                left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
            };
          });
          setPublicConfig(next.config);
          loaded = true;
        } catch (cause) {
          loaded = false;
          if (!silent) setError(cause instanceof Error ? cause.message : "Unable to load the assessment.");
        }
      } while (stateLoadQueued.current);
      return loaded;
    })().finally(() => { stateLoadInFlight.current = null; });

    stateLoadInFlight.current = request;
    return request;
  }, []);

  const loadRecentMessages = useCallback(async (pairId: string) => {
    try {
      const supabase = getBrowserSupabase();
      const { data, error: messageError } = await supabase
        .from("messages")
        .select("id,sender_attempt_id,client_message_id,field_instance_id,body,created_at")
        .eq("pair_session_id", pairId)
        .order("created_at", { ascending: false })
        .limit(25);
      if (messageError) throw messageError;
      const incoming: ChatMessage[] = ((data ?? []) as Record<string, unknown>[])
        .map((row) => camelizeRow<ChatMessage>(row));
      setState((current) => {
        if (!current || current.pair?.id !== pairId) return current;
        const merged = new Map(current.messages.map((message) => [message.id, message]));
        incoming.forEach((message) => merged.set(message.id, message));
        return {
          ...current,
          messages: [...merged.values()].sort((left, right) =>
            left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)),
        };
      });
    } catch {
      // The periodic durable-state refresh remains a fallback if Realtime is interrupted.
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void (async () => {
      try {
        setSupport(detectBrowserSupport(
          navigator.userAgent,
          navigator.platform,
          navigator.maxTouchPoints,
          document.fullscreenEnabled,
        ));
        const resumed = await loadState(true);
        if (!resumed) {
          const result = await jsonRequest("/api/study");
          setPublicConfig(result.config as StudyConfig);
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "The study is not available.");
      } finally {
        setLoading(false);
      }
    })(), 0);
    return () => window.clearTimeout(timer);
  }, [loadState]);

  useEffect(() => {
    const timer = setInterval(() => setClockTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const attemptId = state?.attempt.id;
  const attemptStage = state?.attempt.stage;
  const pairId = state?.pair?.id;

  useEffect(() => {
    if (!attemptId || attemptStage === "complete" || attemptStage === "aborted") return;
    const heartbeat = () => void jsonRequest("/api/participant/action", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "heartbeat" }),
    }).catch(() => undefined);
    heartbeat();
    const heartbeatTimer = setInterval(heartbeat, 20_000);
    const pollTimer = setInterval(() => void loadState(true), 15_000);
    return () => { clearInterval(heartbeatTimer); clearInterval(pollTimer); };
  }, [attemptId, attemptStage, loadState]);

  useEffect(() => {
    if (!attemptId) return;
    let supabase;
    try { supabase = getBrowserSupabase(); } catch { return; }
    const channels = [
      supabase.channel(`attempt:${attemptId}`, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, () => void loadState(true)).subscribe(),
    ];
    if (pairId) {
      channels.push(supabase.channel(`pair:${pairId}`, { config: { private: true } })
        .on("broadcast", { event: "state_changed" }, (event: { payload?: unknown }) => {
          const payload = event.payload as { table?: string } | undefined;
          if (payload?.table === "messages") void loadRecentMessages(pairId);
          else void loadState(true);
        }).subscribe());
    }
    return () => { channels.forEach((channel) => void supabase.removeChannel(channel)); };
  }, [attemptId, loadRecentMessages, loadState, pairId]);

  const reportIntegrity = useCallback((eventType: "tab_hidden" | "window_blur" | "fullscreen_exit" | "fullscreen_error") => {
    const now = Date.now();
    const previous = integrityIncident.current;
    if (!previous || now - previous.at > 750) integrityIncident.current = { id: crypto.randomUUID(), at: now };
    void fetch("/api/participant/action", {
      method: "POST", headers: { "Content-Type": "application/json" }, keepalive: true,
      body: JSON.stringify({
        action: "integrity", incidentId: integrityIncident.current?.id,
        eventType, clientOccurredAt: new Date().toISOString(),
        details: { visibilityState: document.visibilityState },
      }),
    });
  }, []);
  const integrityIncident = useRef<{ id: string; at: number } | null>(null);

  useEffect(() => {
    if (!assessmentActive || !state || ["complete", "aborted"].includes(state.attempt.stage)) return;
    const hidden = () => {
      if (document.hidden) { setFullscreenViolation(true); reportIntegrity("tab_hidden"); }
    };
    const blurred = () => { setFullscreenViolation(true); reportIntegrity("window_blur"); };
    const fullscreen = () => {
      if (!document.fullscreenElement) { setFullscreenViolation(true); reportIntegrity("fullscreen_exit"); }
    };
    const fullscreenError = () => { setFullscreenViolation(true); reportIntegrity("fullscreen_error"); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", blurred);
    document.addEventListener("fullscreenchange", fullscreen);
    document.addEventListener("fullscreenerror", fullscreenError);
    return () => {
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", blurred);
      document.removeEventListener("fullscreenchange", fullscreen);
      document.removeEventListener("fullscreenerror", fullscreenError);
    };
  }, [assessmentActive, reportIntegrity, state]);

  const enterFullscreen = async () => {
    try {
      await document.documentElement.requestFullscreen();
      setAssessmentActive(true);
      setFullscreenViolation(false);
    } catch {
      setError("Fullscreen could not be started. Check your browser permissions and try again.");
    }
  };

  if (loading || support === null) return <Shell><Spinner label="Preparing your assessment…" /></Shell>;
  if (!support.supported) return <Unsupported reason={support.reason} />;
  if (error && !publicConfig) return <Shell><Card><ErrorNote>{error}</ErrorNote></Card></Shell>;
  if (!state && publicConfig) {
    return <Enrollment config={publicConfig} onStarted={async () => { await loadState(); setError(""); }} />;
  }
  if (!state) return <Shell><Spinner /></Shell>;
  if (state.attempt.stage === "complete") return <Done />;
  if (state.attempt.stage === "aborted") return <Aborted />;
  if (!assessmentActive) {
    return <FullscreenGate onEnter={enterFullscreen} error={error} />;
  }

  return (
    <Shell stage={state.attempt.stage}>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Stage
        state={state}
        now={clockTick ? clockTick + serverOffset : new Date(state.serverNow).getTime()}
        refresh={() => loadState()}
        setError={setError}
      />
      {(fullscreenViolation || !document.fullscreenElement) && <FullscreenOverlay onReturn={enterFullscreen} />}
    </Shell>
  );
}

function Enrollment({ config, onStarted }: { config: StudyConfig; onStarted: () => Promise<void> }) {
  const [participantId, setParticipantId] = useState("");
  const [consented, setConsented] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError("");
    try {
      await jsonRequest("/api/participant/start", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ participantId, consented }),
      });
      await onStarted();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Unable to start."); }
    finally { setBusy(false); }
  };
  return (
    <Shell>
      <div className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><Sparkles size={15} /> Paired storytelling study</span>
          <h1>Create something <em>together.</em></h1>
          <p>You’ll be matched with one participant for a timed, text-based collaboration.</p>
          <div className="trust-row"><ShieldCheck size={18} /><span>Your partner never sees your participant ID.</span></div>
        </div>
        <Card className="enrollment-card">
          <div className="card-kicker">Before you begin</div>
          <Markdown>{config.consentMarkdown}</Markdown>
          <div className="disclosure"><LockKeyhole size={20} /><div><strong>Keystroke recording</strong><p>{config.keystrokeDisclosure}</p></div></div>
          <form onSubmit={submit}>
            <label className="check-row">
              <input type="checkbox" checked={consented} onChange={(event) => setConsented(event.target.checked)} />
              <span>I have read this information and consent to participate and to the described keystroke recording.</span>
            </label>
            <label className="field-label" htmlFor="participant-id">Participant ID</label>
            <input id="participant-id" className="text-input" value={participantId} onChange={(event) => setParticipantId(event.target.value)} autoComplete="off" placeholder="Enter the ID provided to you" />
            {error && <ErrorNote>{error}</ErrorNote>}
            <Button type="submit" disabled={!consented || !participantId.trim() || busy}>{busy ? "Checking ID…" : "Continue"}</Button>
          </form>
        </Card>
      </div>
    </Shell>
  );
}

function FullscreenGate({ onEnter, error }: { onEnter: () => void; error: string }) {
  return <Shell><Card className="center-card"><MonitorCheck className="feature-icon" size={34} /><span className="card-kicker">Assessment mode</span><h1>Enter fullscreen to continue</h1><p>Keep this window visible throughout the task. Leaving fullscreen or changing tabs will be recorded.</p>{error && <ErrorNote>{error}</ErrorNote>}<Button onClick={onEnter}>Enter fullscreen</Button></Card></Shell>;
}

function Stage({ state, now, refresh, setError }: {
  state: ParticipantState; now: number; refresh: () => Promise<boolean>; setError: (value: string) => void;
}) {
  const act = async (payload: Record<string, unknown>, refreshAfter = true) => {
    try {
      setError("");
      const result = await jsonRequest("/api/participant/action", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (refreshAfter) await refresh();
      return result;
    } catch (cause) { setError(cause instanceof Error ? cause.message : "The action could not be completed."); throw cause; }
  };
  switch (state.attempt.stage) {
    case "attention": return <Attention prompt={state.config.attentionPrompt} submit={(response) => act({ action: "submitAttention", response })} />;
    case "waiting": return <Waiting queue={state.queue} now={now} retry={() => act({ action: "retryQueue" })} />;
    case "instruction": return <Instructions state={state} ready={() => act({ action: "ready" })} />;
    case "chat":
    case "finalizing": return <Chat state={state} now={now} act={act} refresh={refresh} />;
    case "quiz": return <Quiz state={state} submit={(answers) => act({ action: "submitQuiz", answers })} />;
    default: return null;
  }
}

function Attention({ prompt, submit }: { prompt: string; submit: (response: string) => Promise<void> }) {
  const [value, setValue] = useState(""); const [busy, setBusy] = useState(false);
  const words = countWords(value);
  return <Card className="focus-card"><span className="step-number">01</span><div className="card-kicker">Quick attention check</div><h1>{prompt}</h1><p>Your response is recorded for researcher review and is not automatically scored.</p><textarea className="large-input" value={value} onChange={(event) => { if (countWords(event.target.value) <= 50) setValue(event.target.value); }} rows={6} autoFocus /><div className={`word-count ${words === 50 ? "limit" : ""}`}>{words} / 50 words</div><Button disabled={!words || busy} onClick={async () => { setBusy(true); try { await submit(value); } catch { /* The parent displays the error. */ } finally { setBusy(false); } }}>{busy ? "Submitting…" : "Enter waiting room"}</Button></Card>;
}

function Waiting({ queue, now, retry }: { queue: ParticipantState["queue"]; now: number; retry: () => Promise<void> }) {
  const remaining = secondsRemaining(queue?.expiresAt ?? null, now);
  const expired = !queue || queue.status === "expired" || remaining <= 0;
  return <Card className="center-card waiting-card"><div className="waiting-orbit"><Users size={30} /><span /><span /></div>{expired ? <><div className="card-kicker">No match found yet</div><h1>Ready to try again?</h1><p>No partner became available during this waiting period. You can immediately start a new five-minute search.</p><Button onClick={() => void retry().catch(() => undefined)}><RefreshCw size={17} /> Try again</Button></> : <><div className="card-kicker">Finding your partner</div><h1>Stay on this page</h1><p>We’re randomly pairing you with another active participant.</p><div className="large-timer"><Clock3 size={20} />{formatClock(remaining)}</div><span className="muted">Time remaining in this search</span></>}</Card>;
}

function Instructions({ state, ready }: { state: ParticipantState; ready: () => Promise<void> }) {
  const self = state.pair?.members.find((member) => member.isSelf);
  const partner = state.pair?.members.find((member) => !member.isSelf);
  return <div className="split-layout"><Card><span className="card-kicker">You’ve been paired</span><h1>Meet {partner?.alias ?? "your partner"}</h1><Markdown>{state.config.instructionMarkdown}</Markdown><div className="alias-row"><span>You</span><strong>{self?.alias}</strong><span>Partner</span><strong>{partner?.alias}</strong></div></Card><Card className="ready-card"><CopyCheck size={30} /><h2>Read the brief carefully</h2><p>The shared timer begins only when both participants are ready.</p><div className="ready-status"><span className={self?.readyAt ? "ready" : ""}>{self?.readyAt ? <Check size={14} /> : <Clock3 size={14} />} You</span><span className={partner?.readyAt ? "ready" : ""}>{partner?.readyAt ? <Check size={14} /> : <Clock3 size={14} />} {partner?.alias}</span></div><Button disabled={Boolean(self?.readyAt)} onClick={() => void ready().catch(() => undefined)}>{self?.readyAt ? "Waiting for partner…" : "I’m ready"}</Button></Card></div>;
}

function Chat({ state, now, act, refresh }: {
  state: ParticipantState; now: number; act: (payload: Record<string, unknown>, refreshAfter?: boolean) => Promise<unknown>; refresh: () => Promise<boolean>;
}) {
  const pair = state.pair;
  const [message, setMessage] = useState("");
  const [story, setStory] = useState("");
  const [messageDraftId, setMessageDraftId] = useState(() => crypto.randomUUID());
  const [storyDraftId, setStoryDraftId] = useState(() => crypto.randomUUID());
  const [pendingMessages, setPendingMessages] = useState<ChatMessage[]>([]);
  const [syncStatus, setSyncStatus] = useState<RecorderStatus>("synced");
  const [submittingStory, setSubmittingStory] = useState(false);
  const [decidingStory, setDecidingStory] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const recorder = useMemo(() => new KeystrokeRecorder(state.attempt.id), [state.attempt.id]);
  const remaining = secondsRemaining(pair?.chatEndsAt ?? null, now);
  const storyUnlocked = Boolean(pair?.chatEndsAt) && remaining === 0;
  const partner = pair?.members.find((member) => !member.isSelf);
  const latestProposal = state.proposal;

  useEffect(() => recorder.subscribe(setSyncStatus), [recorder]);
  useEffect(() => () => { void recorder.stop(); }, [recorder]);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.hidden) void recorder.flush(true); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, [recorder]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [pendingMessages, state.messages]);
  if (!pair) return <Card><ErrorNote>Pair information is unavailable.</ErrorNote></Card>;
  const context = { recorder, attemptId: state.attempt.id, pairSessionId: pair.id };
  const visibleMessages = [
    ...state.messages,
    ...pendingMessages.filter((pending) => !state.messages.some((item) => item.clientMessageId === pending.clientMessageId)),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
  const send = async () => {
    if (!message.trim()) return;
    const body = message; const draft = messageDraftId;
    const clientMessageId = crypto.randomUUID();
    setPendingMessages((current) => [...current, {
      id: `pending:${clientMessageId}`,
      senderAttemptId: state.attempt.id,
      clientMessageId,
      fieldInstanceId: draft,
      body,
      createdAt: new Date().toISOString(),
    }]);
    setMessage(""); setMessageDraftId(crypto.randomUUID());
    void recorder.flush();
    try { await act({ action: "message", body, clientMessageId, fieldInstanceId: draft }, false); }
    catch {
      setPendingMessages((current) => current.filter((item) => item.id !== `pending:${clientMessageId}`));
      setMessage(body); setMessageDraftId(draft);
    }
  };
  const propose = async () => {
    if (!story.trim() || submittingStory) return;
    setSubmittingStory(true);
    void recorder.flush();
    try {
      await act({ action: "proposeStory", body: story, fieldInstanceId: storyDraftId }, false);
      setStory(""); setStoryDraftId(crypto.randomUUID());
      void refresh();
    } finally {
      setSubmittingStory(false);
    }
  };
  const decide = async (decision: "agree" | "disagree") => {
    if (!latestProposal || decidingStory) return;
    setDecidingStory(true);
    void recorder.flush();
    try {
      await act({ action: "decideStory", proposalId: latestProposal.id, decision }, false);
      void refresh();
    } finally {
      setDecidingStory(false);
    }
  };

  return <div className="workspace-grid"><section className="chat-panel"><header className="chat-header"><div><span className="online-dot" /><strong>{partner?.alias ?? "Partner"}</strong><small>Connected to your shared room</small></div><div className={`compact-timer ${storyUnlocked ? "done" : ""}`}><Clock3 size={16} />{storyUnlocked ? "Story unlocked" : formatClock(remaining)}</div></header><div className="messages" aria-live="polite">{visibleMessages.length === 0 && <div className="empty-chat"><MessageCircle size={28} /><p>Start the conversation when you’re ready.</p></div>}{visibleMessages.map((item) => { const mine = item.senderAttemptId === state.attempt.id; return <div key={item.id} className={`message-row ${mine ? "mine" : "theirs"}`}><div className="message-bubble"><span>{item.body}</span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div></div>; })}<div ref={endRef} /></div><div className="composer"><LoggedTextarea {...context} fieldType="chat" fieldInstanceId={messageDraftId} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={`Message ${partner?.alias ?? "your partner"}`} maxLength={2000} rows={2} /><Button aria-label="Send message" onClick={() => void send()} disabled={!message.trim()}><Send size={18} /></Button><div className={`sync-state ${syncStatus}`}><span />{syncStatus === "synced" ? "Typing data saved" : syncStatus === "syncing" ? "Saving typing data…" : "Typing data will retry"}</div></div></section><aside className="story-panel">{!storyUnlocked ? <><span className="card-kicker">Final story</span><h2>Keep creating</h2><p>The story workspace unlocks when your shared discussion timer reaches zero.</p><div className="story-lock"><LockKeyhole size={25} />{formatClock(remaining)}</div></> : latestProposal?.status === "pending" ? <ProposalCard proposal={latestProposal} state={state} decide={decide} busy={decidingStory} /> : <><span className="card-kicker">Final story</span><h2>{latestProposal?.status === "rejected" ? "Revise the proposal" : "Propose your story"}</h2><p>Either partner can submit. Both of you must approve the exact same version.</p><LoggedTextarea {...context} fieldType="story" fieldInstanceId={storyDraftId} className="story-input" value={story} onChange={(event) => setStory(event.target.value)} placeholder="Write the complete final story here…" rows={14} /><Button disabled={!story.trim() || submittingStory} onClick={() => void propose().catch(() => undefined)}>{submittingStory ? "Submitting…" : "Submit proposal"}</Button></>}</aside></div>;
}

function ProposalCard({ proposal, state, decide, busy }: { proposal: NonNullable<ParticipantState["proposal"]>; state: ParticipantState; decide: (value: "agree" | "disagree") => Promise<void>; busy: boolean }) {
  const mine = proposal.approvals.find((approval) => approval.attemptId === state.attempt.id)?.decision;
  const agrees = proposal.approvals.filter((approval) => approval.decision === "agree").length;
  return <><span className="card-kicker">Proposal {proposal.version}</span><h2>Review the final story</h2><div className="proposal-text">{proposal.body}</div><div className="approval-count"><span className={agrees >= 1 ? "filled" : ""} /><span className={agrees >= 2 ? "filled" : ""} />{agrees} of 2 approvals</div>{mine ? <p className="decision-note"><Check size={16} /> You selected <strong>{mine}</strong>. Waiting for your partner.</p> : <div className="button-row"><Button className="secondary" disabled={busy} onClick={() => void decide("disagree").catch(() => undefined)}>Disagree</Button><Button disabled={busy} onClick={() => void decide("agree").catch(() => undefined)}>{busy ? "Submitting…" : "Agree with story"}</Button></div>}</>;
}

function Quiz({ state, submit }: { state: ParticipantState; submit: (answers: Record<string, string>) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>(state.quizResponses);
  const [busy, setBusy] = useState(false);
  const complete = state.config.quizQuestions.every((question) => answers[question.id]);
  return <Card className="quiz-card"><span className="step-number">Final</span><div className="card-kicker">Individual quiz</div><h1>A few final questions</h1><p>Your responses are private from your partner. Select one answer for each question.</p><div className="question-list">{state.config.quizQuestions.map((question, index) => <fieldset key={question.id}><legend><span>{index + 1}</span>{question.prompt}</legend><div className="option-grid">{question.options.map((option) => <label key={option.value} className={answers[question.id] === option.value ? "selected" : ""}><input type="radio" name={question.id} value={option.value} checked={answers[question.id] === option.value} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.value }))} /><span>{option.label}</span></label>)}</div></fieldset>)}</div><Button disabled={!complete || busy} onClick={async () => { setBusy(true); try { await submit(answers); } finally { setBusy(false); } }}>{busy ? "Submitting…" : "Submit and finish"}</Button></Card>;
}

function FullscreenOverlay({ onReturn }: { onReturn: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true"><Card className="modal-card"><AlertTriangle size={35} /><h2>Return to the assessment</h2><p>Leaving fullscreen or changing windows has been recorded. Your timer continued to run.</p><Button onClick={onReturn}>Return to fullscreen</Button></Card></div>;
}

function Unsupported({ reason }: { reason?: string }) {
  return <Shell><Card className="center-card"><AlertTriangle className="warning-icon" size={36} /><div className="card-kicker">Unsupported browser</div><h1>Use desktop Chrome or Safari</h1><p>{reason ?? "This assessment requires a supported desktop browser."}</p></Card></Shell>;
}

function Aborted() {
  return <Shell><Card className="center-card"><AlertTriangle className="warning-icon" size={36} /><div className="card-kicker">Session ended</div><h1>Your paired session has closed</h1><p>Your partner did not reconnect within the allowed time. Please contact the researcher to reschedule or reset your participant ID.</p></Card></Shell>;
}

function Done() {
  return <Shell><Card className="center-card done-card"><div className="success-mark"><Check size={34} /></div><div className="card-kicker">Assessment complete</div><h1>Thank you for taking part.</h1><p>Your responses have been submitted successfully. You may now close this window.</p></Card></Shell>;
}
