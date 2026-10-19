"""End-to-end assertions on what the Pulumi program registers (under mocks)."""

import pytest
from conftest import (FAKE_COMPONENTS, FAKE_KUBECONFIG, INFRA, PROJECT, is_secret,
                      run_program, unsecret)

import cluster
import gpu_stack
import model


# --- cluster layer --------------------------------------------------------

def test_node_role_is_owner_tagged_with_the_four_policies(program):
    role = program.one("aws:iam/role:Role", "aicr-chatbot-node-role")
    assert role.inputs["tags"]["Owner"] == "tester@example.com"
    attachments = program.of_type("aws:iam/rolePolicyAttachment:RolePolicyAttachment")
    ours = {a.inputs["policyArn"] for a in attachments if a.name.startswith("aicr-chatbot-node-")}
    assert ours == set(cluster.NODE_POLICIES.values())


def test_cluster_uses_ubuntu_ami_on_two_gpu_nodes(program):
    c = program.one("eks:index:Cluster", "aicr-chatbot")
    assert c.inputs["version"] == "1.35"
    assert c.inputs["createOidcProvider"] is True
    assert c.inputs["tags"]["Owner"] == "tester@example.com"
    ng = c.inputs["nodeGroupOptions"]
    assert ng["instanceType"] == "g6.2xlarge"
    assert ng["amiId"] == "ami-ubuntu-eks"
    assert "gpu" not in ng, "ami_id and gpu are mutually exclusive in pulumi-eks"
    assert ng["operatingSystem"] == "AL2", "bootstrap.sh-style user data; nodeadm YAML is ignored by Ubuntu"
    assert (ng["desiredCapacity"], ng["minSize"], ng["maxSize"]) == (2, 2, 2)
    assert ng["nodeRootVolumeSize"] == 100
    assert ng["nodeAssociatePublicIpAddress"] is True
    assert ng["autoScalingGroupTags"]["Owner"] == "tester@example.com", "cluster tags do not reach the ASG"


def test_ami_lookup_targets_canonical_for_the_cluster_version(program):
    ami = [c for c in program.calls if c.token == "aws:ec2/getAmi:getAmi"]
    assert len(ami) == 1
    assert ami[0].args["owners"] == [cluster.CANONICAL_OWNER_ID]
    assert ami[0].args["filters"][0]["values"] == [cluster.ubuntu_eks_ami_name_pattern("1.35")]
    assert ami[0].args["mostRecent"] is True


def test_subnets_span_the_eks_capable_azs_of_the_default_vpc(program):
    subnets = [c for c in program.calls if c.token == "aws:ec2/getSubnets:getSubnets"][0]
    filters = {f["name"]: f["values"] for f in subnets.args["filters"]}
    assert filters["vpc-id"] == ["vpc-default"]
    assert filters["availability-zone"] == cluster.EKS_AZS
    assert "us-east-1e" not in filters["availability-zone"]


# --- AICR stack -----------------------------------------------------------

def test_cluster_stack_targets_the_dynamo_inference_recipe(program):
    s = program.one("nvidia-aicr:index:ClusterStack", "nvidia-aicr")
    i = s.inputs
    assert (i["accelerator"], i["service"], i["intent"], i["platform"], i["os"]) == \
        ("h100", "eks", "inference", "dynamo", "ubuntu")
    assert i["nodes"] == 2
    assert is_secret(i["kubeconfig"]), "kubeconfig must be a secret in state"
    assert unsecret(i["kubeconfig"]) == FAKE_KUBECONFIG
    assert i["skipAwait"] is True


def test_cluster_stack_skips_what_cannot_run_on_l4_nodes(program):
    s = program.one("nvidia-aicr:index:ClusterStack")
    assert set(s.inputs["skipComponents"]) == {"aws-efa", "nodewright-customizations"}


def test_recipe_gateway_is_restricted_to_private_ranges(program):
    s = program.one("nvidia-aicr:index:ClusterStack")
    override = s.inputs["componentOverrides"]["agentgateway"]
    assert override["values"]["allowedSourceRanges"] == gpu_stack.RFC1918


