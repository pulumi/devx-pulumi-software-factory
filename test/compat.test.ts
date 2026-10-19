import { describe, it, expect } from "vitest";
import { checkContracts, checkNoPlaintextSecrets, checkOwnerTags, summarize, type Stacks } from "../scripts/lib/compat";

const good = (): Stacks => ({
  llm: { llm_openai_base_url: "http://llm.dynamo-system.svc:8000/v1", llm_model: "Qwen/Qwen3-8B", cluster_name: "agent-factory-x", kubeconfig: "[secret]" },
  platform: { namespace: "agent-platform", kubeconfig: "[secret]", llmBaseUrl: "http://llm.dynamo-system.svc:8000/v1", llmModel: "Qwen/Qwen3-8B",
              factoryInternalUrl: "http://factory.agent-platform.svc.cluster.local:4111", sharedLabels: {}, owner: "o", configMapName: "platform-config", secretNames: [] },
  factory: { factoryInternalUrl: "http://factory.agent-platform.svc.cluster.local:4111", factoryNamespace: "agent-platform", factoryImage: "r/f@sha256:aa" },
  agent: { agentInternalUrl: "http://agent.agent-platform.svc.cluster.local:8080", agentImage: "r/a@sha256:bb" },
  triage: { auditTable: "triage-decisions-1", irsaRoleArn: "arn:aws:iam::123:role/x", triageImage: "r/t@sha256:cc" },
});
const failing = (s: Stacks) => checkContracts(s).filter((c) => !c.ok).map((c) => c.name);

describe("compat checks", () => {
  it("a consistent stack set passes every contract check", () => expect(failing(good())).toEqual([]));
  it("detects model drift between llm and platform", () => {
    const s = good(); s.platform.llmModel = "Qwen/Qwen2.5-Coder-7B-Instruct";
    expect(failing(s)).toEqual(["platform.llmModel == llm.llm_model (no drift)"]);
  });
  it("detects a URL mismatch, a wrong namespace and a missing contract field", () => {
    const s = good(); s.factory.factoryInternalUrl = "http://factory.other.svc:4111"; s.agent.agentInternalUrl = "http://agent.other.svc:8080"; delete (s.platform as any).secretNames;
    const f = failing(s);
    expect(f).toContain("factory.factoryInternalUrl == platform.factoryInternalUrl"); expect(f).toContain("platform exports every contract field");
    expect(f).toContain("agent exports an internal URL in the shared namespace");
  });
  it("requires digest-pinned images and secret-marked kubeconfigs", () => {
    const s = good(); s.agent.agentImage = "r/a:latest"; s.llm.kubeconfig = "apiVersion: v1";
    expect(failing(s)).toEqual(expect.arrayContaining(["images are pinned by digest", "kubeconfig is exported as a secret (llm, platform)"]));
  });
  it("flags plaintext credentials but not secret-marked outputs", () => {
    expect(checkNoPlaintextSecrets({ a: { kubeconfig: "[secret]", dbPassword: "[secret]" } })[0].ok).toBe(true);
    const r = checkNoPlaintextSecrets({ a: { adminPassword: "hunter2", note: ["AKI", "AABCDEFGHIJKLMNOP"].join("")   /* built at runtime so no credential-shaped literal lives in the repo */ } })[0];
    expect(r.ok).toBe(false); expect(r.detail).toContain("a.adminPassword"); expect(r.detail).toContain("a.note");
  });
  it("owner-tag check reports missing and mis-tagged resources", () => {
    const res = [{ arn: "arn:aws:eks:us-east-1:1:cluster/c1", tags: { Owner: "me" } }, { arn: "arn:aws:ecr:us-east-1:1:repository/factory-1", tags: { Owner: "someone-else" } }];
    const out = checkOwnerTags(res, "me", ["cluster/c1", "repository/factory", "repository/agent"]);
    expect(out.map((c) => c.ok)).toEqual([true, false, false]);
  });
  it("summarize counts failures", () => {
    const s = summarize([{ name: "a", ok: true }, { name: "b", ok: false, detail: "why" }]);
    expect(s.failed).toBe(1); expect(s.text).toContain("FAIL  b"); expect(s.text).toContain("1 of 2 checks FAILED");
  });
});
