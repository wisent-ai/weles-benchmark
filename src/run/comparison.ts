import type { BenchmarkRun, Comparison } from '../types.js';

export function compareRuns(baseline: BenchmarkRun, candidate: BenchmarkRun): Comparison {
  if (baseline.suite.sha256 !== candidate.suite.sha256) throw new Error('runs use different suite revisions');
  return {
    schema: 'weles.benchmark.comparison.v1',
    baseline: { runId: baseline.runId, adapter: baseline.adapter.name },
    candidate: { runId: candidate.runId, adapter: candidate.adapter.name },
    delta: {
      successRatePoints: rounded((candidate.metrics.successRate - baseline.metrics.successRate) * 100),
      receiptRatePoints: rounded((candidate.metrics.receiptRate - baseline.metrics.receiptRate) * 100),
      p50DurationRatio: ratio(candidate.metrics.durationMs.p50, baseline.metrics.durationMs.p50),
      p95DurationRatio: ratio(candidate.metrics.durationMs.p95, baseline.metrics.durationMs.p95),
      repeatSpeedupRatio: candidate.metrics.repeatSpeedup === undefined || baseline.metrics.repeatSpeedup === undefined
        ? null
        : ratio(candidate.metrics.repeatSpeedup, baseline.metrics.repeatSpeedup),
    },
  };
}

function ratio(candidate: number, baseline: number): number | null {
  return baseline === 0 ? null : rounded(candidate / baseline);
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
