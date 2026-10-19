import type { WorkItem } from "./factoryClient";
import type { ProjectStatus } from "./policy";
import type { Questions } from "./jevClient";

export const MAX_STATE_CHARS = 24_000; // Jev budget is 32k tokens for state + longest question; stay well under it.
const MAX_BRIEF = 6_000, MAX_BODY = 12_000, MAX_OTHERS = 25;
const clip = (t: string, n: number) => (t.length > n ? t.slice(0, n) + "\n[truncated]" : t);

/** The context bundle: (a) original coding-loop prompt, (b) the issue, (c) a project status summary.
 *  The long, user-controlled parts are clipped individually so the status section is never cut off. */
export function buildState(brief: string, item: WorkItem, status: ProjectStatus, others: string[] = []): string {
  const body = typeof item.metadata?.body === "string" ? (item.metadata.body as string) : "";
  const text = [
    "PROJECT BRIEF (what this software factory is building):",
    clip(brief.trim() || "(no brief provided)", MAX_BRIEF),
    "",
    "ISSUE UNDER REVIEW:",
    `Title: ${clip(item.title, 500)}`,
    body ? `Description: ${clip(body, MAX_BODY)}` : "Description: (none)",
    "",
    "PROJECT STATUS:",
    `Work in flight: ${status.inFlight} of ${status.wipLimit} allowed.`,
    "",
    "OTHER OPEN ISSUES (for spotting duplicates):",
    ...(others.length ? others.slice(0, MAX_OTHERS).map((o) => `- ${clip(o, 160)}`) : ["(none)"]),
  ].join("\n");
  return text.slice(0, MAX_STATE_CHARS);
}

/** Jev answers typed choices only (no prose): a decision and a reason code. */
export const QUESTIONS: Questions = {
  decision: {
    type: "choice",
    instructions: "Should this issue be accepted into the build pipeline for the project described in the brief?",
    criteria: {
      accept:
        "The issue asks for a concrete feature, change or fix to the application described in the brief " +
        "(its behaviour, UI, reliability, performance or tests) and is specific enough to act on.",
      reject: "The issue is out of scope for the brief, or a duplicate of other work, or not a software task.",
      needs_info: "The issue is too vague or underspecified to act on without more information.",
    },
  },
  reason: {
    type: "choice",
    instructions: "What is the main reason for the decision on this issue?",
    criteria: {
      none: "No problem: the issue is fine as written.",
      duplicate: "The issue repeats work that already exists or is already requested.",
      out_of_scope: "The issue is unrelated to the project brief.",
      underspecified: "The issue lacks the detail needed to start work.",
    },
  },
};
