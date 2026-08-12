import type { BenchmarkRun, Comparison } from './types.js';

export function markdownReport(run: BenchmarkRun): string {
  const lines = [
    `# ${run.suite.name} ${run.suite.version}`,
    '',
    `- Run: \`${run.runId}\``,
    `- Adapter: \`${run.adapter.name}\` (\`${run.adapter.version}\`)`,
    `- Suite SHA-256: \`${run.suite.sha256}\``,
    `- Started: ${run.startedAt}`,
    `- Completed: ${run.completedAt}`,
    `- Qualification: **${run.qualification.passed ? 'PASS' : 'FAIL'}**`,
    '',
    '## Measurements',
    '',
    '| Measurement | Value |',
    '|---|---:|',
    `| Samples | ${run.metrics.samples} |`,
    `| Success rate | ${percent(run.metrics.successRate)} |`,
    `| Verified receipt rate | ${percent(run.metrics.receiptRate)} |`,
    `| Duration p50 | ${milliseconds(run.metrics.durationMs.p50)} |`,
    `| Duration p95 | ${milliseconds(run.metrics.durationMs.p95)} |`,
    `| Duration p99 | ${milliseconds(run.metrics.durationMs.p99)} |`,
    ...(run.metrics.repeatSpeedup === undefined ? [] : [`| Repeat speedup | ${run.metrics.repeatSpeedup.toFixed(2)}× |`]),
    ...(run.metrics.challengeFacedRate === undefined ? [] : [`| Challenge faced rate | ${percent(run.metrics.challengeFacedRate)} |`]),
    ...(run.metrics.challengeSolvedRate === undefined ? [] : [`| Challenge solved rate | ${percent(run.metrics.challengeSolvedRate)} |`]),
    '',
    '## Cases',
    '',
    '| Case | Samples | Success | Receipts | p50 | p95 | Repeat speedup |',
    '|---|---:|---:|---:|---:|---:|---:|',
    ...run.metrics.cases.map((item) => `| ${escapeCell(item.caseId)} | ${item.samples} | ${percent(item.successRate)} | ${percent(item.receiptRate)} | ${milliseconds(item.durationMs.p50)} | ${milliseconds(item.durationMs.p95)} | ${item.repeatSpeedup === undefined ? '—' : `${item.repeatSpeedup.toFixed(2)}×`} |`),
  ];
  if (run.qualification.violations.length > 0) {
    lines.push('', '## Qualification violations', '', ...run.qualification.violations.map((item) => `- ${item}`));
  }
  const failures = Object.entries(run.samples.reduce<Record<string, number>>((counts, sample) => {
    if (sample.failureCode) counts[sample.failureCode] = (counts[sample.failureCode] ?? 0) + 1;
    return counts;
  }, {})).sort(([left], [right]) => left.localeCompare(right));
  if (failures.length > 0) {
    lines.push('', '## Failure codes', '', '| Code | Samples |', '|---|---:|', ...failures.map(([code, count]) => `| \`${code}\` | ${count} |`));
  }
  lines.push('', '> Results intentionally exclude scenario inputs, credential references, raw service responses, recordings, and secrets.', '');
  return lines.join('\n');
}

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

export function markdownComparison(comparison: Comparison): string {
  return [
    '# Weles benchmark comparison',
    '',
    `Baseline: \`${comparison.baseline.runId}\` (${comparison.baseline.adapter})  `,
    `Candidate: \`${comparison.candidate.runId}\` (${comparison.candidate.adapter})`,
    '',
    '| Measurement | Candidate delta | Interpretation |',
    '|---|---:|---|',
    `| Success rate | ${signed(comparison.delta.successRatePoints)} pp | higher is better |`,
    `| Verified receipt rate | ${signed(comparison.delta.receiptRatePoints)} pp | higher is better |`,
    `| p50 duration ratio | ${formattedRatio(comparison.delta.p50DurationRatio)} | lower is better |`,
    `| p95 duration ratio | ${formattedRatio(comparison.delta.p95DurationRatio)} | lower is better |`,
    `| Repeat speedup ratio | ${formattedRatio(comparison.delta.repeatSpeedupRatio)} | higher is better |`,
    '',
  ].join('\n');
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function milliseconds(value: number): string {
  return `${value.toFixed(2)} ms`;
}

function escapeCell(value: string): string {
  return value.replaceAll('|', '\\|');
}

function ratio(candidate: number, baseline: number): number | null {
  return baseline === 0 ? null : rounded(candidate / baseline);
}

function rounded(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function signed(value: number): string {
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}`;
}

function formattedRatio(value: number | null): string {
  return value === null ? 'n/a' : `${value.toFixed(4)}×`;
}
