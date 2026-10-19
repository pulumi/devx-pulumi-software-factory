# devx-pulumi-software-factory

A self-driving software factory, described entirely in Pulumi code. Five small stacks deploy, on AWS:

- a **model on your own GPUs** (Qwen3-8B on EKS, served through NVIDIA Dynamo and vLLM),
- **[Mastra Factory](https://factory.mastra.ai/)**, an open source environment where coding agents turn issues into plans and pull requests,
- a **Mastra agent** that reads the Factory work board through an authenticated tool, and
- an **issue triage service** that uses [Jev](https://docs.typesafe.ai) to accept, reject or ask for detail on each new item.

Tear the whole thing down with one command.

```
llm  →  platform  →  factory · agent · triage
```

| Stack | Language | What it does |
|---|---|---|
| `stacks/llm` | Python | EKS cluster with 2 × `g6.2xlarge` (NVIDIA L4) nodes, the GPU software stack from the Pulumi NVIDIA AICR provider, and Qwen3-8B behind an OpenAI-compatible API. Cluster-internal only. |
| `stacks/platform` | TypeScript | The shared base. Owns the `agent-platform` namespace and network policy, and publishes shared config (the model endpoint and the project brief) for the other stacks. Reads `llm` through a `StackReference`. |
| `stacks/factory` | TypeScript | Mastra Factory with Postgres + pgvector and its own sign-in. Builds and pushes the image to ECR. Optional GitHub App for issue intake. |
| `stacks/agent` | TypeScript | A Mastra agent pod that uses the in-cluster model and reads the Factory board. |
| `stacks/triage` | TypeScript | The triage evaluator pod plus a DynamoDB audit trail, with a scoped IRSA role. Independent of the others except for reading `platform` and `llm`. |

The code you deploy with lives in `apps/` (`factory`, `agent`, `triage`). `scripts/` holds the orchestration, setup and check scripts.

## Cost and time

The `llm` stack dominates: about **$2.2 per hour** while up (two L4 GPU nodes, an EKS control plane and a NAT gateway). A full bring-up takes roughly 45 minutes, most of it the cluster, the GPU software and loading the model weights. A teardown takes a similar time. **Destroy it when you are done.**

## Prerequisites

- AWS account with quota for 2 × `g6.2xlarge` (On-Demand G/VT vCPUs ≥ 16), and credentials in your shell
- A Pulumi account and `pulumi login`
- Node.js 20+ (22 recommended), Python 3.12, Docker, `kubectl`, `helm`, `aws`
- A Hugging Face token only if you swap in a gated model
- A [Jev](https://docs.typesafe.ai) API key for the triage stack (Jev is early access)
- The `pulumi-nvidia-aicr` provider. `stacks/llm/setup.sh` installs the Python SDK and plugin from a checkout (`PROVIDER_REPO=<path>`); once a release is published you can pin the package in `requirements.txt` instead.

Run `scripts/preflight.sh` for a read-only check of your tools and AWS quota.

## Quick start

```bash
npm install
export PULUMI_ORG=<your-pulumi-org>

# 1. Configure each stack. Examples are in stacks/*/Pulumi.dev.yaml.example.
for s in llm platform factory agent triage; do
  (cd stacks/$s && pulumi stack init $PULUMI_ORG/dev && cp Pulumi.dev.yaml.example Pulumi.dev.yaml)
done
# edit the files: set owner, and replace my-org with your Pulumi org

# 2. The project brief the agents work from, piped from a file
(cd stacks/platform && pulumi config set projectBrief < ../../factory-prompt.md)

# 3. Secrets
(cd stacks/triage && pulumi config set --secret jevApiKey "<your Jev key>")

# 4. Deploy all five stacks in dependency order
npm run orchestrate -- up

# 5. Point Factory at the model (idempotent)
KUBECONFIG=<kubeconfig-file> npx tsx scripts/bootstrap.ts
```

`Pulumi.*.yaml` files are git-ignored, so config and secrets stay out of the repository.

### Use it

```bash
export KUBECONFIG=<kubeconfig-file>           # the llm stack exports a kubeconfig
scripts/seed-issues.sh < examples/items.txt   # add work items to Factory, one title per line
scripts/board.sh                              # the board: planning, canceled, needs a person
scripts/demo-agent.sh "which item is about reconnecting?"   # ask the agent, which reads the board
npx tsx scripts/compat-check.ts --org $PULUMI_ORG --owner you@example.com   # 22 cross-stack checks
```

Factory itself is reachable with `kubectl port-forward -n agent-platform svc/factory 4111:4111`.

### Tear it down

```bash
npm run orchestrate -- down --yes       # destroys triage → agent → factory → platform → llm
scripts/aws-leftovers.sh <owner-tag>    # confirm nothing tagged with your owner is left
```

## Optional: GitHub issue intake

Factory's Work board shows issues once a GitHub App is installed on a repository linked to the project. `tools/github-app` creates one through GitHub's manifest flow and stores the credentials as Pulumi secrets on the `factory` stack; see the header of `tools/github-app/github-app.ts`. `scripts/local-factory.sh` runs Factory locally against a local Postgres, which is handy for trying the GitHub link before paying for a cluster.

## Tests

```bash
npm install && for d in apps/agent apps/triage stacks/agent stacks/factory stacks/platform stacks/triage; do (cd $d && npm install); done
npm test                          # 90 tests: orchestration, bootstrap, compat checks, the three apps, and Pulumi mock tests for each TypeScript stack
(cd stacks/llm && ./setup.sh && ./venv/bin/pytest)   # the Python stack (needs the AICR provider checkout)
```

`scripts/leakcheck.sh` fails if a value from your `.env` or a common token pattern appears in the working tree.

## Notes and limits

- Triage accepts, rejects or asks for detail and moves items to **planning**. The agent writing code and opening pull requests is not part of this example's flow.
- `docs/triage-eval.md` records how triage behaved against live Jev on a small hand-written set. It is a demonstration of the mechanism, not an accuracy benchmark.
- An 8B model is small. Agent answers are real model output and can be wrong.
- Everything is tagged with your `owner` value. In shared AWS accounts, cleanup jobs often delete untagged resources.

`apps/factory` is generated from [`npm create factory`](https://www.npmjs.com/package/create-factory); see its own README for Factory configuration.
