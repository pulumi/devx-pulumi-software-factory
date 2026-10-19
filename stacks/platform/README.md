# platform (parent/umbrella stack)

Owns the shared Kubernetes namespace and policy that the child stacks (`factory`, `agent`) deploy into. It reads the `llm` stack through a `StackReference` (config `platform:llmStack`, e.g. `my-org/llm/dev`).

## Config
| Key | Required | Notes |
|---|---|---|
| `llmStack` | yes | fully qualified `llm` stack name |
| `owner` | yes | stamped as a label |
| `namespace` | no | default `agent-platform` |
| `factoryPort` | no | default `4111` (Factory Service must use this port) |
| `githubToken`, `jevApiKey` | no | `pulumi config set --secret`; create Secrets `github-token` / `jev-api-key` with key `value` |

## Contract (stack outputs children may assume)
`namespace`, `kubeconfig` (secret), `llmBaseUrl` (OpenAI-compatible `/v1`), `llmModel`, `factoryInternalUrl` (`http://factory.<ns>.svc.cluster.local:<port>`; the Factory stack must create a Service named `factory`), `sharedLabels`, `owner`, `configMapName` (`platform-config`: `LLM_BASE_URL`, `LLM_MODEL`, `FACTORY_INTERNAL_URL`), `secretNames`.

## Network policy
Ingress: default deny, allow from inside the namespace. Egress: DNS, in-namespace, the Dynamo frontend (`dynamo-system`, TCP 8000), and TCP 443 anywhere (GitHub, Jev, registries).

## Tests
`npm test` (Pulumi mocks).
