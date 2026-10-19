// Live Jev smoke test. Run: npx tsx apps/triage/src/smoke.ts   (reads .env; never prints secrets)
import { readFileSync } from "node:fs";
import { ask, DEFAULT_ENDPOINT, type Questions } from "./jevClient";

const env: Record<string, string> = {};
for (const line of readFileSync(new URL("../../../../.env", import.meta.url), "utf8").split("\n")) {
  const m = line.match(/^(TYPESAFE_API_KEY|JEV_API_KEY|JEV_ENDPOINT)=(.*)$/); if (m) env[m[1]] = m[2].replace(/^"|"$/g, "");
}
const apiKey = env.TYPESAFE_API_KEY ?? env.JEV_API_KEY; if (!apiKey) throw new Error("TYPESAFE_API_KEY missing in .env");
const questions: Questions = {
  decision: { type: "choice", instructions: "Should this issue be accepted for the project described in the context?",
    criteria: { accept: "clear, in scope, actionable", reject: "out of scope or duplicate", needs_info: "too vague to act on" } },
};
const state = "Project goal: Build a simple web instant messenger in Vite and Node.JS using websockets.\n\nIssue: Add a typing indicator that shows when another user in the session is typing.";
const t0 = performance.now();
const r = await ask({ apiKey, endpoint: env.JEV_ENDPOINT || DEFAULT_ENDPOINT }, state, questions);
console.log(JSON.stringify({ ms: Math.round(performance.now() - t0), model: r.model, answer: r.answers.decision, usage: r.usage }, null, 2));
