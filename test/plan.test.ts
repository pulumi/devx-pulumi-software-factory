import { describe, it, expect } from "vitest";
import { plan, summary } from "../scripts/lib/plan";

describe("orchestrate plan", () => {
  it("brings stacks up in dependency order", () =>
    expect(plan("up").map((s) => s.stack)).toEqual(["llm", "platform", "factory", "agent", "triage"]));
  it("tears down in reverse order using destroy", () => {
    const p = plan("down");
    expect(p.map((s) => s.stack)).toEqual(["triage", "agent", "factory", "platform", "llm"]);
    expect(p.every((s) => s.action === "destroy")).toBe(true);
  });
  it("--only selects one stack and rejects unknown names", () => {
    expect(plan("up", "agent")).toEqual([{ stack: "agent", action: "up" }]);
    expect(() => plan("up", "nope")).toThrow(/unknown stack/);
  });
  it("summary lists each result", () => {
    const s = summary([{ stack: "llm", action: "up", status: "ok", seconds: 1800 }, { stack: "platform", action: "up", status: "skipped", seconds: 0 }]);
    expect(s).toContain("llm"); expect(s).toContain("skipped");
  });
});