def test_recipe_gateway_elb_gets_the_owner_tag_via_a_patch(program):
    patch = program.one("kubernetes:core/v1:ServicePatch", "inference-gateway-owner-tag")
    assert patch.inputs["metadata"]["namespace"] == gpu_stack.GATEWAY_NAMESPACE
    assert patch.inputs["metadata"]["name"] == gpu_stack.GATEWAY_SERVICE
    ann = patch.inputs["metadata"]["annotations"]
    assert ann["service.beta.kubernetes.io/aws-load-balancer-additional-resource-tags"] == "Owner=tester@example.com"


def test_validation_is_opt_in(program, program_full):
    assert program.of_type("nvidia-aicr:index:ValidationRun") == []
    v = program_full.one("nvidia-aicr:index:ValidationRun", "aicr-validation")
    assert v.inputs["phases"] == ["deployment", "conformance"], "performance floor is 8xH100-calibrated"
    assert v.inputs["strict"] is False
    assert v.inputs["requireGpu"] is True
    assert v.inputs["recipeDataVersion"] == "v0.21.1"
    assert v.inputs["criteria"]["skipComponents"] == ["aws-efa", "nodewright-customizations"], \
        "validation must target the exact component subset deployed"
    assert v.inputs["triggers"] == [FAKE_COMPONENTS]


# --- readiness gate -------------------------------------------------------

def test_gate_waits_on_the_cluster_with_the_right_inputs(program):
    g = program.one("command:local:Command", "dynamo-ready")
    assert g.inputs["create"] == "bash ./wait-for-dynamo.sh"
    assert g.inputs["dir"].endswith("/llm")
    env = g.inputs["environment"]
    assert is_secret(env), "the environment carries the kubeconfig, so it must be secret in state"
    assert unsecret(env)["KUBECONFIG_JSON"] == FAKE_KUBECONFIG
    assert unsecret(env)["MIN_GPU_NODES"] == "2"
    assert g.inputs["triggers"] == [FAKE_COMPONENTS], "re-run the gate when the stack changes"


def test_pvcs_are_released_on_destroy_before_the_stack_goes(program):
    hook = program.one("command:local:Command", "release-volumes")
    assert hook.inputs["create"] == "true", "no-op on up"
    assert hook.inputs["delete"] == "bash ./release-pvcs.sh"
    assert is_secret(hook.inputs["environment"])
    assert unsecret(hook.inputs["environment"])["KUBECONFIG_JSON"] == FAKE_KUBECONFIG


# --- model ----------------------------------------------------------------

def test_model_is_a_dynamo_graph_deployment_with_one_worker_per_gpu(program):
    dgd = program.one("kubernetes:nvidia.com/v1beta1:DynamoGraphDeployment", "chat-llm")
    assert dgd.inputs["metadata"] == {"name": "chat-llm", "namespace": model.DYNAMO_NAMESPACE}
    spec = dgd.inputs["spec"]
    assert spec["backendFramework"] == "vllm"
    by_name = {c["name"]: c for c in spec["components"]}
    assert by_name["Frontend"]["replicas"] == 1
    worker = by_name["VllmDecodeWorker"]
    assert worker["replicas"] == 2
    container = worker["podTemplate"]["spec"]["containers"][0]
    assert container["resources"]["limits"]["nvidia.com/gpu"] == "1"
    assert container["image"] == model.DYNAMO_RUNTIME_IMAGE
    args = container["args"]
    assert args[args.index("--model") + 1] == "Qwen/Qwen2.5-Coder-7B-Instruct"


