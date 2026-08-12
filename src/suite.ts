import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Assertion, BenchmarkCase, BenchmarkSuite, JsonObject, JsonValue } from './types.js';

const SENSITIVE_KEY = /(?:^|[_-])(authorization|bearer|cookie|password|private[_-]?key|secret|session|token)(?:$|[_-])/i;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, label: string, minimum: number): number {
  if (!Number.isInteger(value) || (value as number) < minimum) throw new Error(`${label} must be an integer >= ${minimum}`);
  return value as number;
}

function ratio(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number between 0 and 1`);
  }
  return value;
}

function textList(value: unknown, label: string, fallback: string[] = []): string[] {
  if (value === undefined) return fallback;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !item.trim())) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  return value.map((item) => (item as string).trim());
}

function jsonValue(value: unknown, label: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => jsonValue(item, `${label}[${index}]`));
  const source = object(value, label);
  const result: JsonObject = {};
  for (const [key, item] of Object.entries(source)) result[key] = jsonValue(item, `${label}.${key}`);
  return result;
}

function rejectSensitiveFields(value: JsonValue, label: string): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => rejectSensitiveFields(item, `${label}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) throw new Error(`${label}.${key} is credential-shaped; use credentialRefs instead`);
    rejectSensitiveFields(item, `${label}.${key}`);
  }
}

function assertion(value: unknown, label: string): Assertion {
  const source = object(value, label);
  const operator = text(source.operator, `${label}.operator`);
  if (operator !== 'equals' && operator !== 'exists' && operator !== 'includes') {
    throw new Error(`${label}.operator must be equals, exists, or includes`);
  }
  const path = text(source.path, `${label}.path`);
  if (!path.startsWith('/')) throw new Error(`${label}.path must be a JSON Pointer`);
  if (operator !== 'exists' && source.value === undefined) throw new Error(`${label}.value is required for ${operator}`);
  return source.value === undefined
    ? { path, operator }
    : { path, operator, value: jsonValue(source.value, `${label}.value`) };
}

function benchmarkCase(value: unknown, index: number): BenchmarkCase {
  const label = `cases[${index}]`;
  const source = object(value, label);
  const expected = object(source.expected ?? {}, `${label}.expected`);
  const rawInput = jsonValue(source.input ?? {}, `${label}.input`);
  if (Array.isArray(rawInput) || rawInput === null || typeof rawInput !== 'object') throw new Error(`${label}.input must be an object`);
  rejectSensitiveFields(rawInput, `${label}.input`);
  const receiptRequired = expected.receiptRequired === undefined ? true : expected.receiptRequired;
  if (typeof receiptRequired !== 'boolean') throw new Error(`${label}.expected.receiptRequired must be a boolean`);
  const rawAssertions = expected.assertions ?? [];
  if (!Array.isArray(rawAssertions)) throw new Error(`${label}.expected.assertions must be an array`);
  return {
    id: text(source.id, `${label}.id`),
    title: text(source.title, `${label}.title`),
    origin: text(source.origin, `${label}.origin`),
    action: text(source.action, `${label}.action`),
    input: rawInput,
    justification: text(source.justification, `${label}.justification`),
    credentialRefs: textList(source.credentialRefs, `${label}.credentialRefs`),
    evidencePolicy: text(source.evidencePolicy ?? 'receipt', `${label}.evidencePolicy`),
    tags: textList(source.tags, `${label}.tags`),
    expected: {
      acceptedStatuses: textList(expected.acceptedStatuses, `${label}.expected.acceptedStatuses`, ['succeeded']),
      receiptRequired,
      assertions: rawAssertions.map((item, assertionIndex) => assertion(item, `${label}.expected.assertions[${assertionIndex}]`)),
    },
  };
}

export async function loadSuite(path: string, fixtureOrigin?: string): Promise<{ suite: BenchmarkSuite; sha256: string }> {
  const raw = await readFile(path, 'utf8');
  const parsed = JSON.parse(raw) as unknown;
  const source = object(parsed, 'suite');
  if (source.schema !== 'weles.benchmark.suite.v1') throw new Error('suite.schema must be weles.benchmark.suite.v1');
  const defaults = object(source.defaults ?? {}, 'suite.defaults');
  const thresholds = object(source.thresholds ?? {}, 'suite.thresholds');
  if (!Array.isArray(source.cases) || source.cases.length === 0) throw new Error('suite.cases must be a non-empty array');
  const cases = source.cases.map(benchmarkCase);
  const ids = new Set(cases.map((item) => item.id));
  if (ids.size !== cases.length) throw new Error('suite case IDs must be unique');
  const resolvedCases = cases.map((item) => materializeFixtureOrigin(item, fixtureOrigin));
  const suite: BenchmarkSuite = {
    schema: 'weles.benchmark.suite.v1',
    name: text(source.name, 'suite.name'),
    version: text(source.version, 'suite.version'),
    description: text(source.description, 'suite.description'),
    defaults: {
      repetitions: integer(defaults.repetitions ?? 3, 'suite.defaults.repetitions', 1),
      concurrency: integer(defaults.concurrency ?? 1, 'suite.defaults.concurrency', 1),
      timeoutMs: integer(defaults.timeoutMs ?? 300_000, 'suite.defaults.timeoutMs', 1_000),
      pollIntervalMs: integer(defaults.pollIntervalMs ?? 2_000, 'suite.defaults.pollIntervalMs', 100),
    },
    thresholds: {
      ...(thresholds.successRateMin === undefined ? {} : { successRateMin: ratio(thresholds.successRateMin, 'suite.thresholds.successRateMin') }),
      ...(thresholds.receiptRateMin === undefined ? {} : { receiptRateMin: ratio(thresholds.receiptRateMin, 'suite.thresholds.receiptRateMin') }),
      ...(thresholds.p95DurationMsMax === undefined ? {} : { p95DurationMsMax: integer(thresholds.p95DurationMsMax, 'suite.thresholds.p95DurationMsMax', 1) }),
    },
    cases: resolvedCases,
  };
  return { suite, sha256: createHash('sha256').update(JSON.stringify(suite)).digest('hex') };
}

function materializeFixtureOrigin(benchmark: BenchmarkCase, fixtureOrigin?: string): BenchmarkCase {
  const marker = '${FIXTURE_ORIGIN}';
  const encoded = JSON.stringify(benchmark);
  if (!encoded.includes(marker)) return benchmark;
  if (!fixtureOrigin) throw new Error('suite requires --fixture-origin because it contains ${FIXTURE_ORIGIN}');
  const normalized = new URL(fixtureOrigin).origin;
  return JSON.parse(encoded.replaceAll(marker, normalized)) as BenchmarkCase;
}

export function jsonPointer(document: JsonValue, pointer: string): JsonValue | undefined {
  let current: JsonValue | undefined = document;
  for (const token of pointer.slice(1).split('/').map((part) => part.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (Array.isArray(current)) {
      const index = Number(token);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === 'object') {
      current = current[token];
    } else {
      return undefined;
    }
  }
  return current;
}
