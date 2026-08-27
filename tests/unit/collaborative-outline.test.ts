import { describe, expect, it } from "vitest";
import {
  adjustOutlineSelection,
  createOutlineEdit,
  outlineSnapshot,
} from "@/lib/collaborative-outline";
import type { OutlineOperation, OutlineOperationBatch } from "@/lib/types";

function batch(id: string, operations: OutlineOperation[]): OutlineOperationBatch {
  return { clientBatchId: id, senderAttemptId: id, operations, createdAt: "2026-01-01T00:00:00.000Z" };
}

function edit(
  batches: OutlineOperationBatch[],
  after: string,
  clientId: string,
  clock: number,
  operationId: string,
) {
  const snapshot = outlineSnapshot(batches);
  return createOutlineEdit({
    before: snapshot.text,
    after,
    visibleIds: snapshot.visibleIds,
    clientId,
    clock,
    operationId,
  })!;
}

describe("collaborative outline", () => {
  it("applies ordinary insertion, replacement, and deletion", () => {
    const first = edit([], "A beginning", "alpha", 1, "op-1");
    const firstBatch = batch("batch-1", [first]);
    const second = edit([firstBatch], "A strong beginning", "alpha", 2, "op-2");
    const secondBatch = batch("batch-2", [second]);
    const third = edit([firstBatch, secondBatch], "A strong start", "alpha", 3, "op-3");

    expect(outlineSnapshot([firstBatch, secondBatch, batch("batch-3", [third])]).text).toBe("A strong start");
  });

  it("merges simultaneous inserts without replacing either participant", () => {
    const seed = edit([], "Start End", "seed", 1, "seed-op");
    const seedBatch = batch("seed-batch", [seed]);
    const left = edit([seedBatch], "Start brave End", "alpha", 2, "left-op");
    const right = edit([seedBatch], "Start quiet End", "beta", 2, "right-op");

    const forward = outlineSnapshot([seedBatch, batch("left", [left]), batch("right", [right])]).text;
    const reverse = outlineSnapshot([batch("right", [right]), batch("left", [left]), seedBatch]).text;
    expect(forward).toBe(reverse);
    expect(forward).toContain("brave ");
    expect(forward).toContain("quiet ");
    expect(forward).toMatch(/^Start .*End$/);
  });

  it("keeps inserts attached when another participant deletes the anchor", () => {
    const seed = edit([], "ABC", "seed", 1, "seed-op");
    const seedBatch = batch("seed", [seed]);
    const insertion = edit([seedBatch], "AB-new-C", "alpha", 2, "insert-op");
    const deletion = edit([seedBatch], "AC", "beta", 2, "delete-op");
    const result = outlineSnapshot([seedBatch, batch("insert", [insertion]), batch("delete", [deletion])]).text;

    expect(result).toBe("A-new-C");
  });

  it("moves a local cursor when remote text is inserted before it", () => {
    expect(adjustOutlineSelection("Start end", "Start shared end", 9)).toBe(16);
    expect(adjustOutlineSelection("Start end", "Start shared end", 2)).toBe(2);
  });
});
