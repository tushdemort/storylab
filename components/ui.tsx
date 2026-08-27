import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { Check, Circle } from "lucide-react";
import type { AttemptStage } from "@/lib/types";

export function Shell({ children, stage, headerExtra }: { children: ReactNode; stage?: AttemptStage; headerExtra?: ReactNode }) {
  return (
    <main className={`shell${stage ? ` stage-${stage}` : ""}`}>
      <header className="site-header">
        <Link className="brand" href="/" aria-label="StoryLab home">
          <span className="brand-mark">S</span>
          <span>StoryLab</span>
        </Link>
        <div className="site-header-actions">
          {stage && <Progress stage={stage} />}
          {headerExtra}
        </div>
      </header>
      <div className="page-content">{children}</div>
    </main>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <section className={`card ${className}`}>{children}</section>;
}

export function Button({ className = "", ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
  return <button className={`button ${className}`} {...props} />;
}

export function Spinner({ label = "Loading" }: { label?: string }) {
  return <div className="loading"><span className="spinner" aria-hidden="true" /><span>{label}</span></div>;
}

export function ErrorNote({ children }: { children: ReactNode }) {
  return <div className="error-note" role="alert">{children}</div>;
}

const stages: Array<{ keys: AttemptStage[]; label: string }> = [
  { keys: ["attention"], label: "Check" },
  { keys: ["waiting"], label: "Pair" },
  { keys: ["instruction", "chat", "finalizing"], label: "Collaborate" },
  { keys: ["quiz"], label: "Survey" },
  { keys: ["complete"], label: "Done" },
];

function Progress({ stage }: { stage: AttemptStage }) {
  const current = stages.findIndex((item) => item.keys.includes(stage));
  return (
    <ol className="progress" aria-label="Assessment progress">
      {stages.map((item, index) => (
        <li key={item.label} className={index === current ? "current" : index < current ? "finished" : ""}>
          <span className="progress-dot">{index < current ? <Check size={11} /> : <Circle size={9} />}</span>
          <span>{item.label}</span>
        </li>
      ))}
    </ol>
  );
}
