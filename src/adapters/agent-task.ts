import type { BenchmarkCase, JsonValue } from '../types.js';

export function agentInstruction(benchmarkCase: BenchmarkCase): string {
  const schema = outputSchema(benchmarkCase);
  return [
    benchmarkCase.instruction,
    `Start at: ${requiredUrl(benchmarkCase)}`,
    `Return only one JSON object matching this schema: ${JSON.stringify(schema)}`,
    'Do not include Markdown, commentary, or values that were not read from the page.',
  ].join('\n');
}

export function outputSchema(benchmarkCase: BenchmarkCase): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const assertion of benchmarkCase.expected.assertions) {
    const key = topLevelKey(assertion.path);
    if (!key || properties[key]) continue;
    properties[key] = schemaFor(assertion.value);
    required.push(key);
  }
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    required,
  };
}

export function requiredUrl(benchmarkCase: BenchmarkCase): string {
  const value = benchmarkCase.input.url;
  if (typeof value !== 'string') throw new Error('benchmark-case-url-required');
  const parsed = new URL(value);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('benchmark-case-url-invalid');
  return parsed.toString();
}

export function parseAgentOutput(value: unknown): JsonValue {
  if (value && typeof value === 'object') return safeJson(value);
  if (typeof value !== 'string') throw new Error('agent-output-missing');
  const candidates = [value.trim(), ...jsonBlocks(value), balancedObject(value)];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return safeJson(parsed);
    } catch {
      continue;
    }
  }
  throw new Error('agent-output-invalid-json');
}

function topLevelKey(pointer: string): string | undefined {
  if (!/^\/[^/]+$/.test(pointer)) return undefined;
  return pointer.slice(1).replaceAll('~1', '/').replaceAll('~0', '~');
}

function schemaFor(value: JsonValue | undefined): Record<string, unknown> {
  if (typeof value === 'string') return { type: 'string' };
  if (typeof value === 'boolean') return { type: 'boolean' };
  if (typeof value === 'number') return { type: 'number' };
  if (Array.isArray(value)) return { type: 'array' };
  if (value && typeof value === 'object') return { type: 'object' };
  return {};
}

function jsonBlocks(value: string): string[] {
  return [...value.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].map((match) => match[1]?.trim() ?? '');
}

function balancedObject(value: string): string {
  const start = value.indexOf('{');
  if (start < 0) return '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\' && quoted) {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (quoted) continue;
    if (character === '{') depth += 1;
    if (character === '}') depth -= 1;
    if (depth === 0) return value.slice(start, index + 1);
  }
  return '';
}

function safeJson(value: unknown): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(safeJson);
  if (!value || typeof value !== 'object') return null;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, safeJson(item)]));
}
