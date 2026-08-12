import { AISdkClient, Stagehand } from '@browserbasehq/stagehand';
import { createOpenAI } from '@ai-sdk/openai';
import type { AdapterExecution, AdapterResult, BenchmarkAdapter } from '../types.js';
import { agentInstruction, parseAgentOutput, requiredUrl } from './agent-task.js';
import { AdapterFailure } from './weles.js';

export class StagehandAdapter implements BenchmarkAdapter {
  readonly name = 'stagehand';
  readonly version = '@browserbasehq/stagehand/3.4.0';

  constructor(private readonly options: {
    apiKey?: string;
    baseUrl?: string;
    model?: string;
    executablePath?: string;
  }) {
    if (!options.apiKey?.trim()) throw new AdapterFailure('missing-brama-api-key');
  }

  async execute(execution: AdapterExecution): Promise<AdapterResult> {
    const apiKey = this.options.apiKey?.trim();
    if (!apiKey) throw new AdapterFailure('missing-brama-api-key');
    const model = this.options.model?.trim() || 'weles/agent/primary';
    const baseURL = this.options.baseUrl?.trim() || 'http://127.0.0.1:8080/v1';
    const provider = createOpenAI({ apiKey, baseURL });
    const llmClient = new AISdkClient({
      model: provider.chat(model),
    });
    const stagehand = new Stagehand({
      env: 'LOCAL',
      llmClient,
      localBrowserLaunchOptions: {
        headless: true,
        ...(this.options.executablePath?.trim() ? { executablePath: this.options.executablePath.trim() } : {}),
      },
      disableAPI: true,
      experimental: true,
      disablePino: true,
      verbose: 0,
    });
    try {
      await stagehand.init();
      const page = await stagehand.context.awaitActivePage();
      await page.goto(requiredUrl(execution.benchmarkCase), { waitUntil: 'load', timeoutMs: execution.timeoutMs });
      const result = await stagehand.agent({ mode: 'dom' }).execute({
        instruction: agentInstruction(execution.benchmarkCase),
        maxSteps: positiveInteger(process.env.STAGEHAND_MAX_STEPS, 20),
        page,
        signal: AbortSignal.timeout(execution.timeoutMs),
      });
      if (!result.success || !result.completed) {
        throw new AdapterFailure('stagehand-run-failed', result.message);
      }
      return {
        status: 'succeeded',
        receiptVerified: false,
        output: parseAgentOutput(result.message),
        telemetry: {
          browserSteps: result.actions.length,
          ...(result.usage ? {
            inputTokens: result.usage.input_tokens,
            outputTokens: result.usage.output_tokens,
          } : {}),
        },
      };
    } finally {
      await stagehand.close({ force: true }).catch(() => undefined);
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new AdapterFailure('invalid-stagehand-max-steps');
  return parsed;
}
