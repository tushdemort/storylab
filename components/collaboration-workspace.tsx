"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check, Clock3, FileText, Lightbulb, LockKeyhole, MessageCircle, PencilLine,
  Send, ShieldCheck, WifiOff,
} from "lucide-react";
import { LiveOutlineEditor, type LiveOutlineController } from "@/components/live-outline-editor";
import { LoggedTextarea } from "@/components/logged-textarea";
import { Markdown } from "@/components/markdown";
import { PageGuide, type PageGuideStep } from "@/components/page-guide";
import { Button, Card, ErrorNote } from "@/components/ui";
import { KeystrokeRecorder } from "@/lib/keystrokes";
import { outlineSnapshot } from "@/lib/collaborative-outline";
import type { ChatMessage, CollaborationPhase, ParticipantState } from "@/lib/types";
import { formatClock, secondsRemaining, secondsRemainingAfter } from "@/lib/utils";

type RecorderStatus = "synced" | "syncing" | "offline" | "error";
type Action = (payload: Record<string, unknown>, refreshAfter?: boolean) => Promise<unknown>;

const phaseOrder: Array<{ key: CollaborationPhase; label: string; short: string }> = [
  { key: "ideation", label: "Ideation", short: "Ideas" },
  { key: "discussion", label: "Discussion", short: "Discuss" },
  { key: "outline", label: "Outline", short: "Outline" },
  { key: "writing", label: "Final story", short: "Write" },
];

const guides: Record<CollaborationPhase, PageGuideStep[]> = {
  ideation: [
    { selector: ".phase-brief", title: "Start with the phase brief", text: "The left panel always shows the current instructions, prompt, minimum timer, and next-step control." },
    { selector: ".private-idea-board", title: "Develop ideas privately", text: "Write your own ideas here. These notes are autosaved and are never shown to the other participant." },
    { selector: ".phase-timer", title: "Use the full ideation time", text: "You can continue only after the minimum timer reaches zero. Your work is still editable afterward." },
    { selector: ".phase-advance", title: "Signal that you are ready", text: "When the timer ends, select this button. The discussion phase opens only when the next stage is ready." },
  ],
  discussion: [
    { selector: ".phase-brief", title: "Use the discussion prompt", text: "The phase brief keeps the task instructions and required minimum time visible while you work." },
    { selector: ".phase-chat", title: "Meet your partner", text: "Your anonymous partner and their messages are visible from this phase onward. Chat stays available in every later phase." },
    { selector: ".phase-advance", title: "Advance together", text: "After the timer ends, both participants must indicate they are ready before the shared outline opens." },
  ],
  outline: [
    { selector: ".phase-brief", title: "Plan before writing", text: "Use the prompt and minimum outline time to agree on the story structure." },
    { selector: ".phase-chat", title: "Keep discussing", text: "Chat remains open so you can negotiate plot points and respond to your partner." },
    { selector: ".shared-outline-pad", title: "Build one live shared outline", text: "Both participants can type in this document at the same time. Every change appears automatically—there is no Save button." },
    { selector: ".phase-advance", title: "Agree to start writing", text: "Both people must be ready after the timer ends before final writing begins." },
  ],
  writing: [
    { selector: ".phase-brief", title: "Write from the shared plan", text: "The final phase has its own prompt and minimum writing time. The shared outline remains available for reference." },
    { selector: ".phase-chat", title: "Coordinate while writing", text: "Keep using chat to discuss edits, wording, and which version should be submitted." },
    { selector: ".final-story-pad", title: "Propose the final story", text: "Either person may submit a complete draft after the timer. Both participants must approve the exact same version." },
  ],
};

const phasePresentation = {
  ideation: { title: "Develop your ideas", icon: Lightbulb, next: "Discussion" },
  discussion: { title: "Discuss with your partner", icon: MessageCircle, next: "Outline" },
  outline: { title: "Create a shared outline", icon: FileText, next: "Final writing" },
  writing: { title: "Write the final story", icon: PencilLine, next: "Survey" },
} satisfies Record<CollaborationPhase, { title: string; icon: typeof Lightbulb; next: string }>;

function phaseContent(state: ParticipantState) {
  const phase = state.pair?.phase ?? "ideation";
  const config = state.config;
  if (phase === "ideation") return { instructions: config.ideationInstructionMarkdown, prompt: config.ideationPrompt };
  if (phase === "discussion") return { instructions: config.discussionInstructionMarkdown, prompt: config.discussionPrompt };
  if (phase === "outline") return { instructions: config.outlineInstructionMarkdown, prompt: config.outlinePrompt };
  return { instructions: config.writingInstructionMarkdown, prompt: config.writingPrompt };
}

