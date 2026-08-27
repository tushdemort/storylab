"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { Check, ChevronLeft, ChevronRight, CircleHelp, X } from "lucide-react";
import { Button } from "@/components/ui";

const overviewStorageKey = "storylab-participant-tutorial-v2";

export type PageGuideStep = {
  selector: string;
  title: string;
  text: string;
};

type Placement = "top" | "right" | "bottom" | "left";
type GuideGeometry = {
  spotlight: CSSProperties;
  tooltip: CSSProperties;
  placement: Placement;
};

function guideStorageKey(tourKey: string): string {
  return `storylab-page-guide-${tourKey}-v1`;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

export function PageGuide({
  tourKey,
  steps,
  waitForOverview = false,
  showReplay = true,
}: {
  tourKey: string;
  steps: PageGuideStep[];
  waitForOverview?: boolean;
  showReplay?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [geometry, setGeometry] = useState<GuideGeometry | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);

  const closeGuide = useCallback(() => {
    try { localStorage.setItem(guideStorageKey(tourKey), "complete"); } catch { /* Persistence is optional. */ }
    setOpen(false);
    setStepIndex(0);
    setGeometry(null);
  }, [tourKey]);
  const replay = () => { setStepIndex(0); setOpen(true); };

  useEffect(() => {
    let timer = 0;
    const maybeOpen = () => {
      try {
        if (localStorage.getItem(guideStorageKey(tourKey)) === "complete") return;
        if (waitForOverview && localStorage.getItem(overviewStorageKey) !== "complete") return;
      } catch {
        // If storage is unavailable, the current visit can still use the guide.
      }
      timer = window.setTimeout(() => setOpen(true), 500);
    };
    maybeOpen();
    if (waitForOverview) window.addEventListener("storylab:overview-closed", maybeOpen);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("storylab:overview-closed", maybeOpen);
    };
  }, [tourKey, waitForOverview]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    let timer = 0;
    const updatePosition = () => {
      const target = document.querySelector<HTMLElement>(steps[stepIndex]?.selector ?? "");
      if (!target) {
        setGeometry(null);
        return;
      }
      const rect = target.getBoundingClientRect();
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const tooltipWidth = Math.min(340, viewportWidth - 32);
      const tooltipHeight = tooltipRef.current?.offsetHeight ?? 220;
      const gap = 18;
      const padding = 8;
      let placement: Placement;
      if (rect.right + gap + tooltipWidth <= viewportWidth - 12) placement = "right";
      else if (rect.left - gap - tooltipWidth >= 12) placement = "left";
      else if (rect.bottom + gap + tooltipHeight <= viewportHeight - 12) placement = "bottom";
      else placement = "top";

      let left = 16;
      let top = 16;
      if (placement === "right") {
        left = rect.right + gap;
        top = clamp(rect.top + rect.height / 2 - tooltipHeight / 2, 12, viewportHeight - tooltipHeight - 12);
      } else if (placement === "left") {
        left = rect.left - gap - tooltipWidth;
        top = clamp(rect.top + rect.height / 2 - tooltipHeight / 2, 12, viewportHeight - tooltipHeight - 12);
      } else if (placement === "bottom") {
        left = clamp(rect.left + rect.width / 2 - tooltipWidth / 2, 12, viewportWidth - tooltipWidth - 12);
        top = clamp(rect.bottom + gap, 12, viewportHeight - tooltipHeight - 12);
      } else {
        left = clamp(rect.left + rect.width / 2 - tooltipWidth / 2, 12, viewportWidth - tooltipWidth - 12);
        top = clamp(rect.top - gap - tooltipHeight, 12, viewportHeight - tooltipHeight - 12);
      }
      setGeometry({
        placement,
        spotlight: {
          top: Math.max(4, rect.top - padding),
          left: Math.max(4, rect.left - padding),
          width: Math.min(viewportWidth - 8, rect.width + padding * 2),
          height: Math.min(viewportHeight - 8, rect.height + padding * 2),
        },
        tooltip: { top, left, width: tooltipWidth },
      });
    };
    const target = document.querySelector<HTMLElement>(steps[stepIndex]?.selector ?? "");
    target?.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
    timer = window.setTimeout(() => {
      updatePosition();
      frame = window.requestAnimationFrame(updatePosition);
    }, 180);
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.clearTimeout(timer);
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, stepIndex, steps]);

  useEffect(() => {
    if (!open) return;
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeGuide();
      if (event.key === "ArrowRight") setStepIndex((current) => Math.min(steps.length - 1, current + 1));
      if (event.key === "ArrowLeft") setStepIndex((current) => Math.max(0, current - 1));
    };
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [closeGuide, open, steps.length]);

  const step = steps[stepIndex];
  const finalStep = stepIndex === steps.length - 1;
  return <>
    {showReplay && <button type="button" className="page-guide-replay" onClick={replay}><CircleHelp size={16} /><span>Guide</span></button>}
    {open && <div className="page-guide-layer">
      <div className="page-guide-blocker" />
      {geometry && <div className="page-guide-spotlight" style={geometry.spotlight} />}
      <div className={`page-guide-tooltip ${geometry?.placement ?? "center"}`} style={geometry?.tooltip} role="dialog" aria-modal="true" aria-labelledby={`page-guide-title-${tourKey}`} ref={tooltipRef}>
        <span className="page-guide-arrow" aria-hidden="true" />
        <button type="button" className="page-guide-close" onClick={closeGuide} aria-label="Close page guide"><X size={17} /></button>
        <div className="page-guide-progress"><span>{stepIndex + 1} of {steps.length}</span><div>{steps.map((item, index) => <i key={item.title} className={index <= stepIndex ? "filled" : ""} />)}</div></div>
        <h3 id={`page-guide-title-${tourKey}`}>{step.title}</h3>
        <p>{step.text}</p>
        <div className="page-guide-actions">
          {stepIndex === 0 ? <button type="button" onClick={closeGuide}>Skip guide</button> : <Button className="secondary small" onClick={() => setStepIndex((current) => current - 1)}><ChevronLeft size={14} />Back</Button>}
          <Button className="small" onClick={() => finalStep ? closeGuide() : setStepIndex((current) => current + 1)}>{finalStep ? <><Check size={14} />Got it</> : <>Next<ChevronRight size={14} /></>}</Button>
        </div>
      </div>
    </div>}
  </>;
}
