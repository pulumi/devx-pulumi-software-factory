import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";
import * as aws from "@pulumi/aws";
import * as dockerBuild from "@pulumi/docker-build";
import * as random from "@pulumi/random";
import * as path from "node:path";

const config = new pulumi.Config();
const platformStack = config.require("platformStack");        // e.g. my-org/platform/dev
const owner = config.require("owner");
const port = config.getNumber("port") ?? 4111;
const storageClass = config.get("storageClass");               // default: cluster default
const workspaceSize = config.get("workspaceSize") ?? "20Gi";
const dbSize = config.get("dbSize") ?? "10Gi";
const signUpEnabled = config.getBoolean("signUpEnabled") ?? true;
const appDir = config.get("appDir") ?? path.join(__dirname, "../../apps/factory");

const platform = new pulumi.StackReference(platformStack);
const namespace = platform.requireOutput("namespace").apply(String);
const kubeconfig = platform.requireOutput("kubeconfig");
const sharedLabels = platform.requireOutput("sharedLabels");
const provider = new k8s.Provider("k8s", { kubeconfig });
const opts = { provider };
const labels = (app: string) => sharedLabels.apply((l) => ({ ...l, "app.kubernetes.io/name": app }));

// --- Image: ECR repo (does not inherit default tags, so stamp Owner) + build ---
const repo = new aws.ecr.Repository("factory", {
    forceDelete: true,
    tags: { Owner: owner },
});
const auth = aws.ecr.getAuthorizationTokenOutput({ registryId: repo.registryId });
const image = new dockerBuild.Image("factory", {
    context: { location: appDir },
    dockerfile: { location: path.join(appDir, "Dockerfile") },
    platforms: ["linux/amd64"],
    push: true,
    tags: [pulumi.interpolate`${repo.repositoryUrl}:latest`],
    registries: [{ address: repo.repositoryUrl, username: auth.userName, password: auth.password }],
});

// --- Secrets: DB password and credential-encryption key are generated, never hand-written ---
const dbPassword = new random.RandomPassword("db-password", { length: 32, special: false });
const encKey = new random.RandomBytes("credential-key", { length: 32 });
const authSecret = new random.RandomBytes("better-auth-secret", { length: 48 });
const servicePassword = new random.RandomPassword("service-password", { length: 28, special: false });

const dbSecret = new k8s.core.v1.Secret("factory-db", {
    metadata: { name: "factory-db", namespace, labels: labels("factory-db") },
    stringData: { POSTGRES_PASSWORD: dbPassword.result },
}, opts);

// --- Postgres + pgvector (Factory requires pgvector) ---
const dbService = new k8s.core.v1.Service("factory-db", {
    metadata: { name: "factory-db", namespace, labels: labels("factory-db") },
    spec: { selector: { "app.kubernetes.io/name": "factory-db" }, ports: [{ port: 5432, name: "pg" }], clusterIP: "None" },
}, opts);

new k8s.apps.v1.StatefulSet("factory-db", {
    metadata: { name: "factory-db", namespace, labels: labels("factory-db") },
    spec: {
        serviceName: dbService.metadata.name,
        replicas: 1,
        selector: { matchLabels: { "app.kubernetes.io/name": "factory-db" } },
        template: {
            metadata: { labels: labels("factory-db") },
            spec: {
                containers: [{
                    name: "postgres",
                    image: "pgvector/pgvector:pg16",
                    ports: [{ containerPort: 5432, name: "pg" }],
                    env: [
                        { name: "POSTGRES_DB", value: "factory" },
                        { name: "POSTGRES_USER", value: "factory" },
                        { name: "POSTGRES_PASSWORD", valueFrom: { secretKeyRef: { name: "factory-db", key: "POSTGRES_PASSWORD" } } },
                        { name: "PGDATA", value: "/var/lib/postgresql/data/pgdata" },
                    ],
                    readinessProbe: { exec: { command: ["pg_isready", "-U", "factory", "-d", "factory"] }, periodSeconds: 5 },
                    resources: { requests: { cpu: "250m", memory: "512Mi" } },
                    volumeMounts: [{ name: "data", mountPath: "/var/lib/postgresql/data" }],
                }],
            },
        },
        volumeClaimTemplates: [{
            metadata: { name: "data" },
            spec: { accessModes: ["ReadWriteOnce"], ...(storageClass ? { storageClassName: storageClass } : {}),
                    resources: { requests: { storage: dbSize } } },
        }],
    },
}, { ...opts, dependsOn: [dbSecret] });

