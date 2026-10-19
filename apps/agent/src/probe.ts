// Repeatable tool-use probe: N trials. Success = tool called AND answer contains the tool's own value.
import { createCoderAgent, PromptStore, readEnv } from "./agent";
const env = readEnv();
const N = Number(process.env.TRIALS ?? 5);
const fake = (async () => new Response(JSON.stringify({ projects: [{ id: "proj-1", name: "instant-messenger" }] }), { status: 200 })) as unknown as typeof fetch;
const agent = createCoderAgent({ ...env, FACTORY_INTERNAL_URL: "http://factory.invalid" }, new PromptStore(env.LOOP_PROMPT_PATH), fake);
const ask = "List the Factory projects using your tool, then tell me the project name in one sentence.";
let ok = 0, called = 0, empty = 0; const rows: string[] = [];
for (let i = 0; i < N; i++) {
  const t0 = Date.now();
  try {
    const out: any = await agent.generate(ask, { maxSteps: 4 } as any);
    const calls = (out.toolCalls ?? []).length + ((out.steps ?? []).reduce((a: number, s: any) => a + (s.toolCalls?.length ?? 0), 0));
    const text = String(out.text ?? "");
    const good = calls > 0 && /instant-messenger/i.test(text);
    if (calls > 0) called++; if (!text.trim()) empty++; if (good) ok++;
    rows.push(`#${i + 1} ${Date.now() - t0}ms toolCalls=${calls} ${good ? "OK" : "FAIL"} :: ${text.replace(/\s+/g, " ").slice(0, 110)}`);
  } catch (e) { rows.push(`#${i + 1} ERROR ${(e as Error).message.slice(0, 100)}`); }
}
console.log(rows.join("\n")); console.log(JSON.stringify({ trials: N, toolCalled: called, correctAnswer: ok, emptyAnswer: empty }));
