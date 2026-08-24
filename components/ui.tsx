import type { ButtonHTMLAttributes, ReactNode } from "react";
import Link from "next/link";
import { Check, Circle } from "lucide-react";
import type { AttemptStage } from "@/lib/types";

export function Shell({ children, stage }: { children: ReactNode; stage?: AttemptStage }) {
  return (
    <main className="shell">
      <header className="site-header">
        <Link className="brand" href="/" aria-label="StoryLab home">
          <span className="brand-mark">S</span>
          <span>StoryLab</span>
        </Link>
        {stage && <Progress stage={stage} />}
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

const stages: Array<{ key: AttemptStage; label: string }> = [
  { key: "attention", label: "Check" },
  { key: "waiting", label: "Pair" },
  { key: "instruction", label: "Brief" },
  { key: "chat", label: "Create" },
  { key: "finalizing", label: "Approve" },
  { key: "quiz", label: "Quiz" },
  { key: "complete", label: "Done" },
];

function Progress({ stage }: { stage: AttemptStage }) {
  const current = stages.findIndex((item) => item.key === stage);
  return (
    <ol className="progress" aria-label="Assessment progress">
      {stages.map((item, index) => (
        <li key={item.key} className={index === current ? "current" : index < current ? "finished" : ""}>
          <span className="progress-dot">{index < current ? <Check size={11} /> : <Circle size={9} />}</span>
          <span>{item.label}</span>
        </li>
      ))}
    </ol>
  );
}
