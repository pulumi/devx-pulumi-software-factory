// Local live runner: loads the Jev key from agentcon/.env IN-PROCESS (never printed), then runs main.
//   FACTORY_INTERNAL_URL=... FACTORY_USER_EMAIL=... FACTORY_USER_PASSWORD=... TRIAGE_DRY_RUN=true npx tsx src/live.ts
import { readFileSync } from "node:fs";
const line = readFileSync(new URL("../../../../.env", import.meta.url), "utf8").split("\n").find((l) => l.startsWith("TYPESAFE_API_KEY="));
if (!line) throw new Error("TYPESAFE_API_KEY missing in .env");
process.env.JEV_API_KEY = line.slice("TYPESAFE_API_KEY=".length).replace(/^"|"$/g, "");
await import("./main.js");
