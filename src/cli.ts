#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, extname } from 'node:path';
import { BrowserUseAdapter } from './adapters/browser-use.js';
import { CommandAdapter } from './adapters/command.js';
import { SkyvernAdapter } from './adapters/skyvern.js';
import { StagehandAdapter } from './adapters/stagehand.js';
import { WelesAdapter } from './adapters/weles.js';
import { serveFixture } from './fixture.js';
import { compareRuns, markdownComparison, markdownReport } from './report.js';
import { runBenchmark } from './runner.js';
import { loadSuite } from './suite.js';
import type { BenchmarkAdapter, BenchmarkRun } from './types.js';

type Arguments = {
  command: string;
  positionals: string[];
  options: Record<string, string[]>;
};

const HELP = `weles-benchmark

Commands:
  fixture [--host 127.0.0.1] [--port 8787]
  run --suite <file> [--adapter weles|browser-use|skyvern|stagehand|command] [--out <file>]
      [--fixture-origin <url>] [--repetitions <n>] [--concurrency <n>]
      Weles: [--endpoint <url>]
      Browser Use: [--python <executable>]
      Skyvern: [--skyvern-base-url <url>]
      Stagehand: [--model <Brama-model>] [--browser-executable <path>]
      Command: --command <executable> [--command-arg <arg>] [--command-env <name>]
  report --input <run.json> [--out <report.md>]
  compare --baseline <run.json> --candidate <run.json> [--out <comparison.md>] [--json]

Credentials come only from WELES_TOKEN, SKYVERN_API_KEY, and BRAMA_API_KEY.
Service/model locations default to WELES_API_BASE, SKYVERN_BASE_URL,
BRAMA_BASE_URL, and BRAMA_MODEL. Credential values are never accepted as CLI
flags or written to result files.
`;

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === 'help' || parsed.options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.command === 'fixture') {
    assertAllowedOptions(parsed, ['host', 'port']);
    await serveFixture({
      host: option(parsed, 'host') ?? '127.0.0.1',
      port: positiveInteger(option(parsed, 'port') ?? '8787', '--port'),
    });
    return;
  }
  if (parsed.command === 'run') {
    await runCommand(parsed);
    return;
  }
  if (parsed.command === 'report') {
    assertAllowedOptions(parsed, ['input', 'out']);
    const run = await loadRun(requiredOption(parsed, 'input'));
    const report = markdownReport(run);
    const output = option(parsed, 'out');
    if (output) await writeAtomic(output, report);
    else process.stdout.write(report);
    return;
  }
  if (parsed.command === 'compare') {
    assertAllowedOptions(parsed, ['baseline', 'candidate', 'out', 'json']);
    const baseline = await loadRun(requiredOption(parsed, 'baseline'));
    const candidate = await loadRun(requiredOption(parsed, 'candidate'));
    const comparison = compareRuns(baseline, candidate);
    const body = parsed.options.json ? `${JSON.stringify(comparison, null, 2)}\n` : markdownComparison(comparison);
    const output = option(parsed, 'out');
    if (output) await writeAtomic(output, body);
    else process.stdout.write(body);
    return;
  }
  throw new Error(`unknown command: ${parsed.command}`);
}

async function runCommand(parsed: Arguments): Promise<void> {
  assertAllowedOptions(parsed, [
    'suite', 'adapter', 'out', 'report-out', 'fixture-origin', 'repetitions', 'concurrency',
    'endpoint', 'python', 'skyvern-base-url', 'model', 'browser-executable',
    'command', 'command-arg', 'command-env', 'adapter-name',
  ]);
  const suitePath = requiredOption(parsed, 'suite');
  const loaded = await loadSuite(suitePath, option(parsed, 'fixture-origin'));
  const adapter = createAdapter(parsed);
  const repetitions = optionalPositiveInteger(option(parsed, 'repetitions'), '--repetitions');
  const concurrency = optionalPositiveInteger(option(parsed, 'concurrency'), '--concurrency');
  const result = await runBenchmark({
    suite: loaded.suite,
    suiteSha256: loaded.sha256,
    adapter,
    ...(repetitions === undefined ? {} : { repetitions }),
    ...(concurrency === undefined ? {} : { concurrency }),
  });
  const output = option(parsed, 'out') ?? `results/${safeName(loaded.suite.name)}-${timestamp()}.json`;
  const reportOutput = option(parsed, 'report-out') ?? `${output.slice(0, extname(output) ? -extname(output).length : undefined)}.md`;
  await writeAtomic(output, `${JSON.stringify(result, null, 2)}\n`);
  await writeAtomic(reportOutput, markdownReport(result));
  process.stdout.write(`${JSON.stringify({
    schema: result.schema,
    runId: result.runId,
    result: output,
    report: reportOutput,
    qualification: result.qualification,
  }, null, 2)}\n`);
  if (!result.qualification.passed) process.exitCode = 1;
}

