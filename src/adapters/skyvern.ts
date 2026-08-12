import { SkyvernClient, type Skyvern } from '@skyvern/client';
import type { AdapterExecution, AdapterResult, BenchmarkAdapter } from '../types.js';
import { agentInstruction, outputSchema, parseAgentOutput, requiredUrl } from './agent-task.js';
import { AdapterFailure } from './weles.js';

const TERMINAL = new Set(['completed', 'failed', 'terminated', 'timed_out', 'canceled']);

export class SkyvernAdapter implements BenchmarkAdapter {
  readonly name = 'skyvern';
  readonly version = '@skyvern/client/1.0.0';
  private readonly client: SkyvernClient;

  constructor(options: { apiKey?: string; baseUrl?: string }) {
    const apiKey = options.apiKey?.trim();
    const baseUrl = options.baseUrl?.trim();
    if (!apiKey && !baseUrl) throw new AdapterFailure('missing-skyvern-api-key');
    this.client = new SkyvernClient({
      ...(apiKey ? { apiKey } : {}),
      ...(baseUrl ? { baseUrl } : {}),
      maxRetries: 1,
    });
  }

  async execute(execution: AdapterExecution): Promise<AdapterResult> {
    const deadline = Date.now() + execution.timeoutMs;
    const requestSignal = remainingSignal(deadline);
    let response: Skyvern.TaskRunResponse | Skyvern.GetRunResponse = await this.client.runTask({
      'x-user-agent': 'weles-benchmark/0.1.0',
      body: {
        prompt: agentInstruction(execution.benchmarkCase),
        url: requiredUrl(execution.benchmarkCase),
        engine: skyvernEngine(),
        proxy_location: 'NONE',
        data_extraction_schema: outputSchema(execution.benchmarkCase),
        max_steps: positiveInteger(process.env.SKYVERN_MAX_STEPS, 20),
      },
    }, { abortSignal: requestSignal, timeoutInSeconds: Math.ceil(execution.timeoutMs / 1_000), maxRetries: 1 });

    while (!TERMINAL.has(response.status)) {
      const delay = Math.min(execution.pollIntervalMs, deadline - Date.now());
      if (delay <= 0) {
        await this.client.cancelRun(response.run_id).catch(() => undefined);
        throw new AdapterFailure('skyvern-timeout');
      }
      await new Promise((resolve) => setTimeout(resolve, delay));
      response = await this.client.getRun(response.run_id, { abortSignal: remainingSignal(deadline), maxRetries: 1 });
    }

    return {
      taskId: response.run_id,
      status: response.status === 'completed' ? 'succeeded' : response.status,
      receiptVerified: false,
      output: parseAgentOutput(response.output),
      telemetry: {},
    };
  }
}

function skyvernEngine(): 'skyvern-1.0' | 'skyvern-2.0' | 'openai-cua' | 'anthropic-cua' {
  const value = process.env.SKYVERN_ENGINE ?? 'skyvern-2.0';
  if (value === 'skyvern-1.0' || value === 'skyvern-2.0' || value === 'openai-cua' || value === 'anthropic-cua') return value;
  throw new AdapterFailure('invalid-skyvern-engine');
}

function remainingSignal(deadline: number): AbortSignal {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new AdapterFailure('skyvern-timeout');
  return AbortSignal.timeout(remaining);
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AdapterFailure('invalid-skyvern-max-steps');
  return parsed;
}
