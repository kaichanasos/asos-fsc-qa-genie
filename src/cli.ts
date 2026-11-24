import path from 'node:path';
import { runTask } from './agent.ts';
import { loadConfig, loadDotEnv } from './config.ts';
import { BADGES } from './report.ts';

const USAGE = 'Usage: npm start -- <task.md> [--headless]';
const EXIT_CODES = { passed: 0, failed: 1, error: 2 } as const;

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const files = args.filter((arg) => !arg.startsWith('--'));
  if (files.length !== 1 || args.includes('--help')) {
    console.error(USAGE);
    return 2;
  }
  loadDotEnv();
  const config = loadConfig({ headless: args.includes('--headless') || undefined });

  const controller = new AbortController();
  process.on('SIGINT', () => {
    if (controller.signal.aborted) process.exit(130);
    console.log('\nStopping and saving evidence... (Ctrl+C again to force quit)');
    controller.abort(new Error('Interrupted by user'));
  });

  const result = await runTask(config, files[0], controller.signal);
  console.log(`\n${BADGES[result.status]}: ${result.summary}\nReport: ${path.join(result.runDir, 'report.md')}`);
  return EXIT_CODES[result.status];
}

main().then(
  (code) => (process.exitCode = code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 2;
  },
);
