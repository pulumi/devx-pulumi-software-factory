// Pure planning logic for orchestrate.ts (unit tested; no Pulumi imports).
export const UP_ORDER = ["llm", "platform", "factory", "agent", "triage"] as const;
export type StackName = (typeof UP_ORDER)[number];

export interface Step { stack: StackName; action: "up" | "destroy" }

export function plan(action: "up" | "down", only?: string): Step[] {
  const order = action === "up" ? [...UP_ORDER] : [...UP_ORDER].reverse();
  if (only !== undefined && !UP_ORDER.includes(only as StackName)) {
    throw new Error(`unknown stack '${only}'; expected one of ${UP_ORDER.join(", ")}`);
  }
  return order.filter((s) => only === undefined || s === only)
    .map((stack) => ({ stack, action: action === "up" ? "up" : "destroy" }));
}

export interface Result { stack: string; action: string; status: "ok" | "failed" | "skipped"; seconds: number; detail?: string }

export function summary(results: Result[]): string {
  const w = Math.max(5, ...results.map((r) => r.stack.length));
  const rows = results.map((r) => `${r.stack.padEnd(w)}  ${r.action.padEnd(7)}  ${r.status.padEnd(7)}  ${String(r.seconds).padStart(5)}s  ${r.detail ?? ""}`.trimEnd());
  return [`${"stack".padEnd(w)}  action   status   time`, ...rows].join("\n");
}
