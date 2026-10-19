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
                        namespace: "agent-platform",
                        kubeconfig: "{}",
                        sharedLabels: { "app.kubernetes.io/part-of": "agent-factory" },
                    }, secretOutputNames: ["kubeconfig"] } };
                case "aws:ecr/repository:Repository":
                    return { id: args.name, state: { ...args.inputs, registryId: "123456789012", repositoryUrl: "123456789012.dkr.ecr.us-east-1.amazonaws.com/factory" } };
                case "docker-build:index:Image":
                    return { id: args.name, state: { ...args.inputs, ref: "123456789012.dkr.ecr.us-east-1.amazonaws.com/factory@sha256:deadbeef" } };
                case "random:index/randomPassword:RandomPassword":
                    return { id: args.name, state: { ...args.inputs, result: "pw-generated-123" } };
                case "random:index/randomBytes:RandomBytes":
                    return { id: args.name, state: { ...args.inputs, base64: "a2V5LWdlbmVyYXRlZC0zMi1ieXRlcy1sb25nLWtleSE=" } };
            }
            return { id: `${args.name}-id`, state: args.inputs };
        },
        call(args) {
            if (args.token === "aws:ecr/getAuthorizationToken:getAuthorizationToken") {
                return { userName: "AWS", password: "token", proxyEndpoint: "https://123456789012.dkr.ecr.us-east-1.amazonaws.com" };
            }
            return args.inputs;
        },
    }, "factory", "test", false);
    pulumi.runtime.setAllConfig({ "factory:platformStack": "my-org/platform/dev", "factory:owner": "you@example.com",
        "factory:githubAppId": "12345", "factory:githubAppPrivateKey": "fake-key" }, ["factory:githubAppPrivateKey"]);
    infra = await import("../index");
    for (let i = 0; i < 120 && resources.length < 17; i++) await new Promise((r) => setTimeout(r, 50));
});

const of = (t: string) => resources.filter((r) => r.type === t);
const val = (o: any): Promise<any> => new Promise((res) => pulumi.output(o).apply((v) => { res(v); return v; }));

describe("factory stack", () => {
    it("ECR repo is Owner-tagged and force-deletable", () => {
        const r = of("aws:ecr/repository:Repository")[0];
        expect(r.inputs.tags.Owner).toBe("you@example.com");
        expect(r.inputs.forceDelete).toBe(true);
    });
    it("builds a linux/amd64 image and pushes it", () => {
        const i = of("docker-build:index:Image")[0];
        expect(i.inputs.platforms).toEqual(["linux/amd64"]);
        expect(i.inputs.push).toBe(true);
        expect(i.inputs.context.location).toMatch(/apps\/factory$/);
    });
    it("Service is named 'factory' on 4111 (platform contract)", async () => {
        const s = of("kubernetes:core/v1:Service").find((x) => x.name === "factory")!;
        expect(s.inputs.metadata.name).toBe("factory");
        expect(s.inputs.spec.ports[0].port).toBe(4111);
        expect(await val(infra.factoryInternalUrl)).toBe("http://factory.agent-platform.svc.cluster.local:4111");
    });
    it("DB password and encryption key are generated, not configured", () => {
        expect(of("random:index/randomPassword:RandomPassword").length).toBe(2);
        expect(of("random:index/randomBytes:RandomBytes").length).toBe(2);   // credential key + better-auth secret
        const sec = of("kubernetes:core/v1:Secret").find((x) => x.name === "factory-env")!;
        expect(JSON.stringify(sec.inputs.stringData)).toContain("postgres://factory:pw-generated-123@factory-db.agent-platform");
        const sd = sec.inputs.stringData.value ?? sec.inputs.stringData;
        expect(Object.keys(sd)).toEqual(expect.arrayContaining(["DATABASE_URL", "FACTORY_CREDENTIAL_ENCRYPTION_KEY", "BETTER_AUTH_SECRET"]));
    });
    it("runs as non-root, Recreate strategy, deploys by image digest", async () => {
        const d = of("kubernetes:apps/v1:Deployment")[0];
        expect(d.inputs.spec.strategy.type).toBe("Recreate");
        expect(d.inputs.spec.template.spec.securityContext.runAsNonRoot).toBe(true);
        expect(d.inputs.spec.template.spec.containers[0].image).toContain("@sha256:");
    });
    it("local sandbox; real auth enabled; Service stays internal", () => {
        const env = Object.fromEntries(of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec.containers[0].env.map((e: any) => [e.name, e.value]));
        expect(env.FACTORY_SANDBOX_PROVIDER).toBe("local");
        expect(env.MASTRACODE_AUTH_DISABLED).toBeUndefined();   // real (better-auth) auth is on: the HTTP API needs a tenant
        expect(env.FACTORY_SIGNUP_ENABLED).toBe("1");
        const svc = of("kubernetes:core/v1:Service").find((x) => x.name === "factory")!;
        expect(svc.inputs.spec.type).toBeUndefined();   // ClusterIP default, never LoadBalancer
    });
    it("passes the optional GitHub App config to Factory as GITHUB_APP_* (key stays secret)", () => {
        const sec = of("kubernetes:core/v1:Secret").find((x) => x.name === "factory-env")!;
        const sd = sec.inputs.stringData.value ?? sec.inputs.stringData;
        expect(sd.GITHUB_APP_ID).toBe("12345");
        expect(Object.keys(sd)).toContain("GITHUB_APP_PRIVATE_KEY");
        expect(Object.keys(sd)).not.toContain("GITHUB_APP_SLUG");   // unset config is omitted, not blank
    });
    it("probes the real /health route", () => {
        const c = of("kubernetes:apps/v1:Deployment")[0].inputs.spec.template.spec.containers[0];
        expect(c.readinessProbe.httpGet.path).toBe("/health");
        expect(c.livenessProbe.httpGet.path).toBe("/health");
    });
    it("Postgres uses the pgvector image with a PVC", () => {
        const ss = of("kubernetes:apps/v1:StatefulSet")[0];
        expect(ss.inputs.spec.template.spec.containers[0].image).toMatch(/^pgvector\/pgvector/);
        expect(ss.inputs.spec.volumeClaimTemplates[0].spec.resources.requests.storage).toBe("10Gi");
    });
    it("provisions a generated service-account Secret for API callers", () => {
        const s = of("kubernetes:core/v1:Secret").find((x) => x.name === "factory-service-account")!;
        const sd = s.inputs.stringData.value ?? s.inputs.stringData;
        expect(sd.FACTORY_USER_EMAIL).toBe("agent-svc@agent-factory.local");
        expect(sd.FACTORY_USER_PASSWORD).toBe("pw-generated-123");
        expect(of("random:index/randomPassword:RandomPassword").length).toBe(2);   // db + service account
    });
    it("exports image, namespace, internal and public URLs", async () => {
        for (const k of ["factoryInternalUrl", "factoryPublicUrl", "factoryImage", "factoryNamespace"]) expect(Object.keys(infra)).toContain(k);
        expect(await val(infra.factoryNamespace)).toBe("agent-platform");
    });
});
