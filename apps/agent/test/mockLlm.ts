import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Recorded { path: string; body: any; auth?: string }

/** Minimal OpenAI-compatible server. `script` returns the assistant message for each request. */
export async function startMockLlm(script: (body: any, n: number) => any): Promise<{ url: string; requests: Recorded[]; close: () => Promise<void>; server: Server }> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ path: req.url ?? "", body, auth: req.headers.authorization });
      if (req.url?.endsWith("/chat/completions")) {
        const message = script(body, requests.length);
        const finish = message.tool_calls ? "tool_calls" : "stop";
        if (body.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          const base = { id: "c1", object: "chat.completion.chunk", created: 1, model: body.model };
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: message.content ?? null, tool_calls: message.tool_calls?.map((t: any, i: number) => ({ index: i, ...t })) }, finish_reason: null }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } })}\n\n`);
          res.end("data: [DONE]\n\n");
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ id: "c1", object: "chat.completion", created: 1, model: body.model,
            choices: [{ index: 0, message: { role: "assistant", ...message }, finish_reason: finish }],
            usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
        }
      } else { res.writeHead(404); res.end(); }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/v1`, requests, server, close: () => new Promise((r) => server.close(() => r())) };
}