// --- Factory app ---
// Optional GitHub App for intake (written by tools/github-app/github-app.ts secrets). Absent config means no GitHub integration.
const githubApp: Record<string, pulumi.Input<string>> = {};
for (const [env, key] of [["GITHUB_APP_ID", "githubAppId"], ["GITHUB_APP_SLUG", "githubAppSlug"], ["GITHUB_APP_CLIENT_ID", "githubAppClientId"],
    ["GITHUB_APP_CLIENT_SECRET", "githubAppClientSecret"], ["GITHUB_APP_WEBHOOK_SECRET", "githubAppWebhookSecret"],
    ["GITHUB_APP_PRIVATE_KEY", "githubAppPrivateKey"]] as const) {
    const v = config.getSecret(key);
    if (v) githubApp[env] = v;
}
const databaseUrl = pulumi.interpolate`postgres://factory:${dbPassword.result}@factory-db.${namespace}.svc.cluster.local:5432/factory`;
const envSecret = new k8s.core.v1.Secret("factory-env", {
    metadata: { name: "factory-env", namespace, labels: labels("factory") },
    stringData: {
        DATABASE_URL: databaseUrl,
        FACTORY_CREDENTIAL_ENCRYPTION_KEY: encKey.base64,
        FACTORY_CREDENTIAL_ENCRYPTION_KEY_ID: "k1",
        BETTER_AUTH_SECRET: authSecret.base64,   // self-hosted open-source auth (better-auth) on the Factory Postgres
        ...githubApp,
    },
}, opts);

// Service account used by the agent (and later triage) to call the Factory API as a bearer-token user.
// The account itself is created in Factory by scripts/bootstrap-user.sh (better-auth sign-up).
new k8s.core.v1.Secret("factory-service-account", {
    metadata: { name: "factory-service-account", namespace, labels: labels("factory") },
    stringData: { FACTORY_USER_EMAIL: "agent-svc@agent-factory.local", FACTORY_USER_PASSWORD: servicePassword.result },
}, opts);

const workspaces = new k8s.core.v1.PersistentVolumeClaim("factory-workspaces", {
    metadata: { name: "factory-workspaces", namespace, labels: labels("factory") },
    spec: { accessModes: ["ReadWriteOnce"], ...(storageClass ? { storageClassName: storageClass } : {}),
            resources: { requests: { storage: workspaceSize } } },
}, opts);

const publicUrl = config.get("publicUrl") ?? `http://localhost:${port}`;   // browser origin (port-forward by default)

const deployment = new k8s.apps.v1.Deployment("factory", {
    metadata: { name: "factory", namespace, labels: labels("factory") },
    spec: {
        replicas: 1,
        strategy: { type: "Recreate" },                                   // RWO workspace volume
        selector: { matchLabels: { "app.kubernetes.io/name": "factory" } },
        template: {
            metadata: { labels: labels("factory") },
            spec: {
                securityContext: { runAsNonRoot: true, runAsUser: 1000, fsGroup: 1000 },
                containers: [{
                    name: "factory",
                    image: image.ref,                                     // by digest so rebuilds roll out
                    ports: [{ containerPort: port, name: "http" }],
                    envFrom: [{ secretRef: { name: "factory-env" } }, { configMapRef: { name: "platform-config" } }],
                    env: [
                        { name: "PORT", value: String(port) },
                        { name: "FACTORY_SANDBOX_PROVIDER", value: "local" },
                        { name: "MASTRACODE_LOCAL_SANDBOX_ROOT", value: "/workspaces" },
                        { name: "MASTRACODE_PUBLIC_URL", value: publicUrl },
                        // Public sign-up stays on for bootstrapping; set factory:signUpEnabled=false afterwards.
                        { name: "FACTORY_SIGNUP_ENABLED", value: signUpEnabled ? "1" : "0" },
                    ],
                    readinessProbe: { httpGet: { path: "/health", port: "http" }, initialDelaySeconds: 10, periodSeconds: 10 },
                    livenessProbe: { httpGet: { path: "/health", port: "http" }, initialDelaySeconds: 30, periodSeconds: 20 },
                    resources: { requests: { cpu: "500m", memory: "1Gi" }, limits: { memory: "4Gi" } },
                    volumeMounts: [{ name: "workspaces", mountPath: "/workspaces" }],
                }],
                volumes: [{ name: "workspaces", persistentVolumeClaim: { claimName: workspaces.metadata.name } }],
            },
        },
    },
}, { ...opts, dependsOn: [envSecret] });

new k8s.core.v1.Service("factory", {
    metadata: { name: "factory", namespace, labels: labels("factory") },        // DNS name fixed by the platform contract
    spec: { selector: { "app.kubernetes.io/name": "factory" }, ports: [{ name: "http", port, targetPort: "http" }] },
}, { ...opts, dependsOn: [deployment] });

export const factoryInternalUrl = pulumi.interpolate`http://factory.${namespace}.svc.cluster.local:${port}`;
export const factoryImage = image.ref;
export const factoryNamespace = namespace;
export const factoryPublicUrl = publicUrl;
