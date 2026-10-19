// Authenticated client for the Factory HTTP API (self-hosted better-auth: email/password -> bearer session token).
export interface FactoryClientOptions {
  baseUrl: string;
  email: string;
  password: string;
  /** Must equal the Factory's MASTRACODE_PUBLIC_URL or better-auth rejects sign-in with 403 INVALID_ORIGIN. */
  origin: string;
  fetchImpl?: typeof fetch;
}

export class FactoryClient {
  private token?: string;
  constructor(private o: FactoryClientOptions) {}

  private get f() { return this.o.fetchImpl ?? fetch; }

  async login(): Promise<string> {
    const res = await this.f(`${this.o.baseUrl}/auth/api/sign-in/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: this.o.origin },
      body: JSON.stringify({ email: this.o.email, password: this.o.password }),
    });
    if (!res.ok) throw new Error(`Factory sign-in failed: HTTP ${res.status}`);
    const token = ((await res.json()) as { token?: string }).token;
    if (!token) throw new Error("Factory sign-in returned no token");
    return (this.token = token);
  }

  /** GET /web/factory<path>; signs in lazily and once more if the token was rejected. */
  async get(path: string): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = this.token ?? (await this.login());
      const res = await this.f(`${this.o.baseUrl}/web/factory${path}`, { headers: { authorization: `Bearer ${token}` } });
      if (res.status === 401 && attempt === 0) { this.token = undefined; continue; }
      if (!res.ok) throw new Error(`Factory ${path} -> HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(`Factory ${path} -> unauthorized`);
  }
}
