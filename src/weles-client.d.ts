declare module '@wisent-ai/weles-client' {
  export type WelesClientOptions = {
    endpoint: string;
    bearer: string;
    organizationId: string;
    allowedOrigins: string[];
    allowedActions: string[];
    receiptKeys?: Readonly<Record<string, string>>;
  };

  export class WelesClientError extends Error {
    readonly code: string;
    readonly details?: unknown;
  }

  export class WelesClient {
    constructor(options: WelesClientOptions);
    submit(request: {
      origin: string;
      action: string;
      input: Readonly<Record<string, unknown>>;
      credentialRefs?: string[];
      evidencePolicy?: string;
      justification: string;
    }, options?: { idempotencyKey?: string; signal?: AbortSignal }): Promise<Record<string, unknown>>;
    get(taskId: string, options?: { signal?: AbortSignal }): Promise<Record<string, unknown>>;
  }
}
