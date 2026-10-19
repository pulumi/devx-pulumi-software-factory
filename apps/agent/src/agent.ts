import { readFileSync } from "node:fs";
import { Agent } from "@mastra/core/agent";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { FactoryClient } from "./factoryClient";

export interface AgentEnv {
  LLM_BASE_URL: string;       // OpenAI-compatible base, ending in /v1
  LLM_MODEL: string;
  LLM_API_KEY?: string;       // Dynamo does not enforce one; a dummy is sent
  LOOP_PROMPT_PATH?: string;  // path to factory-prompt.md
  FACTORY_INTERNAL_URL?: string;
  FACTORY_USER_EMAIL?: string;     // service account (better-auth)
  FACTORY_USER_PASSWORD?: string;
  FACTORY_ORIGIN?: string;         // = Factory MASTRACODE_PUBLIC_URL
}

export function readEnv(env: NodeJS.ProcessEnv = process.env): AgentEnv {
  const need = (k: string) => { const v = env[k]; if (!v) throw new Error(`missing required env ${k}`); return v; };
  return { LLM_BASE_URL: need("LLM_BASE_URL"), LLM_MODEL: need("LLM_MODEL"), LLM_API_KEY: env.LLM_API_KEY,
           LOOP_PROMPT_PATH: env.LOOP_PROMPT_PATH, FACTORY_INTERNAL_URL: env.FACTORY_INTERNAL_URL,
           FACTORY_USER_EMAIL: env.FACTORY_USER_EMAIL, FACTORY_USER_PASSWORD: env.FACTORY_USER_PASSWORD, FACTORY_ORIGIN: env.FACTORY_ORIGIN };
}

/** Holds the coding-loop prompt; `reload()` re-reads the file (wired to SIGHUP). */
export class PromptStore {
  private text = "";
  constructor(private path?: string) { this.reload(); }
  /** Re-read the file. A missing file (ConfigMap not created yet by bootstrap) leaves an empty brief instead of crashing. */
  reload(): string {
    if (!this.path) return this.text;
    try { this.text = readFileSync(this.path, "utf8").trim(); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; this.text = ""; }
    return this.text;
  }
  get(): string { return this.text; }
}

const BASE_INSTRUCTIONS =
  "You are a coding agent working inside a software factory. Work from the project brief below. " +
  "Use the available tools to inspect the factory before acting, and never invent tool results.";

export function factoryTools(client: Pick<FactoryClient, "get"> | undefined) {
  const get = async (path: string) => {
    if (!client) throw new Error("Factory client is not configured (FACTORY_INTERNAL_URL / FACTORY_USER_EMAIL / FACTORY_USER_PASSWORD)");
    return client.get(path);
  };
  return {
    factory_list_projects: createTool({
      id: "factory_list_projects",
      description: "List Mastra Factory projects (read-only).",
      inputSchema: z.object({}),
      execute: async () => get("/projects"),
    }),
    factory_list_work_items: createTool({
      id: "factory_list_work_items",
      description: "List work items (and running sessions) for a Factory project (read-only).",
      inputSchema: z.object({ projectId: z.string() }),
      execute: async ({ projectId }: { projectId: string }) => get(`/projects/${encodeURIComponent(projectId)}/work-items`),
    }),
  };
}

export function clientFromEnv(env: AgentEnv, fetchImpl: typeof fetch = fetch): FactoryClient | undefined {
  if (!env.FACTORY_INTERNAL_URL || !env.FACTORY_USER_EMAIL || !env.FACTORY_USER_PASSWORD) return undefined;
  return new FactoryClient({ baseUrl: env.FACTORY_INTERNAL_URL, email: env.FACTORY_USER_EMAIL, password: env.FACTORY_USER_PASSWORD,
                             origin: env.FACTORY_ORIGIN ?? "http://localhost:4111", fetchImpl });
}

export function createCoderAgent(env: AgentEnv, prompt: PromptStore, fetchImpl: typeof fetch = fetch) {
  return new Agent({
    id: "factory-coder",
    name: "factory-coder",
    instructions: () => `${BASE_INSTRUCTIONS}\n\n## Project brief\n${prompt.get()}`,
    // Mastra custom-endpoint form: `url` is the OpenAI-compatible base URL.
    model: { id: `custom/${env.LLM_MODEL}`, url: env.LLM_BASE_URL, apiKey: env.LLM_API_KEY ?? "none" } as any,
    tools: factoryTools(clientFromEnv(env, fetchImpl)),
  });
}
