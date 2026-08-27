"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  AlertTriangle, Check, Clock3, LockKeyhole,
  MonitorCheck, RefreshCw, ShieldCheck, Sparkles, Users,
} from "lucide-react";
import { Button, Card, ErrorNote, Shell, Spinner } from "@/components/ui";
import { Markdown } from "@/components/markdown";
import { OnlinePresence } from "@/components/online-presence";
import { ParticipantTutorial } from "@/components/participant-tutorial";
import { PageGuide, type PageGuideStep } from "@/components/page-guide";
import { CollaborationWorkspace } from "@/components/collaboration-workspace";
import { detectBrowserSupport, type BrowserSupport } from "@/lib/browser";
import { mergeOutlineBatches } from "@/lib/collaborative-outline";
import type { ChatMessage, OutlineOperationBatch, ParticipantState, StudyConfig } from "@/lib/types";
import { apiMessage, camelizeRow, countWords, formatClock, secondsRemaining } from "@/lib/utils";
import { getBrowserSupabase } from "@/lib/supabase/browser";

const enrollmentGuide: PageGuideStep[] = [
  { selector: ".hero-copy", title: "Your assessment at a glance", text: "This side summarizes the paired storytelling task and reminds you that your participant ID remains private." },
  { selector: ".enrollment-card .markdown", title: "Read the consent information", text: "Review the study information before continuing. You can scroll inside this section if the full text is longer." },
  { selector: ".disclosure", title: "Understand keystroke recording", text: "Typing is recorded only in the chat and final-story fields. Nothing typed in your ID, attention check, quiz, or other websites is captured." },
  { selector: ".enrollment-card form", title: "Consent and enter your ID", text: "Check the consent box, enter the ID supplied by the researcher, then select Continue." },
];
const fullscreenGuide: PageGuideStep[] = [
  { selector: ".center-card", title: "Enter assessment mode", text: "Select Enter fullscreen to begin. Keep the assessment visible; leaving fullscreen or changing tabs is recorded." },
  { selector: ".center-card .button", title: "Start when you’re ready", text: "This button requires a direct click because browsers do not allow websites to enter fullscreen automatically." },
];
const attentionGuide: PageGuideStep[] = [
  { selector: ".focus-card h1", title: "Read the sentence prompt", text: "Complete the sentence in your own words. This answer is stored for researcher review but is not automatically scored." },
  { selector: ".focus-card textarea", title: "Write a short response", text: "Enter at least one word. The live counter keeps the response within the 50-word maximum." },
  { selector: ".focus-card .button", title: "Continue to matchmaking", text: "When your response is ready, use this button to enter the waiting room." },
];
const waitingGuide: PageGuideStep[] = [
  { selector: ".waiting-card", title: "Stay here while we find a partner", text: "Matchmaking is random and the countdown survives refreshes. If no one is available, you can start another search without repeating earlier steps." },
];
const quizGuide: PageGuideStep[] = [
  { selector: ".quiz-card h1", title: "Complete your individual survey", text: "Your answers are submitted separately and are not shown to your partner." },
  { selector: ".question-list", title: "Answer every question", text: "Choose one response for each required question. You can change an answer before submitting." },
  { selector: ".quiz-card > .button", title: "Submit and finish", text: "Once every question has an answer, submit the quiz to complete the assessment and lock your participant ID." },
];

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
              outlineOperationBatches: mergeOutlineBatches(
                current.outlineOperationBatches,
                next.outlineOperationBatches,
              ),
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
    if (!attemptStage || !["instruction", "chat", "finalizing"].includes(attemptStage)) return;
    const announceDeparture = () => {
      const body = JSON.stringify({ action: "leavePair" });
      const queued = navigator.sendBeacon(
        "/api/participant/action",
        new Blob([body], { type: "application/json" }),
      );
      if (!queued) {
        void fetch("/api/participant/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          keepalive: true,
        });
      }
    };
    window.addEventListener("pagehide", announceDeparture);
    window.addEventListener("beforeunload", announceDeparture);
    return () => {
      window.removeEventListener("pagehide", announceDeparture);
      window.removeEventListener("beforeunload", announceDeparture);
    };
  }, [attemptStage]);

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
          const payload = event.payload as { table?: string; batches?: OutlineOperationBatch[] } | undefined;
          if (payload?.table === "messages") void loadRecentMessages(pairId);
          else if (payload?.table === "outline_operation_batches" && Array.isArray(payload.batches)) {
            setState((current) => current?.pair?.id === pairId ? {
              ...current,
              outlineOperationBatches: mergeOutlineBatches(current.outlineOperationBatches, payload.batches!),
            } : current);
          }
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
    <Shell stage={state.attempt.stage} headerExtra={["attention", "waiting"].includes(state.attempt.stage) ? <OnlinePresence /> : undefined}>
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
    <Shell headerExtra={<OnlinePresence />}>
      <div className="hero-grid">
        <div className="hero-copy">
          <span className="eyebrow"><Sparkles size={15} /> Paired storytelling study</span>
          <h1>Create something <em>together.</em></h1>
          <p>You’ll be matched with one participant for a timed, text-based collaboration.</p>
          <div className="trust-row"><ShieldCheck size={18} /><span>Your partner never sees your participant ID.</span></div>
          <ParticipantTutorial config={config} />
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
      <PageGuide tourKey="enrollment" steps={enrollmentGuide} waitForOverview />
    </Shell>
  );
}

