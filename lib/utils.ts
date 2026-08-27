export function countWords(value: string): number {
  const trimmed = value.trim();
  return trimmed ? trimmed.split(/\s+/u).length : 0;
}

export function secondsRemaining(deadline: string | null, now = Date.now()): number {
  if (!deadline) return 0;
  return Math.max(0, Math.ceil((new Date(deadline).getTime() - now) / 1000));
}

export function secondsRemainingAfter(startedAt: string | null, durationSeconds: number, now = Date.now()): number {
  if (!startedAt) return 0;
  const deadline = new Date(startedAt).getTime() + durationSeconds * 1000;
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}

export function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(Math.max(0, totalSeconds) / 60);
  const seconds = Math.max(0, totalSeconds) % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function apiMessage(value: unknown, fallback = "Something went wrong. Please try again."): string {
  if (typeof value === "object" && value && "error" in value && typeof value.error === "string") {
    return value.error;
  }
  return fallback;
}

export function camelizeRow<T = Record<string, unknown>>(row: Record<string, unknown>): T {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    const camel = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
    output[camel] = value;
  }
  return output as T;
}
