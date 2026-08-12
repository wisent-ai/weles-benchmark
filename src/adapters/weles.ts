import type { AdapterExecution, AdapterResult, BenchmarkAdapter } from '../types.js';
import { agentInstruction, parseAgentOutput } from './agent-task.js';

export class AdapterFailure extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'AdapterFailure';
  }
}

export class WelesAdapter implements BenchmarkAdapter {
  readonly name = 'weles';
  readonly version = 'weles.builder.current';

  private constructor(
    private readonly endpoint: URL,
    private readonly bearer: string | undefined,
  ) {}

  static create(options: { endpoint?: string; bearer?: string }): WelesAdapter {
    const endpoint = required(options.endpoint, 'WELES_API_BASE');
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new AdapterFailure('invalid-weles-api-base');
    return new WelesAdapter(parsed, options.bearer?.trim() || undefined);
  }

  async execute(execution: AdapterExecution): Promise<AdapterResult> {
    const response = await fetch(new URL('/weles-builder', this.endpoint), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.bearer ? { Authorization: `Bearer ${this.bearer}` } : {}),
      },
      body: JSON.stringify({ instructions: agentInstruction(execution.benchmarkCase) }),
      signal: AbortSignal.timeout(execution.timeoutMs),
    });
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new AdapterFailure(`weles-http-${response.status}-invalid-json`);
    }
    if (!response.ok) throw new AdapterFailure(`weles-http-${response.status}`);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new AdapterFailure('weles-invalid-result');
    const source = payload as Record<string, unknown>;
    if (source.ok !== true) throw new AdapterFailure('weles-run-failed');
    const trajectory = record(source.trajectory_draft);
    const steps = Array.isArray(trajectory.steps) ? trajectory.steps.length : undefined;
    return {
      ...(typeof source.run_id === 'string' && source.run_id ? { taskId: source.run_id } : {}),
      status: 'succeeded',
      receiptVerified: false,
      output: parseAgentOutput(source.value),
      telemetry: {
        ...(steps === undefined ? {} : { browserSteps: steps }),
      },
    };
  }
}

function required(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new AdapterFailure(`missing-${name.toLowerCase()}`);
  return value.trim();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
