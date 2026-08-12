import { spawn } from 'node:child_process';
import type { AdapterExecution, AdapterResult, AdapterTelemetry, BenchmarkAdapter, JsonValue } from '../types.js';
import { AdapterFailure } from './weles.js';

const OUTPUT_LIMIT = 1024 * 1024;

export class CommandAdapter implements BenchmarkAdapter {
  readonly name: string;
  readonly version: string;

  constructor(
    private readonly executable: string,
    private readonly argumentsList: string[],
    private readonly environmentNames: string[],
    identity?: string,
  ) {
    this.name = identity ?? 'command';
    this.version = 'weles.benchmark.adapter-result.v1';
  }

  async execute(execution: AdapterExecution): Promise<AdapterResult> {
    const environment = minimalEnvironment(this.environmentNames);
    const child = spawn(this.executable, this.argumentsList, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: environment,
      shell: false,
    });
    let stdout = Buffer.alloc(0);
    let stderr = Buffer.alloc(0);
    let overflow = false;
    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length + chunk.length > OUTPUT_LIMIT) {
        overflow = true;
        child.kill('SIGTERM');
        return;
      }
      stdout = Buffer.concat([stdout, chunk]);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length + chunk.length > OUTPUT_LIMIT) {
        overflow = true;
        child.kill('SIGTERM');
        return;
      }
      stderr = Buffer.concat([stderr, chunk]);
    });
    const completion = Promise.withResolvers<number | null>();
    let timedOut = false;
    let escalation: NodeJS.Timeout | undefined;
    child.once('error', () => completion.reject(new AdapterFailure('command-start-failed')));
    child.once('close', (code) => completion.resolve(code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(`${JSON.stringify({
      schema: 'weles.benchmark.task.v1',
      idempotencyKey: execution.idempotencyKey,
      timeoutMs: execution.timeoutMs,
      case: execution.benchmarkCase,
    })}\n`);
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    }, execution.timeoutMs);
    const code = await completion.promise.finally(() => {
      clearTimeout(timer);
      clearTimeout(escalation);
    });
    if (overflow) throw new AdapterFailure('command-output-too-large');
    if (code !== 0) {
      const detail = stderr.toString('utf8').trim().slice(-4_000) || undefined;
      throw new AdapterFailure(timedOut ? 'command-timeout' : code === null ? 'command-signal' : `command-exit-${code}`, detail);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout.toString('utf8'));
    } catch {
      throw new AdapterFailure('command-invalid-json');
    }
    return adapterResult(parsed);
  }
}

function minimalEnvironment(names: string[]): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR', 'LANG', ...names]) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AdapterFailure('command-invalid-environment-name');
    const value = process.env[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

function adapterResult(value: unknown): AdapterResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterFailure('command-invalid-result');
  const source = value as Record<string, unknown>;
  if (source.schema !== 'weles.benchmark.adapter-result.v1') throw new AdapterFailure('command-unsupported-schema');
  if (typeof source.status !== 'string' || !source.status.trim()) throw new AdapterFailure('command-missing-status');
  if (source.receiptVerified !== undefined && typeof source.receiptVerified !== 'boolean') {
    throw new AdapterFailure('command-invalid-receipt-state');
  }
  return {
    ...(typeof source.taskId === 'string' && source.taskId ? { taskId: source.taskId } : {}),
    status: source.status.toLowerCase(),
    receiptVerified: source.receiptVerified === true,
    output: safeJson(source.output ?? {}),
    telemetry: adapterTelemetry(source.telemetry),
  };
}

function adapterTelemetry(value: unknown): AdapterTelemetry {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AdapterFailure('command-invalid-telemetry');
  const source = value as Record<string, unknown>;
  return {
    ...optionalBoolean(source.challengeFaced, 'challengeFaced'),
    ...optionalBoolean(source.challengeSolved, 'challengeSolved'),
    ...optionalNumber(source.browserSteps, 'browserSteps'),
    ...optionalNumber(source.inputTokens, 'inputTokens'),
    ...optionalNumber(source.outputTokens, 'outputTokens'),
    ...optionalNumber(source.costUsd, 'costUsd'),
  };
}

function optionalBoolean(value: unknown, key: 'challengeFaced' | 'challengeSolved'): Partial<AdapterTelemetry> {
  if (value === undefined) return {};
  if (typeof value !== 'boolean') throw new AdapterFailure(`command-invalid-${key}`);
  return { [key]: value };
}

function optionalNumber(value: unknown, key: 'browserSteps' | 'inputTokens' | 'outputTokens' | 'costUsd'): Partial<AdapterTelemetry> {
  if (value === undefined) return {};
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new AdapterFailure(`command-invalid-${key}`);
  return { [key]: value };
}

function safeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== 'object') return null;
  const result: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) result[key] = safeJson(item);
  return result;
}
