import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Res = { type: string; name: string; inputs: any };
const resources: Res[] = [];
const FAKE_KUBECONFIG = JSON.stringify({ apiVersion: "v1", kind: "Config" });

let infra: typeof import("../index");

beforeAll(async () => {
    await pulumi.runtime.setMocks({
        newResource(args) {
            resources.push({ type: args.type, name: args.name, inputs: args.inputs });
            if (args.type === "pulumi:pulumi:StackReference") {
                return { id: args.name, state: { name: args.inputs.name, outputs: {
                    kubeconfig: FAKE_KUBECONFIG,
                    llm_openai_base_url: "http://chat-llm-frontend.dynamo-system.svc.cluster.local:8000/v1",
                    llm_model: "Qwen/Qwen2.5-Coder-7B-Instruct",
                }, secretOutputNames: ["kubeconfig"] } };
            }
            return { id: `${args.name}-id`, state: args.inputs };
        },
        call: (args) => args.inputs,
    }, "platform", "test", false);
    pulumi.runtime.setAllConfig({
        "platform:llmStack": "my-org/llm/dev",
        "platform:owner": "you@example.com",
        "platform:githubToken": "gh-secret-value",
        "platform:projectBrief": "Build a simple messenger.\n",
    }, ["platform:githubToken"]);
    infra = await import("../index");
    // resource registration is async: wait for all 12 (stackref, provider, ns, 3 policies, 2 configmaps, secret, quota, limits)
    for (let i = 0; i < 100 && resources.length < 12; i++) await new Promise((r) => setTimeout(r, 50));
});

const of = (t: string) => resources.filter((r) => r.type === t);
const val = (o: any): Promise<any> => new Promise((res) => pulumi.output(o).apply((v) => { res(v); return v; }));
const isSecret = (o: any): Promise<boolean> => (pulumi.output(o) as any).isSecret;

describe("platform stack", () => {
    it("publishes the project brief from config as the coding-loop ConfigMap", () => {
        const cm = of("kubernetes:core/v1:ConfigMap").find((r) => r.name === "coding-loop")!;
        expect(cm.inputs.metadata.name).toBe("coding-loop");
        expect(cm.inputs.data["factory-prompt.md"]).toBe("Build a simple messenger.\n");
    });
    it("creates the agent-platform namespace with shared labels", () => {
        const ns = of("kubernetes:core/v1:Namespace")[0];
        expect(ns.inputs.metadata.name).toBe("agent-platform");
        expect(ns.inputs.metadata.labels["app.kubernetes.io/part-of"]).toBe("agent-factory");
    });
    it("denies ingress by default and only allows same-namespace", () => {
        const names = of("kubernetes:networking.k8s.io/v1:NetworkPolicy").map((r) => r.name);
        expect(names).toEqual(expect.arrayContaining(["default-deny-ingress", "allow-same-namespace", "restrict-egress"]));
        const deny = of("kubernetes:networking.k8s.io/v1:NetworkPolicy").find((r) => r.name === "default-deny-ingress")!;
        expect(deny.inputs.spec.policyTypes).toEqual(["Ingress"]);
        expect(deny.inputs.spec.ingress).toBeUndefined();
    });
    it("egress allows DNS, the LLM frontend on 8000 and 443 only", () => {
        const eg = of("kubernetes:networking.k8s.io/v1:NetworkPolicy").find((r) => r.name === "restrict-egress")!;
        const ports = eg.inputs.spec.egress.flatMap((e: any) => (e.ports ?? []).map((p: any) => `${p.protocol}/${p.port}`));
        expect(ports).toEqual(expect.arrayContaining(["UDP/53", "TCP/8000", "TCP/443"]));
        expect(ports).not.toContain("TCP/80");
    });
    it("shared ConfigMap carries LLM and Factory settings", async () => {
        const cm = of("kubernetes:core/v1:ConfigMap").find((r) => r.name === "platform-config")!;
        const data = await val(cm.inputs.data);
        expect(data.LLM_BASE_URL).toMatch(/\/v1$/);
        expect(data.LLM_MODEL).toBe("Qwen/Qwen2.5-Coder-7B-Instruct");
        expect(data.FACTORY_INTERNAL_URL).toBe("http://factory.agent-platform.svc.cluster.local:4111");
    });
    it("only creates secrets that are configured, and keeps them secret", async () => {
        const secrets = of("kubernetes:core/v1:Secret");
        expect(secrets.map((s) => s.name)).toEqual(["github-token"]);
        expect(await val(infra.secretNames)).toEqual(["github-token"]);
        expect(JSON.stringify(secrets[0].inputs.stringData)).toContain("gh-secret-value");
        // mocks strip secret markers from inputs, so assert the program only ever reads these via getSecret
        const src = readFileSync(join(__dirname, "../index.ts"), "utf8");
        expect(src).toContain("config.getSecret(cfgKey)");
        expect(src).not.toMatch(/config\.get\(\s*["'](githubToken|jevApiKey)/);
    });
    it("exports every field in the contract", async () => {
        for (const k of ["namespace", "kubeconfig", "llmBaseUrl", "llmModel", "factoryInternalUrl", "sharedLabels", "owner", "configMapName", "secretNames"]) {
            expect(Object.keys(infra)).toContain(k);
        }
        expect(await val(infra.namespace)).toBe("agent-platform");
        expect(await val(infra.owner)).toBe("you@example.com");
    });
    it("kubeconfig export is a secret", async () => {
        expect(await isSecret(infra.kubeconfig)).toBe(true);
    });
});
