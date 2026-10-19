// Live smoke: the Mastra agent against a real OpenAI-compatible endpoint (e.g. via kubectl port-forward).
//   LLM_BASE_URL=http://127.0.0.1:8000/v1 LLM_MODEL=Qwen/Qwen2.5-Coder-7B-Instruct npx tsx src/smoke.ts
import { createCoderAgent, PromptStore, readEnv } from "./agent";
const env = readEnv();
const prompt = new PromptStore(env.LOOP_PROMPT_PATH);
const fakeFactory = (async () => new Response(JSON.stringify({ projects: [{ id: "proj-1", name: "instant-messenger" }] }), { status: 200 })) as unknown as typeof fetch;
const agent = createCoderAgent({ ...env, FACTORY_INTERNAL_URL: env.FACTORY_INTERNAL_URL ?? "http://factory.invalid" }, prompt, fakeFactory);
const t0 = Date.now();
const out = await agent.generate("List the Factory projects using your tool, then tell me the project name in one sentence.");
console.log(JSON.stringify({ ms: Date.now() - t0, toolCalls: (out.toolCalls ?? []).map((t: any) => t.payload?.toolName ?? t.toolName), text: out.text }, null, 2));
