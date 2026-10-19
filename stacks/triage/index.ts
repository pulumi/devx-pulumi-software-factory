import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as path from "node:path";

const config = new pulumi.Config();
const platformStack = config.require("platformStack");
const llmStack = config.require("llmStack");                       // for the cluster name (IRSA trust)
const owner = config.require("owner");
const jevApiKey = config.requireSecret("jevApiKey");               // pulumi config set --secret jevApiKey
const enabled = config.getBoolean("enabled") ?? true;
const dryRun = config.getBoolean("dryRun") ?? false;
const acceptThreshold = config.getNumber("acceptThreshold") ?? 0.7;
const rejectThreshold = config.getNumber("rejectThreshold") ?? 0.8;
const wipLimit = config.getNumber("wipLimit") ?? 3;
const acceptStage = config.get("acceptStage") ?? "planning";
const intervalSeconds = config.getNumber("intervalSeconds") ?? 30;
const factoryOrigin = config.get("factoryOrigin") ?? "http://localhost:4111";
const jevEndpoint = config.get("jevEndpoint");
const appDir = config.get("appDir") ?? path.join(__dirname, "../../apps/triage");
const region = aws.config.region ?? "us-east-1";
const SA_NAME = "triage";

const platform = new pulumi.StackReference(platformStack);
const llm = new pulumi.StackReference(llmStack);
const namespace = platform.requireOutput("namespace").apply(String);
const kubeconfig = platform.requireOutput("kubeconfig");
const sharedLabels = platform.requireOutput("sharedLabels");
const clusterName = llm.requireOutput("cluster_name").apply(String);
const provider = new k8s.Provider("k8s", { kubeconfig });
const opts = { provider };
const labels = sharedLabels.apply((l) => ({ ...l, "app.kubernetes.io/name": "triage" }));

// --- AWS: audit table + IRSA role limited to that table ---
const table = new aws.dynamodb.Table("triage-decisions", {
    billingMode: "PAY_PER_REQUEST",
    hashKey: "key",
    attributes: [{ name: "key", type: "S" }],
    tags: { Owner: owner },
});

const cluster = aws.eks.getClusterOutput({ name: clusterName });
const issuer = cluster.identities[0].oidcs[0].issuer;                    // https://oidc.eks.<region>.amazonaws.com/id/XXXX
const oidcHost = issuer.apply((u) => u.replace(/^https:\/\//, ""));
const oidc = aws.iam.getOpenIdConnectProviderOutput({ url: issuer });

const role = new aws.iam.Role("triage", {
    tags: { Owner: owner },
    assumeRolePolicy: pulumi.all([oidc.arn, oidcHost, namespace]).apply(([arn, host, ns]) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{
            Effect: "Allow", Action: "sts:AssumeRoleWithWebIdentity", Principal: { Federated: arn },
            Condition: { StringEquals: { [`${host}:sub`]: `system:serviceaccount:${ns}:${SA_NAME}`, [`${host}:aud`]: "sts.amazonaws.com" } },
        }],
    })),
});
new aws.iam.RolePolicy("triage-audit", {
    role: role.id,
    policy: table.arn.apply((arn) => JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: ["dynamodb:GetItem", "dynamodb:PutItem"], Resource: arn }],
    })),
});

// --- Image ---
const repo = new aws.ecr.Repository("triage", { forceDelete: true, tags: { Owner: owner } });
const auth = aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId });
const image = new dockerBuild.Image("triage", {
    context: { location: appDir },
    dockerfile: { location: path.join(appDir, "Dockerfile") },
    platforms: ["linux/amd64"],
    push: true,
    tags: [pulumi.interpolate`${repo.repositoryUrl}:latest`],
    registries: [{ address: repo.repositoryUrl, username: auth.userName, password: auth.password }],
});

// --- In-cluster evaluator ---
const sa = new k8s.core.v1.ServiceAccount("triage", {
    metadata: { name: SA_NAME, namespace, labels, annotations: { "eks.amazonaws.com/role-arn": role.arn } },
}, opts);

const jevSecret = new k8s.core.v1.Secret("jev-api-key", {
    metadata: { name: "jev-api-key", namespace, labels },
    stringData: { JEV_API_KEY: jevApiKey },
}, opts);

new k8s.apps.v1.Deployment("triage", {
    metadata: { name: "triage", namespace, labels },
    spec: {
        replicas: enabled ? 1 : 0,                                          // `enabled=false` switches it off without removing it
        selector: { matchLabels: { "app.kubernetes.io/name": "triage" } },
        template: {
            metadata: { labels },
            spec: {
                serviceAccountName: sa.metadata.name,
                securityContext: { runAsNonRoot: true, runAsUser: 1000 },
                containers: [{
                    name: "triage",
                    image: image.ref,
                    envFrom: [
                        { configMapRef: { name: "platform-config" } },            // FACTORY_INTERNAL_URL
                        { secretRef: { name: "factory-service-account" } },       // FACTORY_USER_EMAIL / PASSWORD
                        { secretRef: { name: jevSecret.metadata.name } },         // JEV_API_KEY
                    ],
                    env: [
                        { name: "FACTORY_ORIGIN", value: factoryOrigin },
                        { name: "LOOP_PROMPT_PATH", value: "/prompt/factory-prompt.md" },
                        { name: "AUDIT_TABLE", value: table.name },
                        { name: "AWS_REGION", value: region },
                        { name: "TRIAGE_DRY_RUN", value: String(dryRun) },
                        { name: "ACCEPT_THRESHOLD", value: String(acceptThreshold) },
                        { name: "REJECT_THRESHOLD", value: String(rejectThreshold) },
                        { name: "WIP_LIMIT", value: String(wipLimit) },
                        { name: "ACCEPT_STAGE", value: acceptStage },
                        { name: "INTERVAL_SECONDS", value: String(intervalSeconds) },
                        ...(jevEndpoint ? [{ name: "JEV_ENDPOINT", value: jevEndpoint }] : []),
                    ],
                    resources: { requests: { cpu: "50m", memory: "128Mi" }, limits: { memory: "512Mi" } },
                    volumeMounts: [{ name: "coding-loop", mountPath: "/prompt", readOnly: true }],
                }],
                volumes: [{ name: "coding-loop", configMap: { name: "coding-loop", optional: true } }],
            },
        },
    },
}, opts);

export const auditTable = table.name;
export const irsaRoleArn = role.arn;
export const triageImage = image.ref;
export const triageEnabled = enabled;
