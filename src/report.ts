import path from 'node:path';

export type RunStatus = 'passed' | 'failed' | 'error';

export interface StepRecord {
  step: number;
  tool: string;
  args: unknown;
  message: string;
  error?: string;
  locator?: string;
  screenshot?: string;
}

export interface RunResult {
  status: RunStatus;
  summary: string;
  task: string;
  model: string;
  startedAt: string;
  durationMs: number;
  usage: { inputTokens: number; outputTokens: number };
  runDir: string;
  trace?: string;
  /** Values saved with the remember tool, e.g. IDs created during the run. */
  remembered: Record<string, string>;
  steps: StepRecord[];
}

export const BADGES: Record<RunStatus, string> = { passed: '✅ PASSED', failed: '❌ FAILED', error: '⚠️ ERROR' };

export function renderReport(result: RunResult): string {
  const lines = [
    `# ${BADGES[result.status]}: ${path.basename(result.task)}`,
    '',
    result.summary,
    '',
    '| | |',
    '|---|---|',
    `| Task | \`${result.task}\` |`,
    `| Model | ${result.model} |`,
    `| Started | ${result.startedAt} |`,
    `| Duration | ${(result.durationMs / 1000).toFixed(1)}s |`,
    `| Steps | ${result.steps.length} |`,
    `| Tokens | ${result.usage.inputTokens} in / ${result.usage.outputTokens} out |`,
  ];
  if (result.trace) lines.push(`| Trace | \`npx playwright show-trace ${result.trace}\` |`);
  const remembered = Object.entries(result.remembered ?? {});
  if (remembered.length) {
    lines.push('', '## Remembered values', '', '| Name | Value |', '|---|---|');
    for (const [name, value] of remembered) lines.push(`| ${cell(name)} | ${cell(value)} |`);
  }
  lines.push('', '## Steps', '');

  for (const step of result.steps) {
    lines.push(`### ${step.step}. ${step.error ? '❌ ' : ''}${step.message}`, '');
    if (step.locator) lines.push(`Locator: \`${step.locator}\``, '');
    if (step.error) lines.push('```', step.error, '```', '');
    if (step.screenshot) lines.push(`![Step ${step.step}](${step.screenshot})`, '');
  }
  return lines.join('\n');
}

function cell(text: string): string {
  return text.replaceAll('|', '\|').replace(/\s*\n\s*/g, ' ');
}
