// Set Factory up to use the model. Idempotent; safe to re-run. (The project brief is Pulumi config on the platform stack.)
//   KUBECONFIG=<file> tsx scripts/bootstrap.ts [--project agent-factory-demo] [--dry-run]
// 1 service account + Factory model/project  2 wait for health
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { FactoryBootstrap } from "./lib/bootstrap-core.js";

const argv = process.argv.slice(2);
const flag = (n: string, d?: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const has = (n: string) => argv.includes(`--${n}`);
const NS = process.env.NS ?? "agent-platform";
const dryRun = has("dry-run");
const projectName = flag("project", "agent-factory-demo")!;
const sh = (cmd: string, args: string[], input?: string) => spawnSync(cmd, args, { encoding: "utf8", input });
const kubectl = (args: string[], input?: string) => { const r = sh("kubectl", args, input); if (r.status !== 0) throw new Error(`kubectl ${args.slice(0, 3).join(" ")} failed: ${r.stderr.trim().slice(0, 200)}`); return r.stdout; };
const secret = (name: string, key: string) => Buffer.from(kubectl(["get", "secret", name, "-n", NS, "-o", `jsonpath={.data.${key}}`]), "base64").toString();
const freePort = () => new Promise<number>((res) => { const s = createServer().listen(0, "127.0.0.1", () => { const p = (s.address() as any).port; s.close(() => res(p)); }); });
const log = (m: string) => console.log(m);

// 1. Factory configuration over its API (via a temporary port-forward)
const port = await freePort();
const pf = spawn("kubectl", ["port-forward", "-n", NS, "svc/factory", `${port}:4111`], { stdio: "ignore" });
const stop = () => { pf.kill(); };
process.on("exit", stop); process.on("SIGINT", () => { stop(); process.exit(130); });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/health`)).ok) break; } catch { /* not up yet */ } await new Promise((r) => setTimeout(r, 1000)); }

const cm = JSON.parse(kubectl(["get", "configmap", "platform-config", "-n", NS, "-o", "json"])).data as Record<string, string>;
const fb = new FactoryBootstrap({
  baseUrl: base, origin: process.env.FACTORY_ORIGIN ?? "http://localhost:4111",
  email: secret("factory-service-account", "FACTORY_USER_EMAIL"), password: secret("factory-service-account", "FACTORY_USER_PASSWORD"),
  llmBaseUrl: cm.LLM_BASE_URL, llmModel: cm.LLM_MODEL, projectName,
});
await fb.ensureServiceUser(dryRun);
const modelId = await fb.ensureModel(dryRun);
const projectId = await fb.ensureProject(modelId, dryRun);
for (const c of fb.changes) log(`${dryRun ? "[dry-run] " : ""}${c.what}${c.detail ? `: ${c.detail}` : ""}`);
if (!fb.changes.length) log("Factory already configured (no changes)");
stop();

// 2. wait for health
for (const d of ["factory", "agent"]) {
  const r = sh("kubectl", ["rollout", "status", `deploy/${d}`, "-n", NS, "--timeout=180s"]);
  log(`${d}: ${r.status === 0 ? "ready" : "NOT ready"}`); if (r.status !== 0 && !dryRun) process.exitCode = 1;
}
log(dryRun ? "dry-run complete (nothing changed)" : "bootstrap complete");
