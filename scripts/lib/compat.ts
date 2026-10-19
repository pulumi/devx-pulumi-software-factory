// Pure cross-stack contract checks (no I/O). Input: each stack's `pulumi stack output --json` (secrets appear as "[secret]").
export type Outputs = Record<string, unknown>;
export interface Stacks { llm: Outputs; platform: Outputs; factory: Outputs; agent: Outputs; triage: Outputs }
export interface Check { name: string; ok: boolean; detail?: string }

const isUrl = (v: unknown) => typeof v === "string" && /^https?:\/\/[^\s]+$/.test(v);
const nonEmpty = (v: unknown) => typeof v === "string" && v.trim().length > 0;
const SECRET = "[secret]";

export const PLATFORM_CONTRACT = ["namespace", "kubeconfig", "llmBaseUrl", "llmModel", "factoryInternalUrl", "sharedLabels", "owner", "configMapName", "secretNames"];

export function checkContracts(s: Stacks): Check[] {
  const c: Check[] = [];
  const add = (name: string, ok: boolean, detail?: string) => c.push({ name, ok, detail: ok ? undefined : detail });
  const missing = PLATFORM_CONTRACT.filter((k) => !(k in s.platform));
  add("platform exports every contract field", missing.length === 0, `missing: ${missing.join(", ")}`);
  add("llm exports an OpenAI base URL ending in /v1", isUrl(s.llm.llm_openai_base_url) && String(s.llm.llm_openai_base_url).endsWith("/v1"), String(s.llm.llm_openai_base_url));
  add("llm exports a model id and cluster name", nonEmpty(s.llm.llm_model) && nonEmpty(s.llm.cluster_name));
  add("platform.llmBaseUrl == llm.llm_openai_base_url (no drift)", s.platform.llmBaseUrl === s.llm.llm_openai_base_url, `${s.platform.llmBaseUrl} vs ${s.llm.llm_openai_base_url}`);
  add("platform.llmModel == llm.llm_model (no drift)", s.platform.llmModel === s.llm.llm_model, `${s.platform.llmModel} vs ${s.llm.llm_model}`);
  add("factory.factoryInternalUrl == platform.factoryInternalUrl", s.factory.factoryInternalUrl === s.platform.factoryInternalUrl, `${s.factory.factoryInternalUrl} vs ${s.platform.factoryInternalUrl}`);
  add("factory + platform agree on the namespace", s.factory.factoryNamespace === s.platform.namespace);
  add("agent exports an internal URL in the shared namespace", isUrl(s.agent.agentInternalUrl) && String(s.agent.agentInternalUrl).includes(`.${s.platform.namespace}.svc`), String(s.agent.agentInternalUrl));
  add("images are pinned by digest", [s.factory.factoryImage, s.agent.agentImage, s.triage.triageImage].every((i) => typeof i === "string" && i.includes("@sha256:")));
  add("triage exports an audit table and a role ARN", nonEmpty(s.triage.auditTable) && String(s.triage.irsaRoleArn).startsWith("arn:aws:iam::"));
  add("kubeconfig is exported as a secret (llm, platform)", s.llm.kubeconfig === SECRET && s.platform.kubeconfig === SECRET);
  return c;
}

/** Flag outputs that look like plaintext credentials. Secret-marked outputs are fine. */
export function checkNoPlaintextSecrets(stacks: Record<string, Outputs>): Check[] {
  const bad: string[] = [];
  const looksSecret = /(AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY|gh[pousr]_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/;
  const nameSecret = /(password|passwd|secret|token|apikey|api_key|private_?key)/i;
  for (const [stack, outs] of Object.entries(stacks)) {
    for (const [k, v] of Object.entries(outs)) {
      if (v === SECRET) continue;
      const text = JSON.stringify(v);
      if (looksSecret.test(text)) bad.push(`${stack}.${k} (credential pattern)`);
      else if (nameSecret.test(k) && typeof v === "string" && v.length > 0) bad.push(`${stack}.${k} (secret-like name exported in plaintext)`);
    }
  }
  return [{ name: "no stack exports a plaintext secret", ok: bad.length === 0, detail: bad.join("; ") }];
}

export interface TaggedResource { arn: string; tags: Record<string, string> }
export function checkOwnerTags(resources: TaggedResource[], owner: string, mustContain: string[]): Check[] {
  const c: Check[] = [];
  for (const needle of mustContain) {
    const r = resources.find((x) => x.arn.includes(needle));
    c.push({ name: `AWS resource "${needle}" carries Owner=${owner}`, ok: r?.tags.Owner === owner, detail: r ? `Owner=${r.tags.Owner}` : "resource not found by tag search" });
  }
  return c;
}

export function summarize(checks: Check[]): { text: string; failed: number } {
  const w = Math.max(...checks.map((c) => c.name.length));
  const lines = checks.map((c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(w)}${c.ok ? "" : `  <- ${c.detail ?? ""}`}`);
  const failed = checks.filter((c) => !c.ok).length;
  return { text: [...lines, "", failed === 0 ? `all ${checks.length} checks passed` : `${failed} of ${checks.length} checks FAILED`].join("\n"), failed };
}
