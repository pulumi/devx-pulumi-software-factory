import type { FactoryClient, WorkItem } from "./factoryClient";
import type { JevResponse, Questions } from "./jevClient";
import { decide, DEFAULT_THRESHOLDS, type Action, type ReasonCode, type Thresholds, type JevVerdict, type ProjectStatus } from "./policy";
import { buildState, QUESTIONS } from "./context";
import { contentHash, uuidFrom } from "./ids";
import { isFinal, type AuditRecord, type AuditStore } from "./audit";

const IN_FLIGHT_STAGES = new Set(["triage", "planning", "execute", "review"]);
export const currentStage = (i: WorkItem) => i.stages[i.stages.length - 1] ?? "intake";

export interface Deps {
  factory: Pick<FactoryClient, "listWorkItems" | "transition" | "patchMetadata">;
  jev: (state: string, questions: Questions) => Promise<JevResponse>;
  audit: AuditStore;
  brief: string;
  thresholds?: Thresholds;
  wipLimit?: number;
  acceptStage?: string;      // where accepted items go (default planning)
  dryRun?: boolean;
  now?: () => Date;
  log?: (msg: string) => void;
}

export interface Summary { scanned: number; skipped: number; advanced: number; rejected: number; needsHuman: number; deferred: number; errors: number; dryRun: boolean }

function verdictFrom(r: JevResponse): JevVerdict {
  const d = r.answers.decision, why = r.answers.reason;
  return { decision: d.choice as JevVerdict["decision"], confidence: d.confidence, reason: (why?.choice as ReasonCode | undefined) };
}

export async function runOnce(deps: Deps, projectId: string): Promise<Summary> {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());
  const thresholds = deps.thresholds ?? DEFAULT_THRESHOLDS;
  const wipLimit = deps.wipLimit ?? 3;
  const dryRun = deps.dryRun ?? false;
  const acceptStage = deps.acceptStage ?? "planning";
  const s: Summary = { scanned: 0, skipped: 0, advanced: 0, rejected: 0, needsHuman: 0, deferred: 0, errors: 0, dryRun };

  const items = await deps.factory.listWorkItems(projectId);
  const status: ProjectStatus = { inFlight: items.filter((i) => IN_FLIGHT_STAGES.has(currentStage(i))).length, wipLimit };

  for (const item of items.filter((i) => currentStage(i) === "intake")) {
    s.scanned++;
    const body = typeof item.metadata?.body === "string" ? (item.metadata.body as string) : "";
    // The brief is part of the decision context, so a changed brief must re-evaluate previously decided items.
    const key = `${item.id}#${contentHash(item.title, body, deps.brief)}`;
    const prior = await deps.audit.get(key);
    if (prior && isFinal(prior)) { s.skipped++; continue; }

    let verdict: JevVerdict; const t0 = Date.now();
    try {
      // Duplicates are judged only against EARLIER work: items already past intake, or created before this one.
      // Otherwise two copies of the same request would each be flagged a duplicate of the other and neither accepted.
      const others = items.filter((o) => o.id !== item.id && currentStage(o) !== "canceled" && currentStage(o) !== "done"
          && (currentStage(o) !== "intake" || (!!o.createdAt && !!item.createdAt && o.createdAt < item.createdAt)))
        .map((o) => `[${currentStage(o)}] ${o.title}`);
      verdict = verdictFrom(await deps.jev(buildState(deps.brief, item, status, others), QUESTIONS));
    } catch (e) {
      s.errors++; log(`jev failed for ${item.id}: ${(e as Error).message}; leaving item untouched`);
      continue;   // issue left alone, retried on the next pass
    }
    const latencyMs = Date.now() - t0;
    const action: Action = decide(verdict, status, thresholds);
    let applied = false;

    if (!dryRun) {
      try {
        const tag = { decision: verdict.decision, confidence: verdict.confidence, reason: action.reason, action: action.kind, at: now().toISOString() };
        const meta = { ...(item.metadata ?? {}), triage: { ...tag, needsHuman: action.kind === "needs-human" } };
        if (action.kind === "advance") {
          const r = await deps.factory.transition(projectId, item, acceptStage, `jev:accept confidence=${verdict.confidence}`, uuidFrom(`${item.id}:${item.revision}:advance`));
          applied = r.status === "accepted"; if (applied) status.inFlight++;
        } else if (action.kind === "reject") {
          const newRevision = await deps.factory.patchMetadata(item.id, meta);   // the PATCH bumps the revision
          const fresh = { ...item, revision: newRevision ?? item.revision + 1 };
          const r = await deps.factory.transition(projectId, fresh, "canceled", `jev:reject reason=${action.reason} confidence=${verdict.confidence}`, uuidFrom(`${item.id}:${item.revision}:reject`));
          applied = r.status === "accepted";
        } else if (action.kind === "needs-human") {
          await deps.factory.patchMetadata(item.id, meta); applied = true;
        } // defer: no write
      } catch (e) { s.errors++; log(`factory write failed for ${item.id}: ${(e as Error).message}`); }
    }

    if (action.kind === "advance") s.advanced++; else if (action.kind === "reject") s.rejected++;
    else if (action.kind === "needs-human") s.needsHuman++; else s.deferred++;

    const rec: AuditRecord = { key, itemId: item.id, title: item.title, projectId, decision: verdict.decision, confidence: verdict.confidence,
      reason: action.reason, action: action.kind, applied, dryRun, at: now().toISOString(), latencyMs };
    await deps.audit.put(rec);
    log(`${dryRun ? "[dry-run] " : ""}${item.title.slice(0, 50)} -> ${action.kind} (${verdict.decision} ${verdict.confidence}, ${action.reason}) ${latencyMs}ms`);
  }
  return s;
}
