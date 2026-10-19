// Pure(ish) core of scripts/bootstrap.ts: everything that talks HTTP to Factory, so it can be tested against a fake server.

export interface FactoryConfig {
  baseUrl: string; email: string; password: string; origin: string;
  llmBaseUrl: string; llmModel: string; providerName?: string; packName?: string; projectName: string; fetchImpl?: typeof fetch;
}
export interface Change { what: string; detail?: string }

export class FactoryBootstrap {
  private token?: string;
  readonly changes: Change[] = [];
  constructor(private c: FactoryConfig) {}
  private get f() { return this.c.fetchImpl ?? fetch; }
  private note(what: string, detail?: string) { this.changes.push({ what, detail }); }

  private async call(method: string, path: string, body?: unknown, auth = true): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { "content-type": "application/json", origin: this.c.origin };
    if (auth) headers.authorization = `Bearer ${this.token}`;
    const res = await this.f(`${this.c.baseUrl}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    let json: any = undefined; try { json = await res.json(); } catch { /* non-JSON */ }
    return { status: res.status, json };
  }

  /** Sign in; create the service account first if it does not exist. */
  async ensureServiceUser(dryRun: boolean): Promise<void> {
    const creds = { email: this.c.email, password: this.c.password };
    let r = await this.call("POST", "/auth/api/sign-in/email", creds, false);
    if (r.status !== 200) {
      if (dryRun) { this.note("would create service account", this.c.email); return; }
      const up = await this.call("POST", "/auth/api/sign-up/email", { ...creds, name: "agent-svc" }, false);
      if (up.status !== 200) throw new Error(`sign-up failed: HTTP ${up.status}`);
      this.note("created service account", this.c.email);
      r = await this.call("POST", "/auth/api/sign-in/email", creds, false);
      if (r.status !== 200) throw new Error(`sign-in after sign-up failed: HTTP ${r.status}`);
    }
    this.token = r.json?.token;
  }

  async ensureModel(dryRun: boolean): Promise<string> {
    const name = this.c.providerName ?? "agent-factory-llm";
    const modelId = `${name}/${this.c.llmModel}`;
    const list = await this.call("GET", "/web/config/custom-providers");
    const cur = (list.json?.providers ?? []).find((p: any) => p.name === name);
    const same = cur && cur.url === this.c.llmBaseUrl && (cur.models ?? []).includes(this.c.llmModel);
    if (!same) {
      if (dryRun) this.note("would upsert custom provider", `${name} -> ${this.c.llmBaseUrl} [${this.c.llmModel}]`);
      else {
        const r = await this.call("POST", "/web/config/custom-providers", { name, url: this.c.llmBaseUrl, apiKey: "none", models: [this.c.llmModel] });
        if (r.status !== 200) throw new Error(`custom provider upsert failed: HTTP ${r.status}`);
        this.note("upserted custom provider", `${name} -> ${this.c.llmBaseUrl}`);
      }
    }
    const packName = this.c.packName ?? "agent-factory";
    const packs = await this.call("GET", "/web/config/model-packs");
    let pack = (packs.json?.packs ?? []).find((p: any) => p.name === packName);
    const wants = { build: modelId, plan: modelId, fast: modelId };
    const packOk = pack && JSON.stringify(pack.models) === JSON.stringify(wants);
    if (!packOk) {
      if (dryRun) { this.note("would create/update model pack", packName); return modelId; }
      const r = await this.call("POST", "/web/config/model-packs", { name: packName, models: wants });
      if (r.status !== 200) throw new Error(`model pack create failed: HTTP ${r.status}`);
      pack = r.json.pack; this.note("saved model pack", packName);
    }
    // GET /model-packs reports `activePackId` itself (the /model-packs/active route serves an HTML page, not JSON).
    const activeId = packOk ? packs.json?.activePackId : undefined;
    if (activeId !== pack?.id && !dryRun) {
      const r = await this.call("POST", `/web/config/model-packs/${encodeURIComponent(pack.id)}/activate`, {});
      if (r.status !== 200) throw new Error(`model pack activate failed: HTTP ${r.status}`);
      this.note("activated model pack", packName);
    }
    return modelId;
  }

  async ensureProject(modelId: string, dryRun: boolean): Promise<string | undefined> {
    const list = await this.call("GET", "/web/factory/projects");
    let proj = (list.json?.projects ?? []).find((p: any) => p.name === this.c.projectName);
    if (!proj) {
      if (dryRun) { this.note("would create project", this.c.projectName); return undefined; }
      const r = await this.call("POST", "/web/factory/projects", { name: this.c.projectName, description: "agent-factory end-to-end demo" });
      if (r.status !== 200 && r.status !== 201) throw new Error(`project create failed: HTTP ${r.status}`);
      proj = r.json.project; this.note("created project", this.c.projectName);
    }
    if (proj.defaultModelId !== modelId) {
      if (dryRun) this.note("would set project default model", modelId);
      else {
        const r = await this.call("PATCH", `/web/factory/projects/${proj.id}`, { defaultModelId: modelId });
        if (r.status !== 200) throw new Error(`project update failed: HTTP ${r.status}`);
        this.note("set project default model", modelId);
      }
    }
    return proj.id;
  }
}
