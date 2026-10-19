import * as pulumi from "@pulumi/pulumi";
import * as k8s from "@pulumi/kubernetes";

const config = new pulumi.Config();
const llmStack = config.require("llmStack");                 // e.g. my-org/llm/dev
const owner = config.require("owner");
const nsName = config.get("namespace") ?? "agent-platform";
const factoryPort = config.getNumber("factoryPort") ?? 4111;
const dynamoNamespace = config.get("dynamoNamespace") ?? "dynamo-system";
const llmPort = 8000;
const projectBrief = config.require("projectBrief");           // pulumi config set projectBrief < brief.md

const llm = new pulumi.StackReference(llmStack);
const kubeconfig = llm.requireOutput("kubeconfig");
export const llmBaseUrl = llm.requireOutput("llm_openai_base_url");
export const llmModel = llm.requireOutput("llm_model");

const provider = new k8s.Provider("k8s", { kubeconfig });
const opts = { provider };

export const sharedLabels = {
    "app.kubernetes.io/part-of": "agent-factory",
    "agent-factory/owner": owner.replace(/[^A-Za-z0-9_.-]/g, "_"),
};

const ns = new k8s.core.v1.Namespace("agent-platform", {
    metadata: { name: nsName, labels: sharedLabels },
}, opts);

const inNs = { namespace: ns.metadata.name };

// The project brief: the agent and the triage service both read it from this ConfigMap (mounted at /prompt).
new k8s.core.v1.ConfigMap("coding-loop", {
    metadata: { name: "coding-loop", ...inNs, labels: sharedLabels },
    data: { "factory-prompt.md": `${projectBrief.trim()}\n` },
}, opts);

// Ingress: default deny, allow from inside the namespace only.
new k8s.networking.v1.NetworkPolicy("default-deny-ingress", {
    metadata: { name: "default-deny-ingress", ...inNs, labels: sharedLabels },
    spec: { podSelector: {}, policyTypes: ["Ingress"] },
}, opts);

new k8s.networking.v1.NetworkPolicy("allow-same-namespace", {
    metadata: { name: "allow-same-namespace", ...inNs, labels: sharedLabels },
    spec: { podSelector: {}, policyTypes: ["Ingress"], ingress: [{ from: [{ podSelector: {} }] }] },
}, opts);

// Egress: DNS, in-namespace, the LLM frontend (8000) and the internet on 443.
new k8s.networking.v1.NetworkPolicy("restrict-egress", {
    metadata: { name: "restrict-egress", ...inNs, labels: sharedLabels },
    spec: {
        podSelector: {},
        policyTypes: ["Egress"],
        egress: [
            { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } } }],
              ports: [{ protocol: "UDP", port: 53 }, { protocol: "TCP", port: 53 }] },
            { to: [{ podSelector: {} }] },
            { to: [{ namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": dynamoNamespace } } }],
              ports: [{ protocol: "TCP", port: llmPort }] },
            { ports: [{ protocol: "TCP", port: 443 }] },
        ],
    },
}, opts);

export const factoryInternalUrl = pulumi.interpolate`http://factory.${ns.metadata.name}.svc.cluster.local:${factoryPort}`;

const configMap = new k8s.core.v1.ConfigMap("platform-config", {
    metadata: { name: "platform-config", ...inNs, labels: sharedLabels },
    data: {
        LLM_BASE_URL: llmBaseUrl.apply(String),
        LLM_MODEL: llmModel.apply(String),
        FACTORY_INTERNAL_URL: factoryInternalUrl,
    },
}, opts);

// Secret slots, only created when the value is configured (pulumi config set --secret).
export const secretNames: string[] = [];
for (const [cfgKey, secretName] of [["githubToken", "github-token"], ["jevApiKey", "jev-api-key"]] as const) {
    const value = config.getSecret(cfgKey);
    if (value) {
        new k8s.core.v1.Secret(secretName, {
            metadata: { name: secretName, ...inNs, labels: sharedLabels },
            stringData: { value },
        }, opts);
        secretNames.push(secretName);
    }
}

new k8s.core.v1.ResourceQuota("quota", {
    metadata: { name: "agent-platform-quota", ...inNs },
    spec: { hard: { "requests.cpu": "6", "requests.memory": "16Gi", pods: "30", persistentvolumeclaims: "6" } },
}, opts);

new k8s.core.v1.LimitRange("limits", {
    metadata: { name: "agent-platform-limits", ...inNs },
    spec: { limits: [{ type: "Container",
        defaultRequest: { cpu: "100m", memory: "128Mi" }, default: { cpu: "1", memory: "1Gi" } }] },
}, opts);

export const namespace = ns.metadata.name;
export { kubeconfig };
export { owner };
export const configMapName = configMap.metadata.name;
