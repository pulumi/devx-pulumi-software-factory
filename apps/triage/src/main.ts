import { readFileSync } from "node:fs";
import { ask } from "./jevClient";
import { FactoryClient } from "./factoryClient";
import { runOnce } from "./evaluator";
import { DynamoAuditStore, InMemoryAuditStore, type AuditStore } from "./audit";

const env = (k: string, d?: string) => { const v = process.env[k] ?? d; if (v === undefined) throw new Error(`missing env ${k}`); return v; };
const num = (k: string, d: number) => Number(process.env[k] ?? d);

async function main() {
  if (process.env.TRIAGE_ENABLED === "false") { console.log("triage disabled (TRIAGE_ENABLED=false)"); return; }
  const factory = new FactoryClient({ baseUrl: env("FACTORY_INTERNAL_URL"), email: env("FACTORY_USER_EMAIL"), password: env("FACTORY_USER_PASSWORD"),
                                       origin: env("FACTORY_ORIGIN", "http://localhost:4111") });
  const apiKey = env("JEV_API_KEY");
  const jev = (state: string, q: Parameters<typeof ask>[2]) => ask({ apiKey, endpoint: process.env.JEV_ENDPOINT || undefined, timeoutMs: 8000 }, state, q);
  const audit: AuditStore = process.env.AUDIT_TABLE ? new DynamoAuditStore(process.env.AUDIT_TABLE, process.env.AWS_REGION ?? "us-east-1") : new InMemoryAuditStore();
  let brief = ""; try { brief = readFileSync(env("LOOP_PROMPT_PATH", "/prompt/factory-prompt.md"), "utf8"); } catch { console.warn("no coding-loop prompt found; triaging without a brief"); }
  const deps = { factory, jev, audit, brief, wipLimit: num("WIP_LIMIT", 3), acceptStage: env("ACCEPT_STAGE", "planning"),
    thresholds: { accept: num("ACCEPT_THRESHOLD", 0.7), reject: num("REJECT_THRESHOLD", 0.8) }, dryRun: process.env.TRIAGE_DRY_RUN === "true", log: (m: string) => console.log(m) };
  const interval = num("INTERVAL_SECONDS", 0);
  do {
    try {
      const only = process.env.TRIAGE_PROJECT;
      for (const p of (await factory.listProjects()).filter((x) => !only || x.name === only)) console.log(p.name, JSON.stringify(await runOnce(deps, p.id)));
    } catch (e) { console.error("pass failed:", (e as Error).message); }
    if (interval > 0) await new Promise((r) => setTimeout(r, interval * 1000));
  } while (interval > 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
