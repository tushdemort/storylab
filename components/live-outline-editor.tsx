"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { Check, Cloud, CloudOff, Users } from "lucide-react";
import {
  adjustOutlineSelection,
  createOutlineEdit,
  mergeOutlineBatches,
  outlineSnapshot,
} from "@/lib/collaborative-outline";
import type { OutlineOperation, OutlineOperationBatch, ParticipantState } from "@/lib/types";
import { apiMessage } from "@/lib/utils";

type OutboxBatch = Pick<OutlineOperationBatch, "clientBatchId" | "operations">;
type SyncStatus = "live" | "syncing" | "offline";

export type LiveOutlineController = {
  flush: () => Promise<void>;
  getText: () => string;
};

async function uploadOutlineBatches(batches: OutboxBatch[]) {
  const response = await fetch("/api/participant/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "outlineOperations", batches }),
  });
  const body: unknown = await response.json();
  if (!response.ok) throw new Error(apiMessage(body));
}

export function LiveOutlineEditor({
  state,
  readOnly,
  controllerRef,
}: {
  state: ParticipantState;
  readOnly: boolean;
  controllerRef: { current: LiveOutlineController | null };
}) {
  const [localBatches, setLocalBatches] = useState<OutlineOperationBatch[]>([]);
  const [status, setStatus] = useState<SyncStatus>("live");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const clientIdRef = useRef(crypto.randomUUID());
  const clockRef = useRef(1);
  const pendingOperationsRef = useRef<OutlineOperation[]>([]);
  const outboxRef = useRef<OutboxBatch[]>([]);
  const drainRef = useRef<Promise<void> | null>(null);
  const debounceRef = useRef<number | null>(null);
  const retryRef = useRef<number | null>(null);
  const retryDrainRef = useRef<() => Promise<void>>(async () => undefined);
  const mountedRef = useRef(true);
  const localChangeRef = useRef(false);
  const selectionRef = useRef({ start: 0, end: 0 });
  const previousTextRef = useRef("");

  const allBatches = useMemo(
    () => mergeOutlineBatches(state.outlineOperationBatches, localBatches),
    [localBatches, state.outlineOperationBatches],
  );
  const snapshot = useMemo(() => outlineSnapshot(allBatches), [allBatches]);
  const snapshotRef = useRef(snapshot);

  useEffect(() => {
    snapshotRef.current = snapshot;
    clockRef.current = Math.max(clockRef.current, snapshot.maxClock + 1);
  }, [snapshot]);
  useEffect(() => () => { mountedRef.current = false; }, []);

  const sealPendingOperations = useCallback(() => {
    if (!pendingOperationsRef.current.length) return;
    outboxRef.current.push({
      clientBatchId: crypto.randomUUID(),
      operations: pendingOperationsRef.current.splice(0),
    });
  }, []);

  const drain = useCallback(async (): Promise<void> => {
    if (debounceRef.current !== null) {
      window.clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    sealPendingOperations();
    const previousRequest = drainRef.current;
    const request = (async () => {
      if (previousRequest) await previousRequest.catch(() => undefined);
      sealPendingOperations();
      if (mountedRef.current) setStatus("syncing");
      while (outboxRef.current.length) {
        const next = outboxRef.current[0];
        await uploadOutlineBatches([next]);
        outboxRef.current.shift();
      }
      if (mountedRef.current) setStatus("live");
    })();
    drainRef.current = request;
    try {
      await request;
    } catch (error) {
      if (mountedRef.current) {
        setStatus("offline");
        if (retryRef.current !== null) window.clearTimeout(retryRef.current);
        retryRef.current = window.setTimeout(() => { void retryDrainRef.current().catch(() => undefined); }, 1200);
      }
      throw error;
    } finally {
      if (drainRef.current === request) drainRef.current = null;
    }
  }, [sealPendingOperations]);

  useEffect(() => {
    retryDrainRef.current = drain;
    controllerRef.current = { flush: drain, getText: () => snapshotRef.current.text };
    return () => { controllerRef.current = null; };
  }, [controllerRef, drain]);

  useEffect(() => {
    const flushWhenHidden = () => { if (document.hidden) void drain().catch(() => undefined); };
    const retryWhenOnline = () => { void drain().catch(() => undefined); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    window.addEventListener("online", retryWhenOnline);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      window.removeEventListener("online", retryWhenOnline);
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
      if (retryRef.current !== null) window.clearTimeout(retryRef.current);
      void drain().catch(() => undefined);
    };
  }, [drain]);

  useLayoutEffect(() => {
    const previous = previousTextRef.current;
    if (previous === snapshot.text) return;
    const textarea = textareaRef.current;
    if (textarea && document.activeElement === textarea && !localChangeRef.current) {
      const start = adjustOutlineSelection(previous, snapshot.text, selectionRef.current.start);
      const end = adjustOutlineSelection(previous, snapshot.text, selectionRef.current.end);
      textarea.setSelectionRange(start, end);
      selectionRef.current = { start, end };
    }
    previousTextRef.current = snapshot.text;
    localChangeRef.current = false;
  }, [snapshot.text]);

  const changeOutline = (event: ChangeEvent<HTMLTextAreaElement>) => {
    if (readOnly || event.target.value.length > 20000) return;
    const operation = createOutlineEdit({
      before: snapshotRef.current.text,
      after: event.target.value,
      visibleIds: snapshotRef.current.visibleIds,
      clientId: clientIdRef.current,
      clock: clockRef.current,
      operationId: crypto.randomUUID(),
    });
    if (!operation) return;
    clockRef.current += 1;
    localChangeRef.current = true;
    selectionRef.current = {
      start: event.target.selectionStart,
      end: event.target.selectionEnd,
    };
    pendingOperationsRef.current.push(operation);
    setLocalBatches((current) => [...current, {
      clientBatchId: operation.id,
      senderAttemptId: state.attempt.id,
      operations: [operation],
      createdAt: new Date().toISOString(),
    }]);
    if (debounceRef.current === null) {
      debounceRef.current = window.setTimeout(() => { void drain().catch(() => undefined); }, 100);
    }
  };

  const statusLabel = status === "live"
    ? "All changes live"
    : status === "syncing"
      ? "Syncing changes…"
      : "Connection issue — retrying";

  return <section className="shared-outline-pad">
    <header>
      <div><span className="card-kicker">Live shared document</span><h2>Story outline</h2></div>
      <div className="outline-collaborators"><span><Users size={15} />Both participants</span></div>
    </header>
    <textarea
      ref={textareaRef}
      aria-label="Shared story outline"
      value={snapshot.text}
      onChange={changeOutline}
      onSelect={(event) => {
        selectionRef.current = {
          start: event.currentTarget.selectionStart,
          end: event.currentTarget.selectionEnd,
        };
      }}
      readOnly={readOnly}
      maxLength={20000}
      spellCheck
      placeholder={"Beginning…\n\nKey events…\n\nClimax…\n\nEnding…"}
    />
    <footer>
      <span>{snapshot.text.length.toLocaleString()} characters</span>
      <span className={`outline-live-state ${status}`}>
        {status === "live" ? <Check size={13} /> : status === "offline" ? <CloudOff size={13} /> : <Cloud size={13} />}
        {readOnly ? "You’re ready — viewing partner updates" : statusLabel}
      </span>
    </footer>
  </section>;
}
