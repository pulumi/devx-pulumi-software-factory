import { describe, it, expect, vi } from "vitest";
import { runOnce, currentStage, type Deps } from "../src/evaluator";
import { InMemoryAuditStore } from "../src/audit";
import { uuidFrom, contentHash } from "../src/ids";
import { buildState } from "../src/context";
import type { WorkItem } from "../src/factoryClient";
import type { JevResponse } from "../src/jevClient";

const item = (over: Partial<WorkItem> = {}): WorkItem => ({ id: "w1", title: "Add typing indicator", stages: ["intake"], revision: 1, metadata: null, board: "work", ...over });
const jevAnswer = (decision: string, confidence: number, reason = "none"): JevResponse => ({ model: "jev", answers: {
  decision: { type: "choice", choice: decision, confidence }, reason: { type: "choice", choice: reason, confidence: 0.9 } } });

function mk(items: WorkItem[], jev: Deps["jev"], extra: Partial<Deps> = {}) {
  const factory = {
    listWorkItems: vi.fn(async () => items),
    transition: vi.fn(async () => ({ status: "accepted" as const, revision: 2 })),
    patchMetadata: vi.fn(async () => 2 as number | undefined),
  };
  const audit = new InMemoryAuditStore();
  const deps: Deps = { factory, jev, audit, brief: "Build a web IM", wipLimit: 3, ...extra };
  return { deps, factory, audit };
}

describe("triage evaluator", () => {
  it("accept above threshold -> transition to planning with a deterministic requestId, audited", async () => {
    const { deps, factory, audit } = mk([item()], async () => jevAnswer("accept", 0.97));
    const s = await runOnce(deps, "p1");
    expect(s).toMatchObject({ advanced: 1, rejected: 0, errors: 0 });
    const [pid, it_, stage, cause, rid] = factory.transition.mock.calls[0] as any[];
    expect([pid, it_.id, stage]).toEqual(["p1", "w1", "planning"]);
    expect(cause).toContain("jev:accept");
    expect(rid).toBe(uuidFrom("w1:1:advance"));
    expect([...audit.rows.values()][0]).toMatchObject({ action: "advance", applied: true, decision: "accept" });
  });

  it("reject with reason -> metadata then transition to canceled", async () => {
    const { deps, factory } = mk([item()], async () => jevAnswer("reject", 0.95, "duplicate"));
    const s = await runOnce(deps, "p1");
    expect(s.rejected).toBe(1);
    expect((factory.patchMetadata.mock.calls[0] as any[])[1].triage).toMatchObject({ reason: "duplicate", action: "reject" });
    const [, sent, stage, , rid] = factory.transition.mock.calls[0] as any[];
    expect(stage).toBe("canceled");
    expect(sent.revision).toBe(2);                            // uses the revision returned by the PATCH, not the stale one
    expect(rid).toBe(uuidFrom("w1:1:reject"));                // requestId stays keyed to the ORIGINAL revision (stable across retries)
  });

  it("low confidence / needs_info -> needs-human metadata, item stays in intake", async () => {
    const { deps, factory } = mk([item({ id: "a" }), item({ id: "b" })], async (state) => state.includes("Add typing") && Math.random() < 2 ? jevAnswer("accept", 0.5) : jevAnswer("needs_info", 0.9));
    const s = await runOnce(deps, "p1");
    expect(s.needsHuman).toBe(2);
    expect(factory.transition).not.toHaveBeenCalled();
    expect((factory.patchMetadata.mock.calls[0] as any[])[1].triage.needsHuman).toBe(true);
  });

  it("WIP limit defers instead of advancing, and in-flight count includes items advanced in this pass", async () => {
    const busy = [item({ id: "x1", stages: ["execute"] }), item({ id: "x2", stages: ["review"] }), item({ id: "n1" }), item({ id: "n2" })];
    const { deps, factory } = mk(busy, async () => jevAnswer("accept", 0.99), { wipLimit: 3 });
    const s = await runOnce(deps, "p1");
    expect(s.advanced).toBe(1); expect(s.deferred).toBe(1);     // 2 in flight + 1 advanced = 3 = limit
    expect(factory.transition).toHaveBeenCalledTimes(1);
  });

  it("is idempotent: a second pass takes no new action on a finalized item", async () => {
    const { deps, factory } = mk([item()], async () => jevAnswer("accept", 0.97));
    await runOnce(deps, "p1"); const s2 = await runOnce(deps, "p1");
    expect(s2.skipped).toBe(1); expect(s2.advanced).toBe(0);
    expect(factory.transition).toHaveBeenCalledTimes(1);
  });

  it("re-evaluates an item whose content changed", async () => {
    const items = [item()]; const { deps } = mk(items, async () => jevAnswer("needs_info", 0.9));
    await runOnce(deps, "p1"); items[0] = item({ title: "Add typing indicator with details" });
    expect((await runOnce(deps, "p1")).skipped).toBe(0);
  });

  it("re-evaluates when the project brief changes (decisions depend on it)", async () => {
    const { deps, audit } = mk([item()], async () => jevAnswer("needs_info", 0.9));
    await runOnce(deps, "p1");
    expect((await runOnce(deps, "p1")).skipped).toBe(1);
    expect((await runOnce({ ...deps, brief: "A different brief" }, "p1")).skipped).toBe(0);
    expect(audit.rows.size).toBe(2);
  });

  it("Jev failure leaves the item untouched and unaudited, to be retried", async () => {
    const { deps, factory, audit } = mk([item()], async () => { throw new Error("timeout"); });
    const s = await runOnce(deps, "p1");
    expect(s.errors).toBe(1); expect(factory.transition).not.toHaveBeenCalled(); expect(factory.patchMetadata).not.toHaveBeenCalled();
    expect(audit.rows.size).toBe(0);
  });

  it("dry-run decides and audits but makes no Factory writes", async () => {
    const { deps, factory, audit } = mk([item()], async () => jevAnswer("accept", 0.97), { dryRun: true });
    const s = await runOnce(deps, "p1");
    expect(s).toMatchObject({ advanced: 1, dryRun: true });
    expect(factory.transition).not.toHaveBeenCalled(); expect(factory.patchMetadata).not.toHaveBeenCalled();
    expect([...audit.rows.values()][0]).toMatchObject({ applied: false, dryRun: true });
  });

  it("a stale-revision rejection is not final, so the item is retried next pass", async () => {
    const { deps, factory } = mk([item()], async () => jevAnswer("accept", 0.97));
    factory.transition.mockResolvedValueOnce({ status: "rejected", code: "stale" } as any);
    await runOnce(deps, "p1");
    expect((await runOnce(deps, "p1")).advanced).toBe(1);
  });

  it("only scans items currently in intake", async () => {
    const { deps } = mk([item({ stages: ["intake", "planning"] }), item({ id: "z", stages: ["done"] })], async () => jevAnswer("accept", 0.99));
    expect((await runOnce(deps, "p1")).scanned).toBe(0);
    expect(currentStage(item({ stages: ["intake", "triage"] }))).toBe("triage");
  });
});

