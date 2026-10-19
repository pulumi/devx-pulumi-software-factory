import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ask, JevError, type Questions } from "../src/jevClient";

const fixture = readFileSync(new URL("./fixtures/choice-response.json", import.meta.url), "utf8");
const questions: Questions = {
  decision: { type: "choice", instructions: "Should we accept this issue?", criteria: { accept: "in scope", reject: "out of scope", needs_info: "vague" } },
  reason: { type: "choice", instructions: "Why?", criteria: { none: "n/a", duplicate: "dup", out_of_scope: "oos", underspecified: "vague" } },
};
const ok = () => new Response(fixture, { status: 200 });
const base = { apiKey: "k", sleep: async () => {} };

describe("jev client", () => {
  it("parses a recorded choice response and sends bearer auth", async () => {
    const f = vi.fn(async () => ok());
    const r = await ask({ ...base, fetchImpl: f as any }, "issue text", questions);
    expect(r.answers.decision).toMatchObject({ choice: "accept", confidence: 0.93 });
    const init = (f.mock.calls[0] as any)[1];
    expect(init.headers.Authorization).toBe("Bearer k");
    expect(JSON.parse(init.body)).toMatchObject({ model: "jev-latest", state: "issue text" });
  });
  it("retries 429 then succeeds", async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response("", { status: 429 })).mockResolvedValueOnce(ok());
    expect((await ask({ ...base, fetchImpl: f as any }, "x", questions)).model).toBe("jev-1.13.0");
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("does not retry 401", async () => {
    const f = vi.fn(async () => new Response("", { status: 401 }));
    await expect(ask({ ...base, fetchImpl: f as any }, "x", questions)).rejects.toMatchObject({ status: 401 });
    expect(f).toHaveBeenCalledTimes(1);
  });
  it("gives up after retries on timeout/network error", async () => {
    const f = vi.fn(async () => { throw new Error("boom"); });
    await expect(ask({ ...base, fetchImpl: f as any, retries: 2 }, "x", questions)).rejects.toThrow("boom");
    expect(f).toHaveBeenCalledTimes(3);
  });
  it("rejects an answer outside the enum", async () => {
    const bad = fixture.replace('"choice":"accept"', '"choice":"maybe"');
    const f = vi.fn(async () => new Response(bad, { status: 200 }));
    await expect(ask({ ...base, fetchImpl: f as any }, "x", questions)).rejects.toBeInstanceOf(JevError);
  });
});

import { FactoryClient } from "../src/factoryClient";
describe("FactoryClient triage", () => {
  const mk = (h: (u: string, i: any) => Response) => new FactoryClient({ baseUrl: "http://f", email: "e", password: "p", origin: "http://localhost:4111", fetchImpl: (async (u: string, i: any) => h(u, i)) as any });
  const login = (u: string) => u.endsWith("/sign-in/email") ? new Response(JSON.stringify({ token: "t" }), { status: 200 }) : undefined;
  it("treats a 409 stale transition as a normal rejected result", async () => {
    const c = mk((u) => login(u) ?? new Response(JSON.stringify({ result: { status: "rejected", code: "stale" } }), { status: 409 }));
    expect(await c.transition("p", { id: "w", title: "t", stages: ["intake"], revision: 1 }, "planning", "c", "rid")).toMatchObject({ status: "rejected", code: "stale" });
  });
  it("patchMetadata returns the new revision", async () => {
    const c = mk((u) => login(u) ?? new Response(JSON.stringify({ workItem: { revision: 7 } }), { status: 200 }));
    expect(await c.patchMetadata("w", { a: 1 })).toBe(7);
  });
  it("other HTTP errors still throw", async () => {
    const c = mk((u) => login(u) ?? new Response("{}", { status: 500 }));
    await expect(c.listWorkItems("p")).rejects.toThrow(/HTTP 500/);
  });
});
