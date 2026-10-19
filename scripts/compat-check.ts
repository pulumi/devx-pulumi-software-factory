// Cross-stack compatibility check against the LIVE stacks and cluster.
//   . stacks/llm/creds.sh; KUBECONFIG=<file> tsx scripts/compat-check.ts [--org <org>] [--env dev] [--owner you@example.com]
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkContracts, checkNoPlaintextSecrets, checkOwnerTags, summarize, type Check, type Outputs, type TaggedResource } from "./lib/compat.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const flag = (n: string, d: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d; };
const org = flag("org", process.env.PULUMI_ORG ?? ""), env = flag("env", "dev"), owner = flag("owner", "you@example.com"), NS = "agent-platform";
const run = (cmd: string, args: string[], cwd?: string) => spawnSync(cmd, args, { encoding: "utf8", cwd });

const outputs = (stack: string): Outputs => {
  const r = run("pulumi", ["stack", "output", "--json", "-s", `${org}/${stack}/${env}`], join(root, "stacks", stack));
  if (r.status !== 0) throw new Error(`cannot read outputs of ${stack}: ${r.stderr.trim().slice(0, 200)}`);
  return JSON.parse(r.stdout);
};
const S = { llm: outputs("llm"), platform: outputs("platform"), factory: outputs("factory"), agent: outputs("agent"), triage: outputs("triage") };
const checks: Check[] = [...checkContracts(S), ...checkNoPlaintextSecrets(S)];

// In-cluster reachability, run from inside the agent pod (it sits in the shared namespace, so this also proves the NetworkPolicy allows it).
const probe = (name: string, url: string, expect = "200") => {
  const js = `fetch(${JSON.stringify(url)}).then(r=>console.log(r.status)).catch(e=>console.log('ERR '+e.message))`;
  const r = run("kubectl", ["exec", "-n", NS, "deploy/agent", "--", "node", "-e", js]);
  const got = r.stdout.trim();
  checks.push({ name: `from the agent pod: ${name}`, ok: got === expect, detail: `got ${got || r.stderr.trim().slice(0, 80)}` });
};
probe("Factory /health", `${S.platform.factoryInternalUrl}/health`);
probe("LLM /v1/models", `${S.platform.llmBaseUrl}/models`);
probe("agent /healthz", `${S.agent.agentInternalUrl}/healthz`);

// Namespace + labels consistent: every Deployment/StatefulSet carries part-of=agent-factory.
const wl = run("kubectl", ["get", "deploy,statefulset", "-n", NS, "-o", "json"]);
try {
  const items = JSON.parse(wl.stdout).items as any[];
  const bad = items.filter((i) => i.metadata.labels?.["app.kubernetes.io/part-of"] !== "agent-factory").map((i) => i.metadata.name);
  checks.push({ name: "all workloads in agent-platform carry part-of=agent-factory", ok: bad.length === 0 && items.length > 0, detail: `unlabeled: ${bad.join(", ")}` });
  const notReady = items.filter((i) => (i.status.readyReplicas ?? 0) < (i.spec.replicas ?? 1)).map((i) => i.metadata.name);
  checks.push({ name: "all workloads are Ready", ok: notReady.length === 0, detail: `not ready: ${notReady.join(", ")}` });
} catch { checks.push({ name: "could read workloads", ok: false, detail: wl.stderr.slice(0, 100) }); }

// Owner tag on AWS resources the stacks created (the sandbox reaper deletes untagged ones).
const tg = run("aws", ["resourcegroupstaggingapi", "get-resources", "--region", "us-east-1", "--tag-filters", `Key=Owner,Values=${owner}`, "--output", "json"]);
try {
  const res: TaggedResource[] = JSON.parse(tg.stdout).ResourceTagMappingList.map((r: any) => ({ arn: r.ResourceARN, tags: Object.fromEntries(r.Tags.map((t: any) => [t.Key, t.Value])) }));
  checks.push(...checkOwnerTags(res, owner, [String(S.llm.cluster_name), String(S.triage.auditTable), "repository/factory", "repository/agent", "repository/triage"]));
} catch { checks.push({ name: "could query AWS tags", ok: false, detail: tg.stderr.slice(0, 120) }); }

const { text, failed } = summarize(checks);
console.log(text);
process.exit(failed ? 1 : 0);