describe("ids and context", () => {
  it("uuidFrom is a stable RFC4122 v5-style UUID", () => {
    expect(uuidFrom("a")).toBe(uuidFrom("a")); expect(uuidFrom("a")).not.toBe(uuidFrom("b"));
    expect(uuidFrom("a")).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(contentHash("x", "y")).toBe(contentHash("x", "y")); expect(contentHash("x", "y")).not.toBe(contentHash("xy", ""));
  });
  it("passes other open issues to Jev (for duplicate detection) but not closed ones or the issue itself", async () => {
    const seen: string[] = [];
    const items = [item({ id: "a", title: "Add typing indicator", createdAt: "2026-10-09T10:00:00Z" }), item({ id: "b", title: "Show typing status", stages: ["planning"] }), item({ id: "c", title: "old", stages: ["canceled"] })];
    const { deps } = mk(items, async (state) => { seen.push(state); return jevAnswer("needs_info", 0.9); });
    await runOnce(deps, "p1");
    expect(seen[0]).toContain("[planning] Show typing status");
    expect(seen[0]).not.toContain("old"); expect(seen[0].split("OTHER OPEN ISSUES")[1]).not.toContain("- [intake] Add typing indicator");
  });
  it("an intake item is only compared with EARLIER intake items (so the first of two duplicates is not flagged)", async () => {
    const seen: Record<string, string> = {};
    const items = [item({ id: "first", title: "Typing indicator", createdAt: "2026-10-09T10:00:00Z" }), item({ id: "second", title: "Typing hint", createdAt: "2026-10-09T10:05:00Z" })];
    const { deps } = mk(items, async (state) => { seen[state.includes("Title: Typing indicator") ? "first" : "second"] = state; return jevAnswer("needs_info", 0.9); });
    await runOnce(deps, "p1");
    expect(seen.first.split("OTHER OPEN ISSUES")[1]).toContain("(none)");
    expect(seen.second.split("OTHER OPEN ISSUES")[1]).toContain("[intake] Typing indicator");
  });
  it("buildState carries brief, issue and WIP status, and stays bounded", () => {
    const st = buildState("Build a web IM", item({ title: "T", metadata: { body: "B".repeat(50_000) } }), { inFlight: 2, wipLimit: 3 });
    expect(st).toContain("Build a web IM"); expect(st).toContain("Title: T"); expect(st).toContain("2 of 3");
    expect(st.length).toBeLessThan(25_000); expect(st).toContain("[truncated]");
  });
});
