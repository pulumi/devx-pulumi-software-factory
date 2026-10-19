import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as path from "node:path";

const config = new pulumi.Config();
const platformStack = config.require("platformStack");
const owner = config.require("owner");
const port = config.getNumber("port") ?? 8080;
const factoryOrigin = config.get("factoryOrigin") ?? "http://localhost:4111";   // must equal the Factory MASTRACODE_PUBLIC_URL
const appDir = config.get("appDir") ?? path.join(__dirname, "../../apps/agent");
const promptMount = "/prompt";

const platform = new pulumi.StackReference(platformStack);
const namespace = platform.requireOutput("namespace").apply(String);
const kubeconfig = platform.requireOutput("kubeconfig");
const sharedLabels = platform.requireOutput("sharedLabels");
const factoryInternalUrl = platform.requireOutput("factoryInternalUrl");
const provider = new k8s.Provider("k8s", { kubeconfig });
const opts = { provider };
const labels = sharedLabels.apply((l) => ({ ...l, "app.kubernetes.io/name": "agent" }));

const repo = new aws.ecr.Repository("agent", { forceDelete: true, tags: { Owner: owner } });
const auth = aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId });
const image = new dockerBuild.Image("agent", {
    context: { location: appDir },
    dockerfile: { location: path.join(appDir, "Dockerfile") },
    platforms: ["linux/amd64"],
    push: true,
    tags: [pulumi.interpolate`${repo.repositoryUrl}:latest`],
    registries: [{ address: repo.repositoryUrl, username: auth.userName, password: auth.password }],
});

// Least privilege: own ServiceAccount, no API token mounted (the agent never talks to the Kubernetes API).
const sa = new k8s.core.v1.ServiceAccount("agent", {
    metadata: { name: "agent", namespace, labels },
    automountServiceAccountToken: false,
}, opts);

const deployment = new k8s.apps.v1.Deployment("agent", {
    metadata: { name: "agent", namespace, labels },
    spec: {
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "agent" } },
        template: {
            metadata: { labels },
            spec: {
                serviceAccountName: sa.metadata.name,
                automountServiceAccountToken: false,
                securityContext: { runAsNonRoot: true, runAsUser: 1000 },
                containers: [{
                    name: "agent",
                    image: image.ref,
                    ports: [{ containerPort: port, name: "http" }],
                    envFrom: [
                        { configMapRef: { name: "platform-config" } },                  // LLM_BASE_URL, LLM_MODEL, FACTORY_INTERNAL_URL
                        { secretRef: { name: "factory-service-account" } },             // FACTORY_USER_EMAIL / FACTORY_USER_PASSWORD (from the factory stack)
                    ],
                    env: [
                        { name: "PORT", value: String(port) },
                        { name: "FACTORY_ORIGIN", value: factoryOrigin },
                        { name: "LOOP_PROMPT_PATH", value: `${promptMount}/factory-prompt.md` },
                    ],
                    readinessProbe: { httpGet: { path: "/healthz", port: "http" }, periodSeconds: 10 },
                    livenessProbe: { httpGet: { path: "/healthz", port: "http" }, initialDelaySeconds: 20, periodSeconds: 20 },
                    resources: { requests: { cpu: "100m", memory: "256Mi" }, limits: { memory: "1Gi" } },
                    volumeMounts: [{ name: "coding-loop", mountPath: promptMount, readOnly: true }],
                }],
                // ConfigMap `coding-loop` is created/updated by scripts/bootstrap.ts, so it is optional here.
                volumes: [{ name: "coding-loop", configMap: { name: "coding-loop", optional: true } }],
            },
        },
    },
}, opts);

new k8s.core.v1.Service("agent", {
    metadata: { name: "agent", namespace, labels },
    spec: { selector: { "app.kubernetes.io/name": "agent" }, ports: [{ name: "http", port, targetPort: "http" }] },
}, { ...opts, dependsOn: [deployment] });

export const agentInternalUrl = pulumi.interpolate`http://agent.${namespace}.svc.cluster.local:${port}`;
export const agentImage = image.ref;
export const factoryUrlSeenByAgent = factoryInternalUrl;
