import { describe, it, expect } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { FactoryBootstrap } from "../scripts/lib/bootstrap-core";

/** A tiny in-memory fake of the Factory endpoints bootstrap uses. */
async function fakeFactory(opts: { userExists?: boolean } = {}) {
  const state = { users: new Set<string>(opts.userExists ? ["svc@x"] : []), providers: [] as any[], packs: [] as any[], active: "", projects: [] as any[], items: [] as any[], calls: [] as string[], originsSeen: new Set<string>() };
  const server = createServer((req, res) => {
    let raw = ""; req.on("data", (c) => (raw += c)); req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {}; const url = req.url!; const key = `${req.method} ${url}`; state.calls.push(key);
      state.originsSeen.add(String(req.headers.origin));
      const send = (code: number, o: unknown) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (key === "POST /auth/api/sign-in/email") return state.users.has(body.email) ? send(200, { token: "tok" }) : send(401, {});
      if (key === "POST /auth/api/sign-up/email") { state.users.add(body.email); return send(200, { token: "tok" }); }
      if (req.headers.authorization !== "Bearer tok") return send(401, { error: "unauthorized" });
      if (key === "GET /web/config/custom-providers") return send(200, { providers: state.providers });
      if (key === "POST /web/config/custom-providers") { state.providers = [{ name: body.name, url: body.url, models: body.models }]; return send(200, { ok: true }); }
      if (key === "GET /web/config/model-packs") return send(200, { packs: state.packs, activePackId: state.active || null });
      if (key === "POST /web/config/model-packs") { const p = { id: "custom:1", name: body.name, models: body.models }; state.packs = [p]; return send(200, { ok: true, pack: p }); }
      if (key.startsWith("POST /web/config/model-packs/") && key.endsWith("/activate")) { state.active = "custom:1"; return send(200, { ok: true }); }
      if (key === "GET /web/factory/projects") return send(200, { projects: state.projects });
      if (key === "POST /web/factory/projects") { const p = { id: "p1", name: body.name, defaultModelId: null }; state.projects.push(p); return send(200, { project: p }); }
      if (key === "PATCH /web/factory/projects/p1") { state.projects[0].defaultModelId = body.defaultModelId; return send(200, { project: state.projects[0] }); }
      if (key === "GET /web/factory/projects/p1/work-items") return send(200, { workItems: state.items });
      if (key === "POST /web/factory/projects/p1/work-items") { state.items.push({ title: body.title }); return send(200, { workItem: {} }); }
      send(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const cfg = (baseUrl: string) => ({ baseUrl, email: "svc@x", password: "pw", origin: "http://localhost:4111", llmBaseUrl: "http://llm/v1", llmModel: "Qwen/Qwen3-8B", projectName: "demo" });
const runAll = async (b: FactoryBootstrap, dry: boolean) => { await b.ensureServiceUser(dry); const m = await b.ensureModel(dry); await b.ensureProject(m, dry); };

describe("FactoryBootstrap against a fake Factory", () => {
  it("first run creates user, provider, pack, project, default model", async () => {
    const f = await fakeFactory(); const b = new FactoryBootstrap(cfg(f.url));
    try {
      await runAll(b, false);
      expect(b.changes.map((c) => c.what)).toEqual(["created service account", "upserted custom provider", "saved model pack", "activated model pack", "created project", "set project default model"]);
      expect(f.state.projects[0].defaultModelId).toBe("agent-factory-llm/Qwen/Qwen3-8B");
      expect(f.state.packs[0].models).toEqual({ build: "agent-factory-llm/Qwen/Qwen3-8B", plan: "agent-factory-llm/Qwen/Qwen3-8B", fast: "agent-factory-llm/Qwen/Qwen3-8B" });
      expect([...f.state.originsSeen]).toEqual(["http://localhost:4111"]);   // sign-in requires the public-URL origin
    } finally { await f.close(); }
  });
  it("second run is a no-op (idempotent)", async () => {
    const f = await fakeFactory(); try {
      await runAll(new FactoryBootstrap(cfg(f.url)), false);
      const again = new FactoryBootstrap(cfg(f.url)); await runAll(again, false);
      expect(again.changes).toEqual([]);
      expect(f.state.projects).toHaveLength(1);
    } finally { await f.close(); }
  });
  it("an existing service account is reused, not re-created", async () => {
    const f = await fakeFactory({ userExists: true }); try {
      const b = new FactoryBootstrap(cfg(f.url)); await b.ensureServiceUser(false);
      expect(b.changes).toEqual([]); expect(f.state.calls).not.toContain("POST /auth/api/sign-up/email");
    } finally { await f.close(); }
  });
  it("dry-run reports what it would do and writes nothing", async () => {
    const f = await fakeFactory({ userExists: true }); const b = new FactoryBootstrap(cfg(f.url));
    try {
      await runAll(b, true);
      expect(b.changes.every((c) => c.what.startsWith("would"))).toBe(true); expect(b.changes.length).toBeGreaterThanOrEqual(3);
      expect(f.state.calls.filter((c) => c.startsWith("POST /web") || c.startsWith("PATCH"))).toEqual([]);
    } finally { await f.close(); }
  });
  it("fails loudly when sign-up is refused", async () => {
    const server = createServer((req, res) => { res.writeHead(403); res.end("{}"); }); await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const b = new FactoryBootstrap(cfg(`http://127.0.0.1:${(server.address() as AddressInfo).port}`));
    await expect(b.ensureServiceUser(false)).rejects.toThrow(/sign-up failed: HTTP 403/); server.close();
  });
});