def test_hf_token_is_only_wired_when_configured(program, program_full):
    def worker_env(p):
        dgd = p.one("kubernetes:nvidia.com/v1beta1:DynamoGraphDeployment")
        worker = [c for c in dgd.inputs["spec"]["components"] if c["type"] == "worker"][0]
        return {e["name"]: e for e in worker["podTemplate"]["spec"]["containers"][0]["env"]}

    assert "HF_TOKEN" not in worker_env(program)
    assert program.of_type("kubernetes:core/v1:Secret") == []

    env = worker_env(program_full)
    assert env["HF_TOKEN"]["valueFrom"]["secretKeyRef"] == {"name": "hf-token", "key": "token"}
    secret = program_full.one("kubernetes:core/v1:Secret", "hf-token")
    assert secret.inputs["metadata"]["namespace"] == model.DYNAMO_NAMESPACE
    assert is_secret(secret.inputs["stringData"]), "the HF token must stay secret in state"
    assert unsecret(secret.inputs["stringData"])["token"] == "hf_secret"


def test_invalid_replica_configuration_is_rejected_up_front():
    with pytest.raises((ValueError, SystemExit)):
        run_program({f"{PROJECT}:modelReplicas": "3"})     # nodeCount is 2: one GPU per node
    with pytest.raises((ValueError, SystemExit)):
        run_program({f"{PROJECT}:modelReplicas": "0"})


def test_gateway_source_ranges_config_overrides_the_default(program):
    custom = run_program({f"{PROJECT}:gatewaySourceRanges": '["203.0.113.0/24"]'})
    s = custom.one("nvidia-aicr:index:ClusterStack")
    assert s.inputs["componentOverrides"]["agentgateway"]["values"]["allowedSourceRanges"] == ["203.0.113.0/24"]


def test_no_gateway_api_routes_are_created(program):
    """Exposure is the owned LoadBalancer; the recipe's inference-gateway is not on the demo path."""
    assert not [r for r in program.resources if "HTTPRoute" in r.typ or "ReferenceGrant" in r.typ]


def test_resource_inventory_is_what_the_demo_story_says(program):
    types = {r.typ for r in program.resources}
    assert {"eks:index:Cluster", "nvidia-aicr:index:ClusterStack", "command:local:Command",
            "kubernetes:nvidia.com/v1beta1:DynamoGraphDeployment"} <= types
    assert not {"docker-build:index:Image", "aws:ecr/repository:Repository"} & types, "chatbot image was removed"


def test_worker_enables_tool_calling_with_the_hermes_parser(program):
    dgd = program.one("kubernetes:nvidia.com/v1beta1:DynamoGraphDeployment", "chat-llm")
    worker = [c for c in dgd.inputs["spec"]["components"] if c["type"] == "worker"][0]
    args = worker["podTemplate"]["spec"]["containers"][0]["args"]
    assert args[args.index("--dyn-tool-call-parser") + 1] == "hermes"


def test_downstream_exports_are_present():
    from pulumi.runtime import settings  # noqa: F401  (exports are checked via program source below)
    src = (INFRA / "__main__.py").read_text()
    for name in ("cluster_name", "kubeconfig", "llm_internal_url", "llm_model", "llm_openai_base_url"):
        assert f'pulumi.export("{name}"' in src
    assert "chat_url" not in src


def test_cluster_enforces_network_policy(program):
    c = program.one("eks:index:Cluster", "aicr-chatbot")
    assert c.inputs["vpcCniOptions"]["enableNetworkPolicy"] is True, \
        "without it the VPC CNI ignores NetworkPolicy objects"


def test_reasoning_parser_and_context_length_are_configurable():
    p = run_program({f"{PROJECT}:reasoningParser": "qwen3", f"{PROJECT}:maxModelLen": "16384"})
    dgd = p.one("kubernetes:nvidia.com/v1beta1:DynamoGraphDeployment", "chat-llm")
    worker = [c for c in dgd.inputs["spec"]["components"] if c["type"] == "worker"][0]
    args = worker["podTemplate"]["spec"]["containers"][0]["args"]
    assert args[args.index("--dyn-reasoning-parser") + 1] == "qwen3"
    assert args[args.index("--max-model-len") + 1] == "16384"
