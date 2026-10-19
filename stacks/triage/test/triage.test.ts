import { describe, it, expect, beforeAll } from "vitest";
import * as pulumi from "@pulumi/pulumi";

type Res = { type: string; name: string; inputs: any };
const resources: Res[] = [];
let infra: typeof import("../index");
const TABLE_ARN = "arn:aws:dynamodb:us-east-1:123456789012:table/triage-decisions-abc";
const OIDC_ARN = "arn:aws:iam::123456789012:oidc-provider/oidc.eks.us-east-1.amazonaws.com/id/ABC123";

beforeAll(async () => {
    await pulumi.runtime.setMocks({
        newResource(args) {
            resources.push({ type: args.type, name: args.name, inputs: args.inputs });
            switch (args.type) {
                case "pulumi:pulumi:StackReference": {
                    const out: any = args.inputs.name.includes("/llm/") ? { cluster_name: "agent-factory-eksCluster-xyz" }
                        : { namespace: "agent-platform", kubeconfig: "{}", sharedLabels: { "app.kubernetes.io/part-of": "agent-factory" } };
                    return { id: args.name, state: { name: args.inputs.name, outputs: out, secretOutputNames: ["kubeconfig"] } };
                }
                case "aws:dynamodb/table:Table": return { id: "triage-decisions-abc", state: { ...args.inputs, name: "triage-decisions-abc", arn: TABLE_ARN } };
                case "aws:iam/role:Role": return { id: "triage-role", state: { ...args.inputs, arn: "arn:aws:iam::123456789012:role/triage-role" } };
                case "aws:ecr/repository:Repository": return { id: args.name, state: { ...args.inputs, registryId: "123456789012", repositoryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/triage" } };
                case "docker-build:index:Image": return { id: args.name, state: { ...args.inputs, ref: "123456789012.dkr.ecr.us-east-1.amazonaws.com/triage@sha256:deadbeef" } };
            }
            return { id: `${args.name}-id`, state: args.inputs };
        },
        call(args) {
            if (args.token === "aws:eks/getCluster:getCluster") return { identities: [{ oidcs: [{ issuer: "https://oidc.eks.us-east-1.amazonaws.com/id/ABC123" }] }] };
            if (args.token === "aws:iam/getOpenIdConnectProvider:getOpenIdConnectProvider") return { arn: OIDC_ARN };
            if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken") return { userName: "AWS", password: "t", proxyEndpoint: "x" };
            return args.inputs;
        },
    }, "triage", "test", false);
    pulumi.runtime.setAllConfig({ "triage:platformStack": "my-org/platform/dev", "triage:llmStack": "my-org/llm/dev", "triage:owner": "you@example.com", "triage:jevApiKey": "jev-secret-value" }, ["triage:jevApiKey"]);
    infra = await import("../index");
    for (let i = 0; i < 160 && resources.length < 13; i++) await new Promise((r) => setTimeout(r, 50));
});

const of = (t: string) => resources.filter((r) => r.type === t);
const val = (o: any): Promise<any> => new Promise((res) => pulumi.output(o).apply((v) => { res(v); return v; }));

describe("triage stack", () => {
    it("audit table is keyed on `key`, on-demand, Owner-tagged", () => {
        const t = of("aws:dynamodb/table:Table")[0].inputs;
        expect(t.hashKey).toBe("key"); expect(t.billingMode).toBe("PAY_PER_REQUEST"); expect(t.tags.Owner).toBe("you@example.com");
    });
    it("IAM policy is least privilege: Get/Put on the one table only", async () => {
        const p = JSON.parse(await val(of("aws:iam/rolePolicy:RolePolicy")[0].inputs.policy));
        expect(p.Statement).toHaveLength(1);
        expect(p.Statement[0].Action.sort()).toEqual(["dynamodb:GetItem", "dynamodb:PutItem"]);
        expect(p.Statement[0].Resource).toBe(TABLE_ARN);
    });
    it("IRSA trust is bound to exactly agent-platform:triage and the sts audience", async () => {
        const trust = JSON.parse(await val(of("aws:iam/role:Role")[0].inputs.assumeRolePolicy));
        const st = trust.Statement[0];
        expect(st.Principal.Federated).toBe(OIDC_ARN); expect(st.Action).toBe("sts:AssumeRoleWithWebIdentity");
        expect(st.Condition.StringEquals["oidc.eks.us-east-1.amazonaws.com/id/ABC123:sub"]).toBe("system:serviceaccount:agent-platform:triage");
        expect(st.Condition.StringEquals["oidc.eks.us-east-1.amazonaws.com/id/ABC123:aud"]).toBe("sts.amazonaws.com");
    });
    it("ServiceAccount carries the role annotation", async () => {
        const sa = of("kubernetes:core/v1:ServiceAccount")[0].inputs;
        expect(await val(sa.metadata.annotations["eks.amazonaws.com/role-arn"])).toBe("arn:aws:iam::123456789012:role/triage-role");
    });
    it("Jev key lives in a Secret, not in the Deployment spec", () => {
        const s = of("kubernetes:core/v1:Secret")[0];
        expect(s.name).toBe("jev-api-key");
        const dep = JSON.stringify(of("kubernetes:apps/v1:Deployment")[0].inputs);
        expect(dep).not.toContain("jev-secret-value");
        expect(of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec.containers[0].envFrom).toEqual(expect.arrayContaining([{ secretRef: { name: "factory-service-account" } }]));
    });
    it("evaluator config: evidence-based thresholds, audit table, non-root, 1 replica when enabled", () => {
        const spec = of("kubernetes:apps/v1:Deployment")[0].inputs.spec;
        expect(spec.replicas).toBe(1);
        expect(spec.template.spec.securityContext.runAsNonRoot).toBe(true);
        const env = Object.fromEntries(spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]));
        expect(env.ACCEPT_THRESHOLD).toBe("0.7"); expect(env.REJECT_THRESHOLD).toBe("0.8");
        expect(env.TRIAGE_DRY_RUN).toBe("false"); expect(env.ACCEPT_STAGE).toBe("planning");
    });
    it("image is linux/amd64 in an Owner-tagged force-deletable ECR repo", () => {
        expect(of("docker-build:index:Image")[0].inputs.platforms).toEqual(["linux/amd64"]);
        const r = of("aws:ecr/repository:Repository")[0].inputs;
        expect(r.tags.Owner).toBe("you@example.com"); expect(r.forceDelete).toBe(true);
    });
    it("exports the audit table, role and image", async () => {
        for (const k of ["auditTable", "irsaRoleArn", "triageImage", "triageEnabled"]) expect(Object.keys(infra)).toContain(k);
        expect(await val(infra.auditTable)).toBe("triage-decisions-abc");
    });
});
