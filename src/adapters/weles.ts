import { readFile } from 'node:fs/promises';
import { WelesClient } from '@wisent-ai/weles-client';
import type { AdapterExecution, AdapterResult, AdapterTelemetry, BenchmarkAdapter, BenchmarkSuite, JsonValue } from '../types.js';

const TERMINAL_STATUS: Readonly<Record<string, true>> = {
  succeeded: true,
  failed: true,
  cancelled: true,
};

export class AdapterFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AdapterFailure';
  }
}

export class WelesAdapter implements BenchmarkAdapter {
  readonly name = 'weles';
  readonly version = 'weles.task.current';

  private constructor(private readonly client: WelesClient) {}

  static async create(suite: BenchmarkSuite, options: {
    endpoint?: string | undefined;
    bearer?: string | undefined;
    organizationId?: string | undefined;
    receiptKeysFile?: string | undefined;
  }): Promise<WelesAdapter> {
    const endpoint = required(options.endpoint, 'WELES_API_BASE');
    const bearer = required(options.bearer, 'WELES_TOKEN');
    const organizationId = required(options.organizationId, 'WISENT_ORGANIZATION_ID');
    const requiresReceipt = suite.cases.some((item) => item.expected.receiptRequired);
    const receiptKeys = options.receiptKeysFile
      ? await readReceiptKeys(options.receiptKeysFile)
      : {};
    if (requiresReceipt && Object.keys(receiptKeys).length === 0) {
      throw new AdapterFailure('receipt-keys-required');
    }
    return new WelesAdapter(new WelesClient({
      endpoint,
      bearer,
      organizationId,
      allowedOrigins: [...new Set(suite.cases.map((item) => item.origin))],
      allowedActions: [...new Set(suite.cases.map((item) => item.action))],
      receiptKeys,
    }));
  }

  async execute(execution: AdapterExecution): Promise<AdapterResult> {
    const deadline = Date.now() + execution.timeoutMs;
    let response = await this.client.submit({
      origin: execution.benchmarkCase.origin,
      action: execution.benchmarkCase.action,
      input: execution.benchmarkCase.input,
      credentialRefs: execution.benchmarkCase.credentialRefs,
      evidencePolicy: execution.benchmarkCase.evidencePolicy,
      justification: execution.benchmarkCase.justification,
    }, {
      idempotencyKey: execution.idempotencyKey,
      signal: remainingSignal(deadline),
    });
    const taskId = taskIdentifier(response);
    let status = taskStatus(response);
    while (!TERMINAL_STATUS[status]) {
      if (!taskId) throw new AdapterFailure('missing-task-id');
      const delay = Math.min(execution.pollIntervalMs, deadline - Date.now());
      if (delay <= 0) throw new AdapterFailure('task-timeout');
      const sleeper = Promise.withResolvers<void>();
      setTimeout(sleeper.resolve, delay);
      await sleeper.promise;
      response = await this.client.get(taskId, { signal: remainingSignal(deadline) });
      status = taskStatus(response);
    }
    const output = responseOutput(response);
    return {
      ...(taskId ? { taskId } : {}),
      status,
      receiptVerified: Boolean(response.receipt),
      output,
      telemetry: telemetry(output),
    };
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new AdapterFailure(`missing-${name.toLowerCase()}`);
  return value.trim();
}

async function readReceiptKeys(path: string): Promise<Record<string, string>> {
  const value = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterFailure('invalid-receipt-keys');
  const entries = Object.entries(value);
  if (entries.length === 0 || entries.some(([key, publicKey]) => !key || typeof publicKey !== 'string' || !publicKey.trim())) {
    throw new AdapterFailure('invalid-receipt-keys');
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

function remainingSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AdapterFailure('task-timeout');
  return AbortSignal.timeout(remaining);
}

function taskIdentifier(response: Record<string, unknown>): string | undefined {
  for (const key of ['taskId', 'task_id', 'id']) {
    const value = response[key];
    if (typeof value === 'string' && value) return value;
  }
  return undefined;
}

function taskStatus(response: Record<string, unknown>): string {
  const direct = response.status ?? response.state;
  if (typeof direct === 'string' && direct) return direct.toLowerCase();
  const task = response.task;
  if (task && typeof task === 'object' && !Array.isArray(task)) {
    const nested = (task as Record<string, unknown>).status;
    if (typeof nested === 'string' && nested) return nested.toLowerCase();
  }
  throw new AdapterFailure('missing-task-status');
}

function responseOutput(response: Record<string, unknown>): JsonValue {
  const selected = response.result ?? response.output ?? response;
  return safeJson(selected);
}

function safeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== 'object') return null;
  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/(authorization|bearer|cookie|password|private.?key|secret|session|token)/i.test(key)) output[key] = safeJson(item);
  }
  return output;
}

function telemetry(output: JsonValue): AdapterTelemetry {
  if (!output || typeof output !== 'object' || Array.isArray(output)) return {};
  const root = output as Record<string, JsonValue>;
  const metrics = record(root.metrics);
  const captcha = record(root.captcha);
  return {
    ...booleanField(root.challengeFaced ?? captcha.challenge_faced, 'challengeFaced'),
    ...booleanField(root.challengeSolved ?? captcha.solved, 'challengeSolved'),
    ...numberField(root.browserSteps ?? metrics.browser_steps, 'browserSteps'),
    ...numberField(root.inputTokens ?? metrics.input_tokens, 'inputTokens'),
    ...numberField(root.outputTokens ?? metrics.output_tokens, 'outputTokens'),
    ...numberField(root.costUsd ?? metrics.cost_usd, 'costUsd'),
  };
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function booleanField(value: JsonValue | undefined, key: 'challengeFaced' | 'challengeSolved'): Partial<AdapterTelemetry> {
  return typeof value === 'boolean' ? { [key]: value } : {};
}

function numberField(value: JsonValue | undefined, key: 'browserSteps' | 'inputTokens' | 'outputTokens' | 'costUsd'): Partial<AdapterTelemetry> {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? { [key]: value } : {};
}
