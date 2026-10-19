import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCoderAgent, PromptStore, readEnv } from "../src/agent";
import { startMockLlm } from "./mockLlm";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

const promptFile = (text: string) => { const d = mkdtempSync(join(tmpdir(), "agent-")); const p = join(d, "factory-prompt.md"); writeFileSync(p, text); return p; };

describe("factory-coder agent", () => {
  it("sends a chat completion to the configured OpenAI-compatible endpoint with the brief in the system prompt", async () => {
    const llm = await startMockLlm(() => ({ content: "pong" })); close = llm.close;
    const path = promptFile("Build a simple web instant messenger.");
    const env = { LLM_BASE_URL: llm.url, LLM_MODEL: "Qwen/Qwen2.5-Coder-7B-Instruct", LOOP_PROMPT_PATH: path };
    const agent = createCoderAgent(env, new PromptStore(path));
    const out = await agent.generate("say pong");
    expect(out.text).toBe("pong");
    const req = llm.requests.find((r) => r.path.endsWith("/chat/completions"))!;
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.body.model).toBe("Qwen/Qwen2.5-Coder-7B-Instruct");
    expect(JSON.stringify(req.body.messages)).toContain("Build a simple web instant messenger.");
  });

  it("handles a tool call: runs the Factory tool and feeds the result back", async () => {
    const llm = await startMockLlm((body, n) => n === 1
      ? { content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "factory_list_projects", arguments: "{}" } }] }
      : { content: "1 project" }); close = llm.close;
    const calls: string[] = [];
    const factoryFetch = (async (url: string, init?: any) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      if (url.endsWith("/auth/api/sign-in/email")) {
        expect(init.headers.origin).toBe("http://localhost:4111");
        expect(JSON.parse(init.body)).toEqual({ email: "svc@x", password: "pw" });
        return new Response(JSON.stringify({ token: "tok-1" }), { status: 200 });
      }
      expect(url).toBe("http://factory.test:4111/web/factory/projects");
      expect(init.headers.authorization).toBe("Bearer tok-1");
      return new Response(JSON.stringify({ projects: [{ id: "p1" }] }), { status: 200 });
    }) as unknown as typeof fetch;
    const path = promptFile("brief");
    const agent = createCoderAgent({ LLM_BASE_URL: llm.url, LLM_MODEL: "m", FACTORY_INTERNAL_URL: "http://factory.test:4111", FACTORY_USER_EMAIL: "svc@x", FACTORY_USER_PASSWORD: "pw" }, new PromptStore(path), factoryFetch);
    const out = await agent.generate("how many projects?");
    expect(out.text).toBe("1 project");
    const second = llm.requests.filter((r) => r.path.endsWith("/chat/completions"))[1];
    expect(JSON.stringify(second.body.messages)).toContain("p1");
    expect(calls[0]).toContain("sign-in/email");   // signed in before the first API call
  });

  it("reloads the prompt file on demand (SIGHUP path)", () => {
    const path = promptFile("v1"); const store = new PromptStore(path);
    expect(store.get()).toBe("v1");
    writeFileSync(path, "v2\n"); store.reload();
    expect(store.get()).toBe("v2");
  });

  it("tolerates a missing prompt file (bootstrap has not created the ConfigMap yet)", () => {
    const store = new PromptStore("/definitely/not/here.md");
    expect(store.get()).toBe("");
  });

  it("requires LLM_BASE_URL and LLM_MODEL", () => {
    expect(() => readEnv({})).toThrow(/LLM_BASE_URL/);
    expect(readEnv({ LLM_BASE_URL: "http://x/v1", LLM_MODEL: "m" }).LLM_MODEL).toBe("m");
  });
});

import { buildServer } from "../src/server";
describe("agent HTTP server", () => {
  it("serves /healthz and /run", async () => {
    const llm = await startMockLlm(() => ({ content: "done" })); close = llm.close;
    const path = promptFile("brief"); const store = new PromptStore(path);
    const srv = buildServer(createCoderAgent({ LLM_BASE_URL: llm.url, LLM_MODEL: "m" }, store), store);
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(srv.address() as any).port}`;
    try {
      expect((await fetch(`${base}/healthz`)).status).toBe(200);
      const r = await fetch(`${base}/run`, { method: "POST", body: JSON.stringify({ prompt: "go" }) });
      expect(await r.json()).toMatchObject({ text: "done" });
      expect((await fetch(`${base}/run`, { method: "POST", body: "{}" })).status).toBe(400);
    } finally { srv.close(); }
  });
});


import { FactoryClient } from "../src/factoryClient";
describe("FactoryClient", () => {
  const mk = (handler: (url: string, init: any) => Response) =>
    new FactoryClient({ baseUrl: "http://f", email: "e", password: "p", origin: "http://localhost:4111", fetchImpl: (async (u: string, i: any) => handler(u, i)) as any });

  it("re-signs-in once when the token is rejected, then succeeds", async () => {
    let logins = 0, apiCalls = 0;
    const c = mk((url, init) => {
      if (url.endsWith("/sign-in/email")) return new Response(JSON.stringify({ token: `t${++logins}` }), { status: 200 });
      apiCalls++;
      return init.headers.authorization === "Bearer t2" ? new Response(JSON.stringify({ ok: 1 }), { status: 200 }) : new Response("{}", { status: 401 });
    });
    expect(await c.get("/projects")).toEqual({ ok: 1 });
    expect(logins).toBe(2); expect(apiCalls).toBe(2);
  });
  it("fails clearly when sign-in is refused", async () => {
    const c = mk(() => new Response("{}", { status: 403 }));
    await expect(c.get("/projects")).rejects.toThrow(/sign-in failed: HTTP 403/);
  });
  it("does not loop forever on persistent 401", async () => {
    let n = 0;
    const c = mk((url) => url.endsWith("/sign-in/email") ? new Response(JSON.stringify({ token: "t" }), { status: 200 }) : (n++, new Response("{}", { status: 401 })));
    await expect(c.get("/projects")).rejects.toThrow();
    expect(n).toBe(2);
  });
  it("reports non-auth errors with the path", async () => {
    const c = mk((url) => url.endsWith("/sign-in/email") ? new Response(JSON.stringify({ token: "t" }), { status: 200 }) : new Response("x", { status: 500 }));
    await expect(c.get("/projects")).rejects.toThrow(/\/projects -> HTTP 500/);
  });
});
