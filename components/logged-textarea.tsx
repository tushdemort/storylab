"use client";

import { forwardRef, useEffect, useRef, type TextareaHTMLAttributes } from "react";
import type { KeystrokeRecorder } from "@/lib/keystrokes";

type Props = TextareaHTMLAttributes<HTMLTextAreaElement> & {
  recorder: KeystrokeRecorder;
  attemptId: string;
  pairSessionId: string;
  fieldType: "chat" | "story";
  fieldInstanceId: string;
};

export const LoggedTextarea = forwardRef<HTMLTextAreaElement, Props>(function LoggedTextarea(
  { recorder, attemptId, pairSessionId, fieldType, fieldInstanceId, ...props },
  forwardedRef,
) {
  const localRef = useRef<HTMLTextAreaElement | null>(null);
  const correlation = useRef<string | null>(null);
  const beforeSelection = useRef<{ start: number | null; end: number | null }>({ start: null, end: null });

  useEffect(() => {
    const element = localRef.current;
    if (!element) return;
    const context = { recorder, attemptId, pairSessionId, fieldType, fieldInstanceId };
    const selection = () => ({ selectionStart: element.selectionStart, selectionEnd: element.selectionEnd });
    const record = (eventKind: Parameters<typeof recorder.enqueue>[1]["eventKind"], details: Record<string, unknown> = {}) => {
      recorder.enqueue(context, { eventKind, ...details });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      correlation.current = crypto.randomUUID();
      const current = selection();
      record("keydown", {
        correlationId: correlation.current, keyValue: event.key, codeValue: event.code,
        ...current, ctrlKey: event.ctrlKey, altKey: event.altKey, shiftKey: event.shiftKey,
        metaKey: event.metaKey, isRepeat: event.repeat, keyLocation: event.location,
        isComposing: event.isComposing,
      });
    };
    const onBeforeInput = (event: InputEvent) => {
      correlation.current ??= crypto.randomUUID();
      beforeSelection.current = { start: element.selectionStart, end: element.selectionEnd };
      record("beforeinput", {
        correlationId: correlation.current, inputType: event.inputType, eventData: event.data,
        selectionStart: element.selectionStart, selectionEnd: element.selectionEnd,
        isComposing: event.isComposing,
      });
    };
    const onInput = (event: InputEvent) => {
      record("input", {
        correlationId: correlation.current, inputType: event.inputType, eventData: event.data,
        selectionStart: beforeSelection.current.start, selectionEnd: beforeSelection.current.end,
        selectionStartAfter: element.selectionStart, selectionEndAfter: element.selectionEnd,
        isComposing: event.isComposing,
      });
      if (!event.isComposing) correlation.current = null;
    };
    const onPaste = (event: ClipboardEvent) => {
      correlation.current = crypto.randomUUID();
      record("paste", {
        correlationId: correlation.current, inputType: "insertFromPaste",
        eventData: event.clipboardData?.getData("text") ?? "",
        ...selection(),
      });
    };
    const composition = (kind: "compositionstart" | "compositionupdate" | "compositionend") => (event: CompositionEvent) => {
      correlation.current ??= crypto.randomUUID();
      record(kind, { correlationId: correlation.current, eventData: event.data, ...selection(), isComposing: kind !== "compositionend" });
      if (kind === "compositionend") correlation.current = null;
    };
    const onCompositionStart = composition("compositionstart");
    const onCompositionUpdate = composition("compositionupdate");
    const onCompositionEnd = composition("compositionend");
    const onBlur = () => void recorder.flush();

    element.addEventListener("keydown", onKeyDown);
    element.addEventListener("beforeinput", onBeforeInput as EventListener);
    element.addEventListener("input", onInput as EventListener);
    element.addEventListener("paste", onPaste);
    element.addEventListener("compositionstart", onCompositionStart);
    element.addEventListener("compositionupdate", onCompositionUpdate);
    element.addEventListener("compositionend", onCompositionEnd);
    element.addEventListener("blur", onBlur);
    return () => {
      element.removeEventListener("keydown", onKeyDown);
      element.removeEventListener("beforeinput", onBeforeInput as EventListener);
      element.removeEventListener("input", onInput as EventListener);
      element.removeEventListener("paste", onPaste);
      element.removeEventListener("compositionstart", onCompositionStart);
      element.removeEventListener("compositionupdate", onCompositionUpdate);
      element.removeEventListener("compositionend", onCompositionEnd);
      element.removeEventListener("blur", onBlur);
    };
  }, [attemptId, fieldInstanceId, fieldType, pairSessionId, recorder]);

  return (
    <textarea
      {...props}
      ref={(node) => {
        localRef.current = node;
        if (typeof forwardedRef === "function") forwardedRef(node);
        else if (forwardedRef) forwardedRef.current = node;
      }}
    />
  );
});
