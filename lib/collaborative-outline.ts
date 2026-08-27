import type { OutlineOperation, OutlineOperationBatch } from "@/lib/types";

const CLOCK_WIDTH = 12;

type OutlineNode = {
  id: string;
  afterId: string | null;
  value: string;
  clock: number;
};

export type OutlineSnapshot = {
  text: string;
  visibleIds: string[];
  maxClock: number;
};

function runClock(id: string) {
  const value = Number.parseInt(id.slice(0, CLOCK_WIDTH), 10);
  return Number.isFinite(value) ? value : 0;
}

function characterId(runId: string, index: number) {
  return `${runId}@${String(index).padStart(6, "0")}`;
}

function uniqueOperations(batches: OutlineOperationBatch[]) {
  const operations = new Map<string, OutlineOperation>();
  for (const batch of batches) {
    for (const operation of batch.operations) {
      if (!operations.has(operation.id)) operations.set(operation.id, operation);
    }
  }
  return [...operations.values()];
}

export function outlineSnapshot(batches: OutlineOperationBatch[]): OutlineSnapshot {
  const nodes = new Map<string, OutlineNode>();
  const deleted = new Set<string>();
  let maxClock = 0;

  for (const operation of uniqueOperations(batches)) {
    operation.deleteIds.forEach((id) => deleted.add(id));
    for (const run of operation.insertRuns) {
      const clock = runClock(run.id);
      maxClock = Math.max(maxClock, clock);
      let afterId = run.afterId;
      Array.from(run.text).forEach((value, index) => {
        const id = characterId(run.id, index);
        if (!nodes.has(id)) nodes.set(id, { id, afterId, value, clock });
        afterId = id;
      });
    }
  }

  const children = new Map<string | null, OutlineNode[]>();
  for (const node of nodes.values()) {
    const siblings = children.get(node.afterId) ?? [];
    siblings.push(node);
    children.set(node.afterId, siblings);
  }
  for (const siblings of children.values()) {
    siblings.sort((left, right) => right.clock - left.clock || right.id.localeCompare(left.id));
  }

  const text: string[] = [];
  const visibleIds: string[] = [];
  const visited = new Set<string>();
  const visit = (afterId: string | null) => {
    for (const node of children.get(afterId) ?? []) {
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      if (!deleted.has(node.id)) {
        text.push(node.value);
        visibleIds.push(node.id);
      }
      visit(node.id);
    }
  };
  visit(null);

  return { text: text.join(""), visibleIds, maxClock };
}

export function createOutlineEdit({
  before,
  after,
  visibleIds,
  clientId,
  clock,
  operationId,
}: {
  before: string;
  after: string;
  visibleIds: string[];
  clientId: string;
  clock: number;
  operationId: string;
}): OutlineOperation | null {
  const beforeCharacters = Array.from(before);
  const afterCharacters = Array.from(after);
  if (beforeCharacters.length !== visibleIds.length) {
    throw new Error("The shared outline changed before this edit could be applied.");
  }

  let prefix = 0;
  while (
    prefix < beforeCharacters.length
    && prefix < afterCharacters.length
    && beforeCharacters[prefix] === afterCharacters[prefix]
  ) prefix += 1;

  let suffix = 0;
  while (
    suffix < beforeCharacters.length - prefix
    && suffix < afterCharacters.length - prefix
    && beforeCharacters[beforeCharacters.length - 1 - suffix] === afterCharacters[afterCharacters.length - 1 - suffix]
  ) suffix += 1;

  const deleteIds = visibleIds.slice(prefix, beforeCharacters.length - suffix);
  const insertedText = afterCharacters.slice(prefix, afterCharacters.length - suffix).join("");
  if (!deleteIds.length && !insertedText) return null;

  return {
    id: operationId,
    insertRuns: insertedText ? [{
      id: `${String(clock).padStart(CLOCK_WIDTH, "0")}:${clientId}`,
      afterId: prefix > 0 ? visibleIds[prefix - 1] : null,
      text: insertedText,
    }] : [],
    deleteIds,
  };
}

export function mergeOutlineBatches(...groups: OutlineOperationBatch[][]) {
  const batches = new Map<string, OutlineOperationBatch>();
  for (const group of groups) {
    for (const batch of group) batches.set(batch.clientBatchId, batch);
  }
  return [...batches.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt) || left.clientBatchId.localeCompare(right.clientBatchId));
}

export function adjustOutlineSelection(previous: string, next: string, position: number) {
  let prefix = 0;
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < previous.length - prefix
    && suffix < next.length - prefix
    && previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix += 1;

  const previousChangeEnd = previous.length - suffix;
  const nextChangeEnd = next.length - suffix;
  if (position <= prefix) return position;
  if (position >= previousChangeEnd) return Math.max(0, position + nextChangeEnd - previousChangeEnd);
  return nextChangeEnd;
}
