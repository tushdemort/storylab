"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BookOpenCheck,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  ClipboardCheck,
  Lightbulb,
  MessagesSquare,
  MonitorUp,
  ShieldCheck,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui";
import type { StudyConfig } from "@/lib/types";

const tutorialStorageKey = "storylab-participant-tutorial-v2";

type TutorialStep = {
  eyebrow: string;
  title: string;
  description: string;
  points: string[];
  icon: LucideIcon;
};

function durationLabel(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
}

export function ParticipantTutorial({ config }: { config: StudyConfig }) {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const steps = useMemo<TutorialStep[]>(() => [
    {
      eyebrow: "Welcome to StoryLab",
      title: "Here’s how the assessment works",
      description: "You’ll complete a short individual check, meet an anonymous partner, and create one story together.",
      points: ["Your partner never sees your participant ID.", "Your progress is saved if you refresh or briefly disconnect."],
      icon: BookOpenCheck,
    },
    {
      eyebrow: "Step 1 · Join",
      title: "Read, consent, and enter your ID",
      description: "Review the study information carefully, consent to participate, and use the participant ID provided by the researcher.",
      points: ["Each ID can complete the assessment once.", "Typing is recorded only in the chat and final-story fields after consent."],
      icon: ShieldCheck,
    },
    {
      eyebrow: "Step 2 · Get ready",
      title: "Enter fullscreen and complete the check",
      description: "The assessment runs in fullscreen. You’ll answer one short attention-check sentence before matchmaking begins.",
      points: ["Keep this tab visible until you finish.", "The attention response is limited to 50 words and is not automatically scored."],
      icon: MonitorUp,
    },
    {
      eyebrow: "Step 3 · Ideate privately",
      title: "Develop your own ideas first",
      description: `Matchmaking searches for up to ${durationLabel(config.waitSeconds)}. When your private workspace opens, you’ll spend at least ${durationLabel(config.ideationSeconds)} drafting independently without seeing another participant or their work.`,
      points: ["Your idea board autosaves and remains private.", "When time ends, signal that you are ready for discussion."],
      icon: Lightbulb,
    },
    {
      eyebrow: "Step 4 · Collaborate",
      title: "Discuss, then build an outline",
      description: `Your anonymous partner appears in Discussion. You’ll discuss for at least ${durationLabel(config.discussionSeconds)}, then spend at least ${durationLabel(config.outlineSeconds)} typing together in one live shared outline.`,
      points: ["Chat remains available from Discussion onward.", "Both people must agree before each phase advances."],
      icon: MessagesSquare,
    },
    {
      eyebrow: "Step 5 · Write",
      title: "Submit and approve the final story",
      description: `Use at least ${durationLabel(config.writingSeconds)} for final writing. Either participant can submit a complete version, but both must approve the exact same text.`,
      points: ["A disagreement allows a revised proposal.", "After approval, each participant completes the survey separately."],
      icon: ClipboardCheck,
    },
  ], [config.discussionSeconds, config.ideationSeconds, config.outlineSeconds, config.waitSeconds, config.writingSeconds]);

  const closeTutorial = useCallback(() => {
    try { localStorage.setItem(tutorialStorageKey, "complete"); } catch { /* Local persistence is optional. */ }
    setOpen(false);
    setStepIndex(0);
    window.dispatchEvent(new Event("storylab:overview-closed"));
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (localStorage.getItem(tutorialStorageKey) !== "complete") setOpen(true);
      } catch {
        setOpen(true);
      }
    }, 350);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeTutorial();
      if (event.key === "ArrowRight") setStepIndex((current) => Math.min(steps.length - 1, current + 1));
      if (event.key === "ArrowLeft") setStepIndex((current) => Math.max(0, current - 1));
    };
    document.addEventListener("keydown", keydown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", keydown);
    };
  }, [closeTutorial, open, steps.length]);

  const replay = () => { setStepIndex(0); setOpen(true); };
  const step = steps[stepIndex];
  const StepIcon = step.icon;
  const finalStep = stepIndex === steps.length - 1;

  return <>
    <button type="button" className="tutorial-replay" onClick={replay}><CircleHelp size={17} />How it works</button>
    {open && <div className="tutorial-backdrop" role="presentation">
      <div className="tutorial-dialog" role="dialog" aria-modal="true" aria-labelledby="tutorial-title" aria-describedby="tutorial-description" tabIndex={-1} ref={dialogRef}>
        <button type="button" className="tutorial-close" onClick={closeTutorial} aria-label="Close tutorial"><X size={19} /></button>
        <aside className="tutorial-rail" aria-hidden="true">
          <span className="tutorial-rail-brand">S</span>
          <div className="tutorial-rail-line" />
          <strong>{String(stepIndex + 1).padStart(2, "0")}</strong>
          <small>of {String(steps.length).padStart(2, "0")}</small>
        </aside>
        <section className="tutorial-content">
          <div className="tutorial-icon"><StepIcon size={30} /></div>
          <span className="card-kicker">{step.eyebrow}</span>
          <h2 id="tutorial-title">{step.title}</h2>
          <p id="tutorial-description">{step.description}</p>
          <ul>{step.points.map((point) => <li key={point}><Check size={15} /><span>{point}</span></li>)}</ul>
          <div className="tutorial-footer">
            <div className="tutorial-dots" aria-label={`Step ${stepIndex + 1} of ${steps.length}`}>
              {steps.map((item, index) => <button type="button" key={item.title} className={index === stepIndex ? "active" : ""} onClick={() => setStepIndex(index)} aria-label={`Go to tutorial step ${index + 1}`} />)}
            </div>
            <div className="tutorial-actions">
              {stepIndex === 0 ? <button type="button" className="tutorial-skip" onClick={closeTutorial}>Skip tour</button> : <Button className="secondary small" onClick={() => setStepIndex((current) => current - 1)}><ChevronLeft size={15} />Back</Button>}
              <Button className="small" onClick={() => finalStep ? closeTutorial() : setStepIndex((current) => current + 1)}>{finalStep ? "Start assessment" : "Next"}{!finalStep && <ChevronRight size={15} />}</Button>
            </div>
          </div>
        </section>
      </div>
    </div>}
  </>;
}
