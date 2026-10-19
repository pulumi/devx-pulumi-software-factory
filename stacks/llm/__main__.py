"""llm stack (forked from the AICR chatbot demo): an OpenAI-compatible endpoint
on an EKS GPU cluster whose entire GPU software stack comes from one Pulumi
NVIDIA AICR `ClusterStack` resource. The chat web app was removed; the endpoint
is cluster-internal and consumed by the platform/agent/factory stacks.

Layers (each a module; read them in this order):
  cluster.py    EKS + 2 GPU nodes on Ubuntu
  gpu_stack.py  the AICR-validated inference stack (GPU Operator ... Dynamo)   <-- the product
  gate.py       wait until the Dynamo operator is serving
  model.py      the LLM as a DynamoGraphDeployment, one worker per GPU

Costs ~$2.2/hr while up. `pulumi destroy` when done.
"""

import pulumi
import pulumi_kubernetes as k8s

import cluster
import gate
import gpu_stack
import model

config = pulumi.Config()
name = config.get("clusterName") or "aicr-chatbot"
owner = config.require("owner")
node_count = config.get_int("nodeCount")
node_count = 2 if node_count is None else node_count
model_replicas = config.get_int("modelReplicas")
model_replicas = node_count if model_replicas is None else model_replicas
hf_token = config.get_secret("hfToken")
gateway_source_ranges = config.get_object("gatewaySourceRanges")

# One GPU per node: each decode worker needs a node of its own.
if node_count < 1:
    raise ValueError(f"nodeCount must be >= 1, got {node_count}")
if not 1 <= model_replicas <= node_count:
    raise ValueError(f"modelReplicas must be between 1 and nodeCount ({node_count}), got {model_replicas}")

# --- 1. Cluster ------------------------------------------------------------
eks_cluster = cluster.create_cluster(cluster.ClusterSpec(
    name=name,
    # g6.2xlarge = 1x L4 24 GB, 8 vCPU (~$0.98/hr). g6.xlarge (4 vCPU) cannot
    # hold the platform's CPU requests. g5.2xlarge (A10G) is the capacity fallback.
    instance_type=config.get("instanceType") or "g6.2xlarge",
    node_count=node_count,
    # The dynamo recipe leaf wants Kubernetes >= 1.34 (DRA GA). 1.35's Ubuntu
    # EKS AMI is 24.04 with a proven kernel/driver pair.
    k8s_version=config.get("k8sVersion") or "1.35",
    owner=owner,
    extra_tags={"nvidia.com/aicr": "chatbot-demo"},
))
kubeconfig = cluster.kubeconfig(eks_cluster)

# --- 2. The AICR stack: the star of the demo -------------------------------
stack = gpu_stack.deploy_gpu_stack("nvidia-aicr", kubeconfig,
    gpu_stack.GpuStackSpec(node_count=node_count,
                           **({"gateway_source_ranges": gateway_source_ranges} if gateway_source_ranges else {})))

# Destroy-time hook: release the recipe's PVCs (Prometheus keeps a 50 GB one)
# while the EBS CSI driver can still delete the volumes.
gate.release_volumes_on_destroy("release-volumes", kubeconfig, depends_on=[stack])

# --- 3. Wait for the Dynamo operator (skipAwait leaves that to us) ---------
ready = gate.wait_for_dynamo("dynamo-ready", kubeconfig,
    min_gpu_nodes=model_replicas,
    depends_on=[stack],
    triggers=[stack.deployed_components],
)

# --- 4. The model ----------------------------------------------------------
k8s_provider = k8s.Provider("k8s", kubeconfig=kubeconfig)
# The recipe's own gateway ELB is not on the demo path, but it must carry the
# Owner tag or the account reaper recreates it hourly.
gpu_stack.tag_gateway_load_balancer("inference-gateway-owner-tag", owner,
    provider=k8s_provider, depends_on=[ready])
llm = model.ModelSpec(
    name="chat-llm",
    model=config.get("model") or "Qwen/Qwen2.5-Coder-7B-Instruct",
    replicas=model_replicas,
    tool_call_parser=config.get("toolCallParser") or "hermes",
    reasoning_parser=config.get("reasoningParser"),
    max_model_len=config.get_int("maxModelLen") or 8192,
    hf_token_secret="hf-token" if hf_token else None,
)
llm_deployment = model.deploy_model(llm, provider=k8s_provider, depends_on=[ready], hf_token=hf_token)

# --- Outputs ---------------------------------------------------------------
pulumi.export("llm_model", llm.model)
pulumi.export("llm_internal_url", llm.frontend_url)
pulumi.export("llm_openai_base_url", f"{llm.frontend_url}/v1")
pulumi.export("recipe_name", stack.recipe_name)
pulumi.export("recipe_version", stack.recipe_version)
pulumi.export("deployed_components", stack.deployed_components)
pulumi.export("cluster_name", eks_cluster.eks_cluster.name)
pulumi.export("kubeconfig", kubeconfig)

# --- Optional: empirical validation (pulumi config set validate true) ------
if config.get_bool("validate"):
    validation = gpu_stack.validate_gpu_stack("aicr-validation", stack, kubeconfig, depends_on=[ready])
    pulumi.export("validation_status", validation.status)
    pulumi.export("validation_readiness", validation.readiness_message)
    pulumi.export("validation_checks", validation.phase_results)