function createAdapter(parsed: Arguments): BenchmarkAdapter {
  const adapterName = option(parsed, 'adapter') ?? 'weles';
  if (adapterName === 'weles') {
    const endpoint = option(parsed, 'endpoint') ?? process.env.WELES_API_BASE;
    return WelesAdapter.create({
      ...(endpoint ? { endpoint } : {}),
      ...(process.env.WELES_TOKEN ? { bearer: process.env.WELES_TOKEN } : {}),
    });
  }
  if (adapterName === 'browser-use') return new BrowserUseAdapter(option(parsed, 'python'));
  if (adapterName === 'skyvern') {
    const baseUrl = option(parsed, 'skyvern-base-url') ?? process.env.SKYVERN_BASE_URL;
    return new SkyvernAdapter({
      ...(process.env.SKYVERN_API_KEY ? { apiKey: process.env.SKYVERN_API_KEY } : {}),
      ...(baseUrl ? { baseUrl } : {}),
    });
  }
  if (adapterName === 'stagehand') {
    const model = option(parsed, 'model') ?? process.env.BRAMA_MODEL;
    const executablePath = option(parsed, 'browser-executable') ?? process.env.BROWSER_EXECUTABLE_PATH;
    return new StagehandAdapter({
      ...(process.env.BRAMA_API_KEY ? { apiKey: process.env.BRAMA_API_KEY } : {}),
      ...(process.env.BRAMA_BASE_URL ? { baseUrl: process.env.BRAMA_BASE_URL } : {}),
      ...(model ? { model } : {}),
      ...(executablePath ? { executablePath } : {}),
    });
  }
  if (adapterName === 'command') {
    return new CommandAdapter(
      requiredOption(parsed, 'command'),
      parsed.options['command-arg'] ?? [],
      parsed.options['command-env'] ?? [],
      option(parsed, 'adapter-name'),
    );
  }
  throw new Error('--adapter must be weles, browser-use, skyvern, stagehand, or command');
}

function parseArguments(values: string[]): Arguments {
  const command = values[0] ?? 'help';
  const positionals: string[] = [];
  const options: Record<string, string[]> = {};
  for (let index = 1; index < values.length; index += 1) {
    const value = values[index];
    if (!value) continue;
    if (!value.startsWith('--')) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!key) throw new Error('empty option name');
    const next = values[index + 1];
    const optionValue = next && !next.startsWith('--') ? next : 'true';
    if (optionValue !== 'true') index += 1;
    (options[key] ??= []).push(optionValue);
  }
  return { command, positionals, options };
}

function assertAllowedOptions(parsed: Arguments, allowed: string[]): void {
  if (parsed.positionals.length > 0) throw new Error(`unexpected positional arguments: ${parsed.positionals.join(', ')}`);
  for (const key of Object.keys(parsed.options)) {
    if (!allowed.includes(key) && key !== 'help') throw new Error(`unsupported option for ${parsed.command}: --${key}`);
  }
}

function option(parsed: Arguments, key: string): string | undefined {
  const values = parsed.options[key];
  if (!values?.length) return undefined;
  if (values.length !== 1) throw new Error(`--${key} may be supplied only once`);
  if (values[0] === 'true') throw new Error(`--${key} requires a value`);
  return values[0];
}

function requiredOption(parsed: Arguments, key: string): string {
  const value = option(parsed, key);
  if (!value) throw new Error(`--${key} is required`);
  return value;
}

function positiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function optionalPositiveInteger(value: string | undefined, label: string): number | undefined {
  return value === undefined ? undefined : positiveInteger(value, label);
}

async function loadRun(path: string): Promise<BenchmarkRun> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${path} is not a benchmark run`);
  const source = parsed as Record<string, unknown>;
  if (source.schema !== 'weles.benchmark.run.v1' || typeof source.runId !== 'string') throw new Error(`${path} uses an unsupported run schema`);
  if (!source.suite || typeof source.suite !== 'object' || !source.metrics || typeof source.metrics !== 'object') {
    throw new Error(`${path} is missing run metadata`);
  }
  return parsed as BenchmarkRun;
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, path);
}

function safeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'benchmark';
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : 'unknown failure';
  process.stderr.write(`weles-benchmark: ${message}\n`);
  process.exitCode = 1;
});