export function CollaborationWorkspace({ state, now, act, refresh }: {
  state: ParticipantState;
  now: number;
  act: Action;
  refresh: () => Promise<boolean>;
}) {
  const pair = state.pair;
  const [advancing, setAdvancing] = useState(false);
  const outlineController = useRef<LiveOutlineController | null>(null);
  if (!pair) return <Card><ErrorNote>Collaboration information is unavailable.</ErrorNote></Card>;

  const phase = pair.phase;
  const presentation = phasePresentation[phase];
  const PhaseIcon = presentation.icon;
  const content = phaseContent(state);
  const remaining = secondsRemaining(pair.phaseEndsAt, now);
  const minimumComplete = Boolean(pair.phaseEndsAt) && remaining === 0;
  const myApproval = state.phaseApprovals.find((approval) => approval.phase === phase && approval.attemptId === state.attempt.id);
  const approvals = state.phaseApprovals.filter((approval) => approval.phase === phase).length;

  const advance = async () => {
    if (phase === "writing" || !minimumComplete || advancing || myApproval) return;
    setAdvancing(true);
    try {
      if (phase === "ideation") {
        const privateDraft = document.querySelector<HTMLTextAreaElement>(".private-idea-board textarea")?.value ?? state.ideationDraft;
        await act({ action: "saveIdeation", body: privateDraft }, false);
      }
      if (phase === "outline") {
        await outlineController.current?.flush();
      }
      await act({ action: "approvePhase", phase }, false);
      await refresh();
    } finally { setAdvancing(false); }
  };

  return <>
    <div className={`phase-workspace phase-${phase}`}>
      <aside className="phase-brief">
        <div className="phase-track" aria-label="Collaboration phases">
          {phaseOrder.map((item, index) => {
            const current = phaseOrder.findIndex((entry) => entry.key === phase);
            return <div key={item.key} className={index === current ? "current" : index < current ? "complete" : ""}><span>{index < current ? <Check size={11} /> : index + 1}</span><small>{item.short}</small></div>;
          })}
        </div>
        <div className="phase-heading"><span><PhaseIcon size={20} /></span><div><div className="card-kicker">Phase {phaseOrder.findIndex((item) => item.key === phase) + 1} of 4</div><h1>{presentation.title}</h1></div></div>
        <Markdown>{content.instructions}</Markdown>
        <div className="phase-prompt"><span>Writing prompt</span><p>{content.prompt}</p></div>
        <div className={`phase-timer ${minimumComplete ? "complete" : ""}`}>
          <div><Clock3 size={18} /><span>{minimumComplete ? "Minimum complete" : "Minimum phase time"}</span></div>
          <strong>{minimumComplete ? "Ready" : formatClock(remaining)}</strong>
          <small>{minimumComplete ? "You may keep working before continuing." : "The timer continues during refreshes and focus warnings."}</small>
        </div>
        {phase !== "writing" && <div className="phase-advance">
          {phase !== "ideation" && <div className="phase-approval-status"><span className={myApproval ? "ready" : ""}>{myApproval ? <Check size={13} /> : <Clock3 size={13} />} You</span><span className={approvals >= 2 ? "ready" : ""}>{approvals >= 2 ? <Check size={13} /> : <Clock3 size={13} />} Partner</span></div>}
          <Button disabled={!minimumComplete || Boolean(myApproval) || advancing} onClick={() => void advance().catch(() => undefined)}>
            {!minimumComplete ? `Continue in ${formatClock(remaining)}` : myApproval ? (phase === "ideation" ? "Preparing discussion…" : "Waiting for partner…") : advancing ? "Syncing…" : `Ready for ${presentation.next}`}
          </Button>
        </div>}
        {phase === "writing" && <div className="writing-rule"><ShieldCheck size={17} /><span>Both participants must approve the same submitted version before the individual survey opens.</span></div>}
      </aside>
      <main className="phase-main">
        {phase === "ideation"
          ? <IdeationBoard state={state} act={act} />
          : <SharedWorkspace state={state} now={now} act={act} refresh={refresh} minimumComplete={minimumComplete} outlineController={outlineController} outlineReadOnly={Boolean(myApproval)} />}
      </main>
    </div>
    <PageGuide key={phase} tourKey={`phase-${phase}`} steps={guides[phase]} />
  </>;
}

