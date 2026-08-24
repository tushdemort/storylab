"use client";

import type { KeystrokeEventKind, KeystrokeEventRecord } from "@/lib/types";
import { getBrowserSupabase } from "@/lib/supabase/browser";

type KeystrokeContext = Pick<
  KeystrokeEventRecord,
  "attemptId" | "pairSessionId" | "fieldType" | "fieldInstanceId"
>;

type EventDetails = Partial<Omit<KeystrokeEventRecord, keyof KeystrokeContext | "clientEventId" | "clientSequence" | "clientWallTime" | "clientElapsedMs">>
  & { eventKind: KeystrokeEventKind };

type StatusListener = (status: "synced" | "syncing" | "offline" | "error") => void;

const DB_NAME = "paired-assessment-keystrokes";
const STORE_NAME = "pending-events";
const MEMORY_QUEUE: KeystrokeEventRecord[] = [];
let databasePromise: Promise<IDBDatabase | null> | null = null;

function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      const store = db.createObjectStore(STORE_NAME, { keyPath: "clientEventId" });
      store.createIndex("attemptId", "attemptId", { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { databasePromise = null; reject(request.error); };
  });
  return databasePromise;
}

async function persistEvents(events: KeystrokeEventRecord[]) {
  if (!events.length) return;
  try {
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      events.forEach((event) => store.put(event));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // Events remain in memory and will be retried on the next flush.
  }
}

async function pendingEvents(attemptId: string, limit = 200): Promise<KeystrokeEventRecord[]> {
  const memory = MEMORY_QUEUE.filter((event) => event.attemptId === attemptId);
  try {
    const db = await openDatabase();
    if (!db) return memory.sort(bySequence).slice(0, limit);
    const stored = await new Promise<KeystrokeEventRecord[]>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const request = transaction.objectStore(STORE_NAME).index("attemptId").getAll(attemptId);
      request.onsuccess = () => resolve(request.result as KeystrokeEventRecord[]);
      request.onerror = () => reject(request.error);
    });
    const combined = new Map([...stored, ...memory].map((event) => [event.clientEventId, event]));
    return [...combined.values()].sort(bySequence).slice(0, limit);
  } catch {
    return memory.sort(bySequence).slice(0, limit);
  }
}

async function deleteEvents(ids: string[]) {
  for (let index = MEMORY_QUEUE.length - 1; index >= 0; index -= 1) {
    if (ids.includes(MEMORY_QUEUE[index].clientEventId)) MEMORY_QUEUE.splice(index, 1);
  }
  try {
    const db = await openDatabase();
    if (!db) return;
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      ids.forEach((id) => store.delete(id));
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } catch {
    // The acknowledged events remain in IndexedDB and will be harmlessly retried.
  }
}

function bySequence(a: KeystrokeEventRecord, b: KeystrokeEventRecord) {
  return a.clientSequence - b.clientSequence;
}

export class KeystrokeRecorder {
  private readonly attemptId: string;
  private sequence: number;
  private queuedSinceFlush = 0;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private writeTimer: ReturnType<typeof setTimeout> | null = null;
  private sequenceTimer: ReturnType<typeof setTimeout> | null = null;
  private writeBuffer: KeystrokeEventRecord[] = [];
  private writeChain: Promise<void> = Promise.resolve();
  private flushing: Promise<void> | null = null;
  private listeners = new Set<StatusListener>();

  constructor(attemptId: string) {
    this.attemptId = attemptId;
    const key = `keystroke-sequence:${attemptId}`;
    const stored = typeof localStorage === "undefined" ? 0 : Number(localStorage.getItem(key));
    this.sequence = Number.isFinite(stored) && stored > 0 ? stored : Date.now() * 1000;
    this.flushTimer = setInterval(() => void this.flush(), 2000);
  }

  subscribe(listener: StatusListener) {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  enqueue(context: KeystrokeContext, details: EventDetails) {
    this.sequence += 1;
    this.scheduleSequenceSave();
    const event: KeystrokeEventRecord = {
      attemptId: context.attemptId,
      pairSessionId: context.pairSessionId,
      fieldType: context.fieldType,
      fieldInstanceId: context.fieldInstanceId,
      clientEventId: crypto.randomUUID(),
      clientSequence: this.sequence,
      correlationId: details.correlationId ?? null,
      eventKind: details.eventKind,
      keyValue: details.keyValue ?? null,
      codeValue: details.codeValue ?? null,
      inputType: details.inputType ?? null,
      eventData: details.eventData ?? null,
      clientWallTime: new Date().toISOString(),
      clientElapsedMs: performance.now(),
      selectionStart: details.selectionStart ?? null,
      selectionEnd: details.selectionEnd ?? null,
      selectionStartAfter: details.selectionStartAfter ?? null,
      selectionEndAfter: details.selectionEndAfter ?? null,
      ctrlKey: details.ctrlKey ?? false,
      altKey: details.altKey ?? false,
      shiftKey: details.shiftKey ?? false,
      metaKey: details.metaKey ?? false,
      isRepeat: details.isRepeat ?? false,
      keyLocation: details.keyLocation ?? 0,
      isComposing: details.isComposing ?? false,
    };
    this.queuedSinceFlush += 1;
    MEMORY_QUEUE.push(event);
    this.writeBuffer.push(event);
    if (!this.writeTimer) {
      this.writeTimer = setTimeout(() => { void this.persistBufferedEvents(); }, 25);
    }
    if (this.queuedSinceFlush >= 50) void this.flush();
  }

  private scheduleSequenceSave() {
    if (this.sequenceTimer || typeof localStorage === "undefined") return;
    this.sequenceTimer = setTimeout(() => {
      this.sequenceTimer = null;
      localStorage.setItem(`keystroke-sequence:${this.attemptId}`, String(this.sequence));
    }, 250);
  }

  private async persistBufferedEvents() {
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = null;
    const events = this.writeBuffer.splice(0);
    if (events.length) this.writeChain = this.writeChain.then(() => persistEvents(events));
    await this.writeChain;
  }

  async flush(keepalive = false) {
    if (this.flushing) return this.flushing;
    this.flushing = this.doFlush(keepalive).finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async doFlush(keepalive: boolean) {
    await this.persistBufferedEvents();
    const events = await pendingEvents(this.attemptId);
    if (!events.length) {
      this.emit("synced");
      return;
    }
    this.emit("syncing");
    try {
      let acknowledged: string[];
      if (keepalive) {
        const response = await fetch("/api/keystrokes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ events }),
          keepalive: true,
        });
        if (!response.ok) throw new Error("Keystroke synchronization failed");
        const result = await response.json() as { acknowledged: string[] };
        acknowledged = result.acknowledged;
      } else {
        const { error } = await getBrowserSupabase().rpc("append_keystroke_batch", { p_events: events });
        if (error) throw error;
        acknowledged = events.map((event) => event.clientEventId);
      }
      await deleteEvents(acknowledged);
      this.queuedSinceFlush = 0;
      this.emit("synced");
      if ((await pendingEvents(this.attemptId, 1)).length) void this.flush();
    } catch {
      this.emit(navigator.onLine ? "error" : "offline");
    }
  }

  async stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
    if (this.sequenceTimer) clearTimeout(this.sequenceTimer);
    this.sequenceTimer = null;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(`keystroke-sequence:${this.attemptId}`, String(this.sequence));
    }
    await this.flush(true);
  }

  private emit(status: Parameters<StatusListener>[0]) {
    this.listeners.forEach((listener) => listener(status));
  }
}
