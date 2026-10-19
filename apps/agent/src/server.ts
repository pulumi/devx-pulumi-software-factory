import { createServer } from "node:http";
import { createCoderAgent, PromptStore, readEnv } from "./agent";

export function buildServer(agent: ReturnType<typeof createCoderAgent>, prompt: PromptStore) {
  return createServer(async (req, res) => {
    const send = (code: number, body: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    if (req.method === "GET" && req.url === "/healthz") return send(200, { ok: true });
    if (req.method === "POST" && req.url === "/reload") { prompt.reload(); return send(200, { reloaded: true, chars: prompt.get().length }); }
    if (req.method === "POST" && req.url === "/run") {
      let raw = ""; for await (const c of req) raw += c;
      try {
        const { prompt: p } = JSON.parse(raw || "{}");
        if (typeof p !== "string" || !p) return send(400, { error: "body must be {\"prompt\": string}" });
        const out = await agent.generate(p);
        return send(200, { text: out.text, toolCalls: (out.toolCalls ?? []).length });
      } catch (e) { return send(500, { error: String((e as Error).message) }); }
    }
    send(404, { error: "not found" });
  });
}

// Entry point (skipped under test)
if (process.env.VITEST === undefined && import.meta.url === `file://${process.argv[1]}`) {
  const env = readEnv();
  const prompt = new PromptStore(env.LOOP_PROMPT_PATH);
  const agent = createCoderAgent(env, prompt);
  process.on("SIGHUP", () => { prompt.reload(); console.log("prompt reloaded"); });
  const port = Number(process.env.PORT ?? 8080);
  buildServer(agent, prompt).listen(port, () => console.log(`factory-coder listening on :${port}`));
}
