// Bring the agent-factory stacks up/down in dependency order via the Automation API.
//   tsx scripts/orchestrate.ts up|down [--only <stack>] [--yes] [--org <org>] [--env dev]
import { LocalWorkspace } from "@pulumi/pulumi/automation/index.js";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { plan, summary, type Result } from "./lib/plan.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const action = argv[0];
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
if (action !== "up" && action !== "down") { console.error("usage: orchestrate.ts up|down [--only <stack>] [--yes] [--org <org>] [--env dev]"); process.exit(2); }

const org = flag("org") ?? process.env.PULUMI_ORG;
if (!org) { console.error("set --org <org> or PULUMI_ORG (your Pulumi organization)"); process.exit(2); }
const env = flag("env") ?? "dev";
const steps = plan(action, flag("only"));
const fq = (stack: string) => `${org}/${stack}/${env}`;

console.log(`${action} plan: ${steps.map((s) => s.stack).join(" -> ")}`);
if (!argv.includes("--yes")) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${action === "up" ? "This can cost ~$2.2/hr (llm stack)." : "This destroys resources."} Continue? [y/N] `)).trim().toLowerCase();
  rl.close();
  if (a !== "y") { console.log("aborted"); process.exit(1); }
}

const results: Result[] = [];
let failed = false;
for (const step of steps) {
  if (failed) { results.push({ stack: step.stack, action: step.action, status: "skipped", seconds: 0 }); continue; }
  const t0 = Date.now();
  try {
    const stack = await LocalWorkspace.selectStack({ stackName: fq(step.stack), workDir: join(root, "stacks", step.stack) });
    const opts = { onOutput: (o: string) => process.stdout.write(o) };
    const r = step.action === "up" ? await stack.up(opts) : await stack.destroy(opts);
    results.push({ stack: step.stack, action: step.action, status: "ok", seconds: Math.round((Date.now() - t0) / 1000), detail: r.summary.result });
  } catch (e) {
    failed = true; // stop on first failure
    results.push({ stack: step.stack, action: step.action, status: "failed", seconds: Math.round((Date.now() - t0) / 1000), detail: String((e as Error).message).split("\n")[0] });
  }
}
console.log("\n" + summary(results));
process.exit(failed ? 1 : 0);
