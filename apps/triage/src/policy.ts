// Pure triage policy: Jev's typed answer + thresholds + project status -> one action.
// No I/O, so it is exhaustively unit tested. Human approval/merge stays with the team.
export type Decision = "accept" | "reject" | "needs_info";
export type ReasonCode = "none" | "duplicate" | "out_of_scope" | "underspecified" | "wip_limit" | "low_confidence" | "needs_info";

export interface Thresholds { accept: number; reject: number }
// Asymmetric on purpose: closing an issue is the destructive action, so rejecting needs more confidence than advancing.
// Evidence: docs/triage-eval.md (n=5, tuned on the same set; do not read as a measured accuracy).
export const DEFAULT_THRESHOLDS: Thresholds = { accept: 0.7, reject: 0.8 };

export interface ProjectStatus { inFlight: number; wipLimit: number }

export interface JevVerdict { decision: Decision; confidence: number; reason?: ReasonCode }

export type Action =
  | { kind: "advance"; reason: "none" }                                  // move to Triage/Planning
  | { kind: "reject"; reason: Exclude<ReasonCode, "none" | "wip_limit"> } // close with a reason code
  | { kind: "defer"; reason: "wip_limit" }                               // leave in Intake, retry later
  | { kind: "needs-human"; reason: ReasonCode };                         // leave in Intake, label needs-human

export function decide(v: JevVerdict, status: ProjectStatus, t: Thresholds = DEFAULT_THRESHOLDS): Action {
  if (!(v.confidence >= 0 && v.confidence <= 1) || Number.isNaN(v.confidence)) throw new RangeError(`confidence out of range: ${v.confidence}`);

  if (v.decision === "needs_info") return { kind: "needs-human", reason: "needs_info" };

  if (v.decision === "accept") {
    if (v.confidence < t.accept) return { kind: "needs-human", reason: "low_confidence" };
    if (status.inFlight >= status.wipLimit) return { kind: "defer", reason: "wip_limit" };
    return { kind: "advance", reason: "none" };
  }

  // reject
  if (v.confidence < t.reject) return { kind: "needs-human", reason: "low_confidence" };
  const r = v.reason;
  const reason = r && r !== "none" && r !== "wip_limit" && r !== "low_confidence" && r !== "needs_info" ? r : "out_of_scope";
  return { kind: "reject", reason };
}
