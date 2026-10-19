// Typed client for Jev (TypeSafe System One). Shapes follow docs.typesafe.ai; verify against a live call.
export type ChoiceQuestion = { type: "choice"; instructions: string; criteria: Record<string, string> };
export type Questions = Record<string, ChoiceQuestion>;

export interface ChoiceAnswer { type: "choice"; choice: string; confidence: number; probabilities?: Record<string, number> }
export interface JevResponse { model: string; answers: Record<string, ChoiceAnswer>; usage?: { input_tokens: number; output_tokens: number } }

export interface JevOptions {
  apiKey: string;
  endpoint?: string;     // default: TypeSafe direct
  model?: string;
  timeoutMs?: number;
  retries?: number;      // retries on 429/529/network/timeout
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export class JevError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export const DEFAULT_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export async function ask(opts: JevOptions, state: string, questions: Questions): Promise<JevResponse> {
  const f = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const retries = opts.retries ?? 2;
  const body = JSON.stringify({ model: opts.model ?? "jev-latest", state, questions });
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleep(250 * 2 ** (attempt - 1));
    try {
      const res = await f(opts.endpoint ?? DEFAULT_ENDPOINT, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.apiKey}`, "Content-Type": "application/json" },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 5000),
      });
      if (res.status === 429 || res.status === 529) { last = new JevError(`retryable ${res.status}`, res.status); continue; }
      if (!res.ok) throw new JevError(`Jev HTTP ${res.status}`, res.status); // 401/422: not retryable
      return validate(await res.json(), questions);
    } catch (e) {
      if (e instanceof JevError && e.status !== undefined) throw e;
      last = e; // network error or timeout: retry
    }
  }
  throw last instanceof Error ? last : new JevError("Jev request failed");
}

function validate(json: any, questions: Questions): JevResponse {
  if (!json || typeof json !== "object" || typeof json.answers !== "object") throw new JevError("malformed Jev response");
  for (const [key, q] of Object.entries(questions)) {
    const a = json.answers[key];
    if (!a || typeof a.choice !== "string" || typeof a.confidence !== "number") throw new JevError(`missing answer for ${key}`);
    if (!(a.choice in q.criteria)) throw new JevError(`answer for ${key} not in enum: ${a.choice}`);
  }
  return json as JevResponse;
}
