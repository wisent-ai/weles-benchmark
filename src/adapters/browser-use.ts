import { resolve } from 'node:path';
import type { AdapterExecution, AdapterResult, BenchmarkAdapter } from '../types.js';
import { CommandAdapter } from './command.js';

const ENVIRONMENT = [
  'BRAMA_API_KEY',
  'BRAMA_BASE_URL',
  'BRAMA_MODEL',
  'BROWSER_EXECUTABLE_PATH',
  'BROWSER_USE_MAX_STEPS',
  'BROWSER_USE_SETUP_LOGGING',
];

export class BrowserUseAdapter implements BenchmarkAdapter {
  readonly name = 'browser-use';
  readonly version = 'browser-use/0.13.7';
  private readonly command: CommandAdapter;

  constructor(python = process.env.BROWSER_USE_PYTHON ?? 'python3') {
    this.command = new CommandAdapter(
      python,
      [resolve('scripts/browser-use-client.py')],
      ENVIRONMENT,
      this.name,
    );
  }

  execute(execution: AdapterExecution): Promise<AdapterResult> {
    return this.command.execute(execution);
  }
}