function FullscreenGate({ onEnter, error }: { onEnter: () => void; error: string }) {
  return <Shell headerExtra={<OnlinePresence />}><Card className="center-card"><MonitorCheck className="feature-icon" size={34} /><span className="card-kicker">Assessment mode</span><h1>Enter fullscreen to continue</h1><p>Keep this window visible throughout the task. Leaving fullscreen or changing tabs will be recorded.</p>{error && <ErrorNote>{error}</ErrorNote>}<Button onClick={onEnter}>Enter fullscreen</Button></Card><PageGuide tourKey="fullscreen" steps={fullscreenGuide} /></Shell>;
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
    case "instruction":
    case "chat":
    case "finalizing": return <CollaborationWorkspace state={state} now={now} act={act} refresh={refresh} />;
    case "quiz": return <><Quiz state={state} submit={(answers) => act({ action: "submitQuiz", answers })} /><PageGuide tourKey="quiz" steps={quizGuide} /></>;
    default: return null;
  }
}

function Attention({ prompt, submit }: { prompt: string; submit: (response: string) => Promise<void> }) {
  const [value, setValue] = useState(""); const [busy, setBusy] = useState(false);
  const words = countWords(value);
  return <><Card className="focus-card"><span className="step-number">01</span><div className="card-kicker">Quick attention check</div><h1>{prompt}</h1><p>Your response is recorded for researcher review and is not automatically scored.</p><textarea className="large-input" value={value} onChange={(event) => { if (countWords(event.target.value) <= 50) setValue(event.target.value); }} rows={6} autoFocus /><div className={`word-count ${words === 50 ? "limit" : ""}`}>{words} / 50 words</div><Button disabled={!words || busy} onClick={async () => { setBusy(true); try { await submit(value); } catch { /* The parent displays the error. */ } finally { setBusy(false); } }}>{busy ? "Submitting…" : "Enter waiting room"}</Button></Card><PageGuide tourKey="attention" steps={attentionGuide} /></>;
}

function Waiting({ queue, now, retry }: { queue: ParticipantState["queue"]; now: number; retry: () => Promise<void> }) {
  const remaining = secondsRemaining(queue?.expiresAt ?? null, now);
  const expired = !queue || queue.status === "expired" || remaining <= 0;
  return <><Card className="center-card waiting-card"><div className="waiting-orbit"><Users size={30} /><span /><span /></div>{expired ? <><div className="card-kicker">No match found yet</div><h1>Ready to try again?</h1><p>No partner became available during this waiting period. You can immediately start a new five-minute search.</p><Button onClick={() => void retry().catch(() => undefined)}><RefreshCw size={17} /> Try again</Button></> : <><div className="card-kicker">Finding your partner</div><h1>Stay on this page</h1><p>We’re randomly pairing you with another active participant.</p><div className="large-timer"><Clock3 size={20} />{formatClock(remaining)}</div><span className="muted">Time remaining in this search</span></>}</Card><PageGuide tourKey="waiting" steps={waitingGuide} /></>;
}

function Quiz({ state, submit }: { state: ParticipantState; submit: (answers: Record<string, string>) => Promise<void> }) {
  const [answers, setAnswers] = useState<Record<string, string>>(state.quizResponses);
  const [busy, setBusy] = useState(false);
  const complete = state.config.quizQuestions.every((question) => answers[question.id]);
  return <Card className="quiz-card"><span className="step-number">Final</span><div className="card-kicker">Individual survey</div><h1>A few final questions</h1><p>Your responses are private from your partner. Select one answer for each question.</p><div className="question-list">{state.config.quizQuestions.map((question, index) => <fieldset key={question.id}><legend><span>{index + 1}</span>{question.prompt}</legend><div className="option-grid">{question.options.map((option) => <label key={option.value} className={answers[question.id] === option.value ? "selected" : ""}><input type="radio" name={question.id} value={option.value} checked={answers[question.id] === option.value} onChange={() => setAnswers((current) => ({ ...current, [question.id]: option.value }))} /><span>{option.label}</span></label>)}</div></fieldset>)}</div><Button disabled={!complete || busy} onClick={async () => { setBusy(true); try { await submit(answers); } finally { setBusy(false); } }}>{busy ? "Submitting…" : "Submit and finish"}</Button></Card>;
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
