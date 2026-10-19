import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

type Res = { type: string; name: string; inputs: any };
const resources: Res[] = [];
let infra: typeof import("../index");

beforeAll(async () => {
    await pulumi.runtime.setMocks({
        newResource(args) {
            resources.push({ type: args.type, name: args.name, inputs: args.inputs });
            switch (args.type) {
                case "pulumi:pulumi:StackReference":
                    return { id: args.name, state: { name: args.inputs.name, outputs: {
                        namespace: "agent-platform", kubeconfig: "{}",
                        sharedLabels: { "app.kubernetes.io/part-of": "agent-factory" },
                        factoryInternalUrl: "http://factory.agent-platform.svc.cluster.local:4111",
                    }, secretOutputNames: ["kubeconfig"] } };
                case "aws:ecr/repository:Repository":
                    return { id: args.name, state: { ...args.inputs, registryId: "123456789012", repositoryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent" } };
                case "docker-build:index:Image":
                    return { id: args.name, state: { ...args.inputs, ref: "123456789012.dkr.ecr.us-east-1.amazonaws.com/agent@sha256:deadbeef" } };
            }
            return { id: `${args.name}-id`, state: args.inputs };
        },
        call(args) {
            if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken") return { userName: "AWS", password: "token", proxyEndpoint: "x" };
            return args.inputs;
        },
    }, "agent", "test", false);
    pulumi.runtime.setAllConfig({ "agent:platformStack": "my-org/platform/dev", "agent:owner": "you@example.com" });
    infra = await import("../index");
    for (let i = 0; i < 120 && resources.length < 7; i++) await new Promise((r) => setTimeout(r, 50));
});

const of = (t: string) => resources.filter((r) => r.type === t);
const val = (o: any): Promise<any> => new Promise((res) => pulumi.output(o).apply((v) => { res(v); return v; }));

describe("agent stack", () => {
    it("ECR repo is Owner-tagged; image is linux/amd64", () => {
        expect(of("aws:ecr/repository:Repository")[0].inputs.tags.Owner).toBe("you@example.com");
        expect(of("docker-build:index:Image")[0].inputs.platforms).toEqual(["linux/amd64"]);
    });
    it("least privilege: own ServiceAccount, no API token, non-root", () => {
        const sa = of("kubernetes:core/v1:ServiceAccount")[0];
        expect(sa.inputs.automountServiceAccountToken).toBe(false);
        const pod = of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec;
        expect(pod.automountServiceAccountToken).toBe(false);
        expect(pod.securityContext.runAsNonRoot).toBe(true);
    });
    it("takes LLM config from the shared platform-config ConfigMap", () => {
        const c = of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec.containers[0];
        expect(c.envFrom).toEqual([{ configMapRef: { name: "platform-config" } }, { secretRef: { name: "factory-service-account" } }]);
        expect(c.image).toContain("@sha256:");
        expect(c.readinessProbe.httpGet.path).toBe("/healthz");
    });
    it("mounts the optional coding-loop ConfigMap at the prompt path", () => {
        const spec = of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec;
        expect(spec.volumes[0].configMap).toEqual({ name: "coding-loop", optional: true });
        const env = Object.fromEntries(spec.containers[0].env.map((e: any) => [e.name, e.value]));
        expect(env.LOOP_PROMPT_PATH).toBe("/prompt/factory-prompt.md");
    });
    it("exports agentInternalUrl and agentImage", async () => {
        expect(await val(infra.agentInternalUrl)).toBe("http://agent.agent-platform.svc.cluster.local:8080");
        expect(Object.keys(infra)).toContain("agentImage");
    });
});
