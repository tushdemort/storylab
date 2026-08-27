import { describe, expect, it } from "vitest";
import { countOnlinePresences, onlinePresenceLabel } from "@/lib/presence";

describe("online presence", () => {
  it("counts synchronized sessions across presence keys", () => {
    expect(countOnlinePresences({ alpha: [{ presence_ref: "1" }], beta: [{ presence_ref: "2" }, { presence_ref: "3" }] })).toBe(3);
  });

  it("formats singular and plural labels", () => {
    expect(onlinePresenceLabel(1)).toBe("1 person online");
    expect(onlinePresenceLabel(4)).toBe("4 people online");
  });
});