function IdeationBoard({ state, act }: { state: ParticipantState; act: Action }) {
  const [idea, setIdea] = useState(state.ideationDraft);
  const [status, setStatus] = useState<"saved" | "saving" | "offline">("saved");
  const lastSaved = useRef(state.ideationDraft);
  const actionRef = useRef(act);
  useEffect(() => { actionRef.current = act; }, [act]);

  useEffect(() => {
    if (idea === lastSaved.current) return;
    setStatus("saving");
    const timer = window.setTimeout(async () => {
      try {
        await actionRef.current({ action: "saveIdeation", body: idea }, false);
        lastSaved.current = idea;
        setStatus("saved");
      } catch { setStatus("offline"); }
    }, 900);
    return () => window.clearTimeout(timer);
  }, [idea]);

  const saveNow = async () => {
    if (idea === lastSaved.current) return;
    setStatus("saving");
    try {
      await act({ action: "saveIdeation", body: idea }, false);
      lastSaved.current = idea;
      setStatus("saved");
    } catch { setStatus("offline"); }
  };

  return <section className="private-idea-board">
    <header><div><span className="private-badge"><LockKeyhole size={13} />Private workspace</span><h2>Your idea board</h2><p>Explore freely. These notes are visible only to you and the research team.</p></div><div className={`draft-save-state ${status}`}><span />{status === "saved" ? "Draft saved" : status === "saving" ? "Saving…" : "Will retry"}</div></header>
    <textarea value={idea} onChange={(event) => setIdea(event.target.value)} onBlur={() => void saveNow()} maxLength={20000} placeholder="Draft characters, settings, conflicts, turning points, possible endings, or any other ideas…" autoFocus />
    <footer><span>{idea.length.toLocaleString()} characters</span><span><ShieldCheck size={14} />Not shared with another participant</span></footer>
  </section>;
}

