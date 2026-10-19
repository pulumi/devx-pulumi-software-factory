import { describe, it, expect } from "vitest";
import { decide, DEFAULT_THRESHOLDS, type JevVerdict } from "../src/policy";

const free = { inFlight: 1, wipLimit: 3 };
const full = { inFlight: 3, wipLimit: 3 };
const v = (decision: JevVerdict["decision"], confidence: number, reason?: JevVerdict["reason"]): JevVerdict => ({ decision, confidence, reason });

describe("triage policy", () => {
  it("accepts at/above threshold when WIP allows", () => {
    expect(decide(v("accept", 0.7), free)).toEqual({ kind: "advance", reason: "none" });
    expect(decide(v("accept", 0.99), free).kind).toBe("advance");
  });
  it("defers (does not advance) when the WIP limit is reached", () => {
    expect(decide(v("accept", 0.99), full)).toEqual({ kind: "defer", reason: "wip_limit" });
  });
  it("sends low-confidence accepts and rejects to a human", () => {
    expect(decide(v("accept", 0.69), free)).toEqual({ kind: "needs-human", reason: "low_confidence" });
    expect(decide(v("reject", 0.5, "duplicate"), free)).toEqual({ kind: "needs-human", reason: "low_confidence" });
  });
  it("rejects confidently with the reason code from Jev", () => {
    expect(decide(v("reject", 0.95, "duplicate"), free)).toEqual({ kind: "reject", reason: "duplicate" });
    expect(decide(v("reject", 0.9, "underspecified"), free)).toEqual({ kind: "reject", reason: "underspecified" });
  });
  it("falls back to out_of_scope when a reject carries no usable reason", () => {
    expect(decide(v("reject", 0.9), free)).toEqual({ kind: "reject", reason: "out_of_scope" });
    expect(decide(v("reject", 0.9, "none"), free)).toEqual({ kind: "reject", reason: "out_of_scope" });
    expect(decide(v("reject", 0.9, "wip_limit"), free)).toEqual({ kind: "reject", reason: "out_of_scope" });
  });
  it("needs_info always goes to a human, whatever the confidence", () => {
    expect(decide(v("needs_info", 1), free)).toEqual({ kind: "needs-human", reason: "needs_info" });
  });
  it("WIP never blocks a rejection", () => {
    expect(decide(v("reject", 0.95, "duplicate"), full).kind).toBe("reject");
  });
  it("custom thresholds are honored and boundaries are inclusive", () => {
    const t = { accept: 0.9, reject: 0.6 };
    expect(decide(v("accept", 0.89), free, t).kind).toBe("needs-human");
    expect(decide(v("accept", 0.9), free, t).kind).toBe("advance");
    expect(decide(v("reject", 0.6, "out_of_scope"), free, t).kind).toBe("reject");
  });
  it("rejects invalid confidence values", () => {
    expect(() => decide(v("accept", 1.2), free)).toThrow(RangeError);
    expect(() => decide(v("accept", NaN), free)).toThrow(RangeError);
    expect(DEFAULT_THRESHOLDS).toEqual({ accept: 0.7, reject: 0.8 });
  });
});
