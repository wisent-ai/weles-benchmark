export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Assertion = {
  path: string;
  operator: 'equals' | 'exists' | 'includes';
  value?: JsonValue;
};

export type BenchmarkCase = {
  id: string;
  title: string;
  origin: string;
  action: string;
  input: JsonObject;
  justification: string;
  credentialRefs: string[];
  evidencePolicy: string;
  tags: string[];
  expected: {
    acceptedStatuses: string[];
    receiptRequired: boolean;
    assertions: Assertion[];
  };
};

export type BenchmarkThresholds = {
  successRateMin?: number;
  receiptRateMin?: number;
  p95DurationMsMax?: number;
};

export type BenchmarkSuite = {
  schema: 'weles.benchmark.suite.v1';
  name: string;
  version: string;
  description: string;
  defaults: {
    repetitions: number;
    concurrency: number;
    timeoutMs: number;
    pollIntervalMs: number;
  };
  thresholds: BenchmarkThresholds;
  cases: BenchmarkCase[];
};

export type AdapterTelemetry = {
  challengeFaced?: boolean;
  challengeSolved?: boolean;
  browserSteps?: number;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
};

export type AdapterResult = {
  taskId?: string;
  status: string;
  receiptVerified: boolean;
  output: JsonValue;
  telemetry: AdapterTelemetry;
};

export type AdapterExecution = {
  benchmarkCase: BenchmarkCase;
  idempotencyKey: string;
  timeoutMs: number;
  pollIntervalMs: number;
};

export interface BenchmarkAdapter {
  readonly name: string;
  readonly version: string;
  execute(execution: AdapterExecution): Promise<AdapterResult>;
}

export type BenchmarkSample = {
  caseId: string;
  caseTitle: string;
  tags: string[];
  repetition: number;
  status: string;
  success: boolean;
  durationMs: number;
  receiptVerified: boolean;
  assertionsPassed: number;
  assertionsTotal: number;
  failureCode?: string;
  telemetry: AdapterTelemetry;
};

export type Distribution = {
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
};

export type CaseMetrics = {
  caseId: string;
  samples: number;
  successRate: number;
  receiptRate: number;
  durationMs: Distribution;
  repeatSpeedup?: number;
};

export type BenchmarkMetrics = {
  samples: number;
  successes: number;
  successRate: number;
  receiptRate: number;
  durationMs: Distribution;
  challengeFacedRate?: number;
  challengeSolvedRate?: number;
  repeatSpeedup?: number;
  cases: CaseMetrics[];
};

export type Qualification = {
  passed: boolean;
  violations: string[];
};

export type BenchmarkRun = {
  schema: 'weles.benchmark.run.v1';
  runId: string;
  suite: {
    name: string;
    version: string;
    sha256: string;
  };
  adapter: {
    name: string;
    version: string;
  };
  environment: {
    node: string;
    platform: string;
    arch: string;
  };
  startedAt: string;
  completedAt: string;
  samples: BenchmarkSample[];
  metrics: BenchmarkMetrics;
  qualification: Qualification;
};

export type Comparison = {
  schema: 'weles.benchmark.comparison.v1';
  baseline: { runId: string; adapter: string };
  candidate: { runId: string; adapter: string };
  delta: {
    successRatePoints: number;
    receiptRatePoints: number;
    p50DurationRatio: number | null;
    p95DurationRatio: number | null;
    repeatSpeedupRatio: number | null;
  };
};
