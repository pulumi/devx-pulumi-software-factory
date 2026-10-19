// One-time GitHub App setup for Factory's GitHub intake, via GitHub's *manifest flow*.
//   npx tsx github-app.ts serve     -> http://127.0.0.1:8787  (click "Create GitHub App"; GitHub redirects back here)
//   npx tsx github-app.ts secrets   -> store the credentials as Pulumi secrets on the factory stack
// The credentials land only in tools/github-app/.github-app.json (mode 600, git-ignored) and in Pulumi secrets; nothing is printed.
import { createServer } from "node:http";
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const FILE = join(here, ".github-app.json");
const PORT = 8787, FACTORY_ORIGIN = "http://localhost:4111";
const OWNER_ORG = process.env.GH_ORG ?? "";   // the GitHub org that will own the app ("" = your personal account)
const NAME = process.env.APP_NAME ?? (OWNER_ORG ? `${OWNER_ORG}-software-factory-example` : "software-factory-example");
const NEW_APP_URL = OWNER_ORG ? `https://github.com/organizations/${OWNER_ORG}/settings/apps/new` : "https://github.com/settings/apps/new";

const manifest = {
  name: NAME,
  url: FACTORY_ORIGIN,
  hook_attributes: { url: "https://example.invalid/web/github/webhook", active: false },   // webhooks off: no public URL needed
  redirect_url: `http://127.0.0.1:${PORT}/callback`,
  callback_urls: [`${FACTORY_ORIGIN}/auth/github/callback`],
  public: false,
  default_permissions: { contents: "write", issues: "write", pull_requests: "write", metadata: "read" },
  default_events: ["issues", "issue_comment", "pull_request", "pull_request_review", "pull_request_review_comment"],
};

const page = (body: string) => `<!doctype html><meta charset=utf-8><title>Factory GitHub App</title>
<body style="font:16px/1.5 system-ui;max-width:640px;margin:60px auto;padding:0 20px">${body}</body>`;

async function serve() {
  const state = Math.random().toString(36).slice(2);
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<h2>Create the Factory GitHub App</h2>
<p>This asks GitHub to create a <b>private</b> app named <code>${NAME}</code> owned by <b>${OWNER_ORG || "your personal account"}</b> with: Issues (read/write), Pull requests (read/write), Contents (read/write), Metadata (read). Webhooks are off.</p>
<form action="${NEW_APP_URL}?state=${state}" method="post">
<input type="hidden" name="manifest" value='${JSON.stringify(manifest).replace(/'/g, "&#39;")}'>
<button style="font-size:18px;padding:10px 18px">Create GitHub App under ${OWNER_ORG || "my account"}</button></form>`));
    } else if (url.pathname === "/callback" && url.searchParams.get("code")) {
      if (url.searchParams.get("state") !== state) { res.writeHead(400); res.end("state mismatch"); return; }
      const r = await fetch(`https://api.github.com/app-manifests/${url.searchParams.get("code")}/conversions`, { method: "POST", headers: { accept: "application/vnd.github+json", "user-agent": "agent-factory-demo" } });
      const app = await r.json() as any;
      if (!r.ok || !app.pem) { res.writeHead(502); res.end(page(`<h2>GitHub refused the code</h2><p>HTTP ${r.status}: ${String(app.message ?? "").slice(0, 200)}</p>`)); return; }
      writeFileSync(FILE, JSON.stringify({ id: app.id, slug: app.slug, client_id: app.client_id, client_secret: app.client_secret, webhook_secret: app.webhook_secret, pem: app.pem }), { mode: 0o600 });
      chmodSync(FILE, 0o600);
      console.log(`GitHub App created: ${app.slug} (id ${app.id}); credentials saved to ${FILE}`);
      res.writeHead(200, { "content-type": "text/html" });
      res.end(page(`<h2>Created: ${app.slug}</h2><p>Step 2: install it on the scratch repo only.</p>
<p><a href="https://github.com/apps/${app.slug}/installations/new">Install ${app.slug} on github.com</a> (choose <b>Only select repositories</b> and pick <code>agent-factory-demo</code>).</p><p>You can close this tab afterwards.</p>`));
    } else { res.writeHead(404); res.end("not found"); }
  });
  server.listen(PORT, "127.0.0.1", () => console.log(`open http://127.0.0.1:${PORT}`));
}

function secrets() {
  if (!existsSync(FILE)) throw new Error(`${FILE} not found; run 'serve' first`);
  const a = JSON.parse(readFileSync(FILE, "utf8"));
  const set = (key: string, value: string, secret: boolean) => {
    const args = ["config", "set", `factory:${key}`, ...(secret ? ["--secret"] : [])];
    const r = spawnSync("pulumi", args, { cwd: join(here, "../../stacks/factory"), input: value, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`pulumi config set ${key} failed: ${r.stderr.slice(0, 160)}`);
    console.log(`set factory:${key}${secret ? " (secret)" : ""}`);
  };
  set("githubAppId", String(a.id), false); set("githubAppSlug", a.slug, false); set("githubAppClientId", a.client_id, false);
  set("githubAppClientSecret", a.client_secret, true); set("githubAppWebhookSecret", a.webhook_secret, true);
  set("githubAppPrivateKey", a.pem.replace(/\n/g, "\\n"), true);   // Factory expects the PEM with escaped \n
}

const mode = process.argv[2];
if (mode === "serve") await serve(); else if (mode === "secrets") secrets(); else { console.error("usage: github-app.ts serve|secrets"); process.exit(2); }
