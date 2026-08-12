import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { aggregateMetrics, qualify } from './metrics.js';
import { jsonPointer } from './suite.js';
import type {
  Assertion,
  BenchmarkAdapter,
  BenchmarkCase,
  BenchmarkRun,
  BenchmarkSample,
  BenchmarkSuite,
  JsonValue,
} from './types.js';

export async function runBenchmark(options: {
  suite: BenchmarkSuite;
  suiteSha256: string;
  adapter: BenchmarkAdapter;
  repetitions?: number;
  concurrency?: number;
}): Promise<BenchmarkRun> {
  const runId = randomUUID();
  const startedAt = new Date().toISOString();
  const repetitions = options.repetitions ?? options.suite.defaults.repetitions;
  const concurrency = options.concurrency ?? options.suite.defaults.concurrency;
  const executions = options.suite.cases.flatMap((benchmarkCase) =>
    Array.from({ length: repetitions }, (_, repetition) => ({ benchmarkCase, repetition })),
  );
  const samples: BenchmarkSample[] = [];
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, executions.length) }, async () => {
    while (next < executions.length) {
      const current = executions[next];
      next += 1;
      if (!current) return;
      samples.push(await executeSample({
        adapter: options.adapter,
        benchmarkCase: current.benchmarkCase,
        repetition: current.repetition,
        runId,
        timeoutMs: options.suite.defaults.timeoutMs,
        pollIntervalMs: options.suite.defaults.pollIntervalMs,
      }));
    }
  });
  await Promise.all(workers);
  samples.sort((left, right) => left.caseId.localeCompare(right.caseId) || left.repetition - right.repetition);
  const metrics = aggregateMetrics(samples);
  return {
    schema: 'weles.benchmark.run.v1',
    runId,
    suite: {
      name: options.suite.name,
      version: options.suite.version,
      sha256: options.suiteSha256,
    },
    adapter: {
      name: options.adapter.name,
      version: options.adapter.version,
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
    },
    startedAt,
    completedAt: new Date().toISOString(),
    samples,
    metrics,
    qualification: qualify(metrics, options.suite.thresholds),
  };
}

async function executeSample(options: {
  adapter: BenchmarkAdapter;
  benchmarkCase: BenchmarkCase;
  repetition: number;
  runId: string;
  timeoutMs: number;
  pollIntervalMs: number;
}): Promise<BenchmarkSample> {
  const started = performance.now();
  try {
    const result = await options.adapter.execute({
      benchmarkCase: options.benchmarkCase,
      idempotencyKey: `${options.runId}:${options.benchmarkCase.id}:${options.repetition}`,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    });
    const assertionResults = options.benchmarkCase.expected.assertions.map((item) => evaluateAssertion(result.output, item));
    const assertionsPassed = assertionResults.filter(Boolean).length;
    const acceptedStatus = options.benchmarkCase.expected.acceptedStatuses.includes(result.status);
    const acceptedReceipt = !options.benchmarkCase.expected.receiptRequired || result.receiptVerified;
    const success = acceptedStatus && acceptedReceipt && assertionsPassed === assertionResults.length;
    return {
      caseId: options.benchmarkCase.id,
      caseTitle: options.benchmarkCase.title,
      tags: options.benchmarkCase.tags,
      repetition: options.repetition,
      status: result.status,
      success,
      durationMs: elapsed(started),
      receiptVerified: result.receiptVerified,
      assertionsPassed,
      assertionsTotal: assertionResults.length,
      ...(success ? {} : { failureCode: failureCode(acceptedStatus, acceptedReceipt, assertionsPassed, assertionResults.length) }),
      telemetry: result.telemetry,
    };
  } catch (error) {
    const failureDetail = safeErrorDetail(error);
    return {
      caseId: options.benchmarkCase.id,
      caseTitle: options.benchmarkCase.title,
      tags: options.benchmarkCase.tags,
      repetition: options.repetition,
      status: 'adapter_error',
      success: false,
      durationMs: elapsed(started),
      receiptVerified: false,
      assertionsPassed: 0,
      assertionsTotal: options.benchmarkCase.expected.assertions.length,
      failureCode: safeErrorCode(error),
      ...(failureDetail === undefined ? {} : { failureDetail }),
      telemetry: {},
    };
  }
}

function elapsed(started: number): number {
  return Math.round((performance.now() - started) * 100) / 100;
}

function failureCode(acceptedStatus: boolean, acceptedReceipt: boolean, assertionsPassed: number, assertionsTotal: number): string {
  if (!acceptedStatus) return 'unexpected-status';
  if (!acceptedReceipt) return 'receipt-missing';
  if (assertionsPassed !== assertionsTotal) return 'assertion-failed';
  return 'unsuccessful';
}

function safeErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = Object.getOwnPropertyDescriptor(error, 'code')?.value;
    if (typeof code === 'string' && /^[a-z0-9_-]{1,80}$/i.test(code)) return code;
  }
  if (error instanceof Error && /^[a-z0-9_-]{1,80}$/i.test(error.message)) return error.message;
  return 'adapter-failed';
}

function safeErrorDetail(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('detail' in error)) return undefined;
  const detail = Object.getOwnPropertyDescriptor(error, 'detail')?.value;
  if (typeof detail !== 'string' || !detail.trim()) return undefined;
  const redacted = detail
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\b(api[_-]?key|token|authorization)(\s*[:=]\s*)([^\s,;]+)/gi, '$1$2[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{10,}(?:\.[A-Za-z0-9_-]{10,})?\b/g, '[redacted-token]')
    .replace(/\s+/g, ' ')
    .trim();
  return redacted ? redacted.slice(0, 1_000) : undefined;
}

function evaluateAssertion(output: JsonValue, assertion: Assertion): boolean {
  const actual = jsonPointer(output, assertion.path);
  if (assertion.operator === 'exists') return actual !== undefined;
  if (assertion.operator === 'equals') return canonical(actual) === canonical(assertion.value);
  if (typeof actual === 'string' && typeof assertion.value === 'string') return actual.includes(assertion.value);
  if (Array.isArray(actual)) return actual.some((item) => canonical(item) === canonical(assertion.value));
  return false;
}

function canonical(value: JsonValue | undefined): string {
  if (value === undefined) return 'undefined';
  if (!value || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}
