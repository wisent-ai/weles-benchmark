import type {
  BenchmarkMetrics,
  BenchmarkSample,
  BenchmarkThresholds,
  CaseMetrics,
  Distribution,
  Qualification,
} from './types.js';

export function aggregateMetrics(samples: BenchmarkSample[]): BenchmarkMetrics {
  if (samples.length === 0) throw new Error('cannot aggregate an empty benchmark run');
  const caseIds = [...new Set(samples.map((sample) => sample.caseId))].sort();
  const cases = caseIds.map((caseId) => caseMetrics(caseId, samples.filter((sample) => sample.caseId === caseId)));
  const challengeObserved = samples.filter((sample) => sample.telemetry.challengeFaced !== undefined);
  const challengeFaced = challengeObserved.filter((sample) => sample.telemetry.challengeFaced === true);
  const challengeSolvedObserved = challengeFaced.filter((sample) => sample.telemetry.challengeSolved !== undefined);
  const repeatValues = cases.flatMap((item) => item.repeatSpeedup === undefined ? [] : [item.repeatSpeedup]);
  return {
    samples: samples.length,
    successes: samples.filter((sample) => sample.success).length,
    successRate: rate(samples.filter((sample) => sample.success).length, samples.length),
    receiptRate: rate(samples.filter((sample) => sample.receiptVerified).length, samples.length),
    durationMs: distribution(samples.map((sample) => sample.durationMs)),
    ...(challengeObserved.length === 0 ? {} : {
      challengeFacedRate: rate(challengeFaced.length, challengeObserved.length),
    }),
    ...(challengeSolvedObserved.length === 0 ? {} : {
      challengeSolvedRate: rate(challengeSolvedObserved.filter((sample) => sample.telemetry.challengeSolved === true).length, challengeSolvedObserved.length),
    }),
    ...(repeatValues.length === 0 ? {} : { repeatSpeedup: rounded(median(repeatValues)) }),
    cases,
  };
}

function caseMetrics(caseId: string, samples: BenchmarkSample[]): CaseMetrics {
  const ordered = [...samples].sort((left, right) => left.repetition - right.repetition);
  const first = ordered.find((sample) => sample.repetition === 0);
  const repeats = ordered.filter((sample) => sample.repetition > 0);
  const repeatSpeedup = first && repeats.length > 0 && median(repeats.map((sample) => sample.durationMs)) > 0
    ? first.durationMs / median(repeats.map((sample) => sample.durationMs))
    : undefined;
  return {
    caseId,
    samples: samples.length,
    successRate: rate(samples.filter((sample) => sample.success).length, samples.length),
    receiptRate: rate(samples.filter((sample) => sample.receiptVerified).length, samples.length),
    durationMs: distribution(samples.map((sample) => sample.durationMs)),
    ...(repeatSpeedup === undefined ? {} : { repeatSpeedup: rounded(repeatSpeedup) }),
  };
}

export function qualify(metrics: BenchmarkMetrics, thresholds: BenchmarkThresholds): Qualification {
  const violations: string[] = [];
  if (thresholds.successRateMin !== undefined && metrics.successRate < thresholds.successRateMin) {
    violations.push(`successRate ${metrics.successRate} < ${thresholds.successRateMin}`);
  }
  if (thresholds.receiptRateMin !== undefined && metrics.receiptRate < thresholds.receiptRateMin) {
    violations.push(`receiptRate ${metrics.receiptRate} < ${thresholds.receiptRateMin}`);
  }
  if (thresholds.p95DurationMsMax !== undefined && metrics.durationMs.p95 > thresholds.p95DurationMsMax) {
    violations.push(`p95DurationMs ${metrics.durationMs.p95} > ${thresholds.p95DurationMsMax}`);
  }
  return { passed: violations.length === 0, violations };
}

function distribution(values: number[]): Distribution {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    min: rounded(sorted[0] ?? 0),
    p50: rounded(percentile(sorted, 0.5)),
    p95: rounded(percentile(sorted, 0.95)),
    p99: rounded(percentile(sorted, 0.99)),
    max: rounded(sorted.at(-1) ?? 0),
    mean: rounded(values.reduce((total, value) => total + value, 0) / values.length),
  };
}

function percentile(sorted: number[], quantile: number): number {
  if (sorted.length === 0) return 0;
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  const lowerValue = sorted[lower] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + (upperValue - lowerValue) * (index - lower);
}

function median(values: number[]): number {
  return percentile([...values].sort((left, right) => left - right), 0.5);
}

function rate(numerator: number, denominator: number): number {
  return denominator === 0 ? 0 : rounded(numerator / denominator);
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