function SharedWorkspace({ state, now, act, refresh, minimumComplete, outlineController, outlineReadOnly }: {
  state: ParticipantState;
  now: number;
  act: Action;
  refresh: () => Promise<boolean>;
  minimumComplete: boolean;
  outlineController: { current: LiveOutlineController | null };
  outlineReadOnly: boolean;
}) {
  const pair = state.pair!;
  const phase = pair.phase;
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
  const partner = pair.members.find((member) => !member.isSelf);
  const latestProposal = state.proposal;
  const partnerDisconnected = Boolean(partner && pair.disconnectedAttemptId === partner.attemptId && pair.disconnectDetectedAt);
  const reconnectRemaining = partnerDisconnected ? secondsRemainingAfter(pair.disconnectDetectedAt, state.config.reconnectSeconds, now) : 0;

  useEffect(() => recorder.subscribe(setSyncStatus), [recorder]);
  useEffect(() => () => { void recorder.stop(); }, [recorder]);
  useEffect(() => {
    const flushWhenHidden = () => { if (document.hidden) void recorder.flush(true); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => document.removeEventListener("visibilitychange", flushWhenHidden);
  }, [recorder]);
  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [pendingMessages, state.messages]);
  const context = { recorder, attemptId: state.attempt.id, pairSessionId: pair.id };
  const visibleMessages = [
    ...state.messages,
    ...pendingMessages.filter((pending) => !state.messages.some((item) => item.clientMessageId === pending.clientMessageId)),
  ].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));

  const send = async () => {
    if (!message.trim()) return;
    const body = message; const fieldInstanceId = messageDraftId; const clientMessageId = crypto.randomUUID();
    setPendingMessages((current) => [...current, { id: `pending:${clientMessageId}`, senderAttemptId: state.attempt.id, clientMessageId, fieldInstanceId, body, createdAt: new Date().toISOString() }]);
    setMessage(""); setMessageDraftId(crypto.randomUUID()); void recorder.flush();
    try { await act({ action: "message", body, clientMessageId, fieldInstanceId }, false); }
    catch {
      setPendingMessages((current) => current.filter((item) => item.id !== `pending:${clientMessageId}`));
      setMessage(body); setMessageDraftId(fieldInstanceId);
    }
  };

  const propose = async () => {
    if (!story.trim() || !minimumComplete || submittingStory) return;
    setSubmittingStory(true); void recorder.flush();
    try {
      await act({ action: "proposeStory", body: story, fieldInstanceId: storyDraftId }, false);
      setStory(""); setStoryDraftId(crypto.randomUUID()); await refresh();
    } finally { setSubmittingStory(false); }
  };

  const decide = async (decision: "agree" | "disagree") => {
    if (!latestProposal || decidingStory) return;
    setDecidingStory(true); void recorder.flush();
    try { await act({ action: "decideStory", proposalId: latestProposal.id, decision }, false); await refresh(); }
    finally { setDecidingStory(false); }
  };

  const liveOutline = outlineSnapshot(state.outlineOperationBatches).text || pair.sharedOutline;
  return <>
    {partnerDisconnected && <div className="partner-connection-banner" role="status"><div className="partner-connection-icon"><WifiOff size={20} /></div><div><strong>{partner?.alias ?? "Your partner"} disconnected</strong><span>They can reconnect while the phase timer continues.</span></div><div className={`partner-reconnect-clock ${reconnectRemaining === 0 ? "expired" : ""}`}><Clock3 size={15} />{reconnectRemaining > 0 ? formatClock(reconnectRemaining) : "Ending…"}</div></div>}
    <div className={`shared-phase-grid ${phase === "discussion" ? "discussion-only" : ""}`}>
      <section className="chat-panel phase-chat">
        <header className="chat-header"><div><span className="online-dot" /><strong>{partner?.alias ?? "Partner"}</strong><small>{partnerDisconnected ? "Waiting for reconnection" : "Connected to your shared room"}</small></div><span className="phase-chat-label">{phaseOrder.find((item) => item.key === phase)?.label}</span></header>
        <div className="messages" aria-live="polite">{visibleMessages.length === 0 && <div className="empty-chat"><MessageCircle size={28} /><p>Start the conversation when you’re ready.</p></div>}{visibleMessages.map((item) => { const mine = item.senderAttemptId === state.attempt.id; return <div key={item.id} className={`message-row ${mine ? "mine" : "theirs"}`}><div className="message-bubble"><span>{item.body}</span><time>{new Date(item.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div></div>; })}<div ref={endRef} /></div>
        <div className="composer"><LoggedTextarea {...context} fieldType="chat" fieldInstanceId={messageDraftId} value={message} onChange={(event) => setMessage(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} placeholder={`Message ${partner?.alias ?? "your partner"}`} maxLength={2000} rows={2} /><Button aria-label="Send message" onClick={() => void send()} disabled={!message.trim()}><Send size={18} /></Button><div className={`sync-state ${syncStatus}`}><span />{syncStatus === "synced" ? "Typing data saved" : syncStatus === "syncing" ? "Saving typing data…" : "Typing data will retry"}</div></div>
      </section>
      {phase === "outline" && <LiveOutlineEditor state={state} readOnly={outlineReadOnly} controllerRef={outlineController} />}
      {phase === "writing" && <section className="final-story-pad">
        {liveOutline && <details className="outline-reference"><summary>View shared outline</summary><div>{liveOutline}</div></details>}
        {latestProposal?.status === "pending"
          ? <ProposalReview proposal={latestProposal} attemptId={state.attempt.id} decide={decide} busy={decidingStory} />
          : <><span className="card-kicker">Final submission</span><h2>{latestProposal?.status === "rejected" ? "Revise and propose again" : "Propose a final story"}</h2><p>Either participant can submit a version. Submission unlocks after the minimum writing time.</p><LoggedTextarea {...context} fieldType="story" fieldInstanceId={storyDraftId} value={story} onChange={(event) => setStory(event.target.value)} placeholder="Write the complete final story here…" rows={14} /><Button disabled={!story.trim() || !minimumComplete || submittingStory} onClick={() => void propose().catch(() => undefined)}>{!minimumComplete ? "Writing time still in progress" : submittingStory ? "Submitting…" : "Submit for both to approve"}</Button></>}
      </section>}
    </div>
  </>;
}

function ProposalReview({ proposal, attemptId, decide, busy }: {
  proposal: NonNullable<ParticipantState["proposal"]>;
  attemptId: string;
  decide: (decision: "agree" | "disagree") => Promise<void>;
  busy: boolean;
}) {
  const mine = proposal.approvals.find((approval) => approval.attemptId === attemptId)?.decision;
  const agrees = proposal.approvals.filter((approval) => approval.decision === "agree").length;
  return <><span className="card-kicker">Submitted version {proposal.version}</span><h2>Review the final story</h2><div className="proposal-text">{proposal.body}</div><div className="approval-count"><span className={agrees >= 1 ? "filled" : ""} /><span className={agrees >= 2 ? "filled" : ""} />{agrees} of 2 approvals</div>{mine ? <p className="decision-note"><Check size={16} />You selected <strong>{mine}</strong>. Waiting for your partner.</p> : <div className="button-row"><Button className="secondary" disabled={busy} onClick={() => void decide("disagree").catch(() => undefined)}>Disagree</Button><Button disabled={busy} onClick={() => void decide("agree").catch(() => undefined)}>{busy ? "Submitting…" : "Agree with this version"}</Button></div>}</>;
}
