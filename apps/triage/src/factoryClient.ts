// Authenticated Factory API client for triage (better-auth email/password -> bearer token).
export interface WorkItem {
  id: string; title: string; stages: string[]; revision: number;
  metadata?: Record<string, unknown> | null; board?: string; createdAt?: string;
}
export interface FactoryClientOptions { baseUrl: string; email: string; password: string; origin: string; fetchImpl?: typeof fetch }
export type TransitionResult = { status: "accepted" | "rejected"; code?: string; revision?: number };

export class FactoryClient {
  private token?: string;
  constructor(private o: FactoryClientOptions) {}
  private get f() { return this.o.fetchImpl ?? fetch; }

  async login(): Promise<string> {
    const res = await this.f(`${this.o.baseUrl}/auth/api/sign-in/email`, {
      method: "POST", headers: { "content-type": "application/json", origin: this.o.origin },
      body: JSON.stringify({ email: this.o.email, password: this.o.password }),
    });
    if (!res.ok) throw new Error(`Factory sign-in failed: HTTP ${res.status}`);
    const t = ((await res.json()) as { token?: string }).token;
    if (!t) throw new Error("Factory sign-in returned no token");
    return (this.token = t);
  }

  private async req<T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token ?? (await this.login());
      const res = await this.f(`${this.o.baseUrl}${path}`, {
        method, headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) { this.token = undefined; continue; }
      if (!res.ok && !okStatuses.includes(res.status)) throw new Error(`Factory ${method} ${path} -> HTTP ${res.status}`);
      return (await res.json()) as T;
    }
    throw new Error(`Factory ${method} ${path} -> unauthorized`);
  }

  async listProjects(): Promise<Array<{ id: string; name: string }>> {
    return (await this.req<{ projects: Array<{ id: string; name: string }> }>("GET", "/web/factory/projects")).projects;
  }
  async listWorkItems(projectId: string): Promise<WorkItem[]> {
    return (await this.req<{ workItems: WorkItem[] }>("GET", `/web/factory/projects/${projectId}/work-items`)).workItems;
  }
  async transition(projectId: string, item: WorkItem, stage: string, cause: string, requestId: string): Promise<TransitionResult> {
    const r = await this.req<{ result: TransitionResult }>("POST", `/web/factory/projects/${projectId}/work-items/${item.id}/transition`,
      { board: item.board ?? "work", stage, expectedRevision: item.revision, requestId, cause }, [409]);   // 409 = stale revision: a normal, retryable outcome
    return r.result;
  }
  /** Returns the item's NEW revision (a PATCH bumps it, so later transitions must use it). */
  async patchMetadata(itemId: string, metadata: Record<string, unknown>): Promise<number | undefined> {
    return (await this.req<{ workItem: { revision?: number } }>("PATCH", `/web/factory/work-items/${itemId}`, { metadata })).workItem?.revision;
  }
}
