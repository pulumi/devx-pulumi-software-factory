import type { Action } from "./policy";

export interface AuditRecord {
  key: string;                 // `${itemId}#${contentHash}`
  itemId: string; title: string; projectId: string;
  decision: string; confidence: number; reason: string;
  action: Action["kind"];
  applied: boolean;            // false in dry-run, or when the Factory write was rejected
  dryRun: boolean;
  at: string;                  // ISO time
  latencyMs?: number;
}

/** Items whose action is final are not re-evaluated until their content changes. `defer` is NOT final. */
export const isFinal = (r: AuditRecord) => r.action !== "defer" && r.applied;

export interface AuditStore {
  get(key: string): Promise<AuditRecord | undefined>;
  put(r: AuditRecord): Promise<void>;
}

export class InMemoryAuditStore implements AuditStore {
  readonly rows = new Map<string, AuditRecord>();
  async get(key: string) { return this.rows.get(key); }
  async put(r: AuditRecord) { this.rows.set(r.key, r); }
}

/** DynamoDB-backed audit trail (table: partition key `key`). Lazily imports the AWS SDK so tests need no AWS. */
export class DynamoAuditStore implements AuditStore {
  constructor(private table: string, private region = "us-east-1") {}
  private async client() {
    const { DynamoDBClient } = await import("@aws-sdk/client-dynamodb");
    const { DynamoDBDocumentClient } = await import("@aws-sdk/lib-dynamodb");
    return DynamoDBDocumentClient.from(new DynamoDBClient({ region: this.region }), { marshallOptions: { removeUndefinedValues: true } });
  }
  async get(key: string) {
    const { GetCommand } = await import("@aws-sdk/lib-dynamodb");
    const out = await (await this.client()).send(new GetCommand({ TableName: this.table, Key: { key } }));
    return out.Item as AuditRecord | undefined;
  }
  async put(r: AuditRecord) {
    const { PutCommand } = await import("@aws-sdk/lib-dynamodb");
    await (await this.client()).send(new PutCommand({ TableName: this.table, Item: r }));
  }
}
