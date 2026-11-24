import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type {
  ResponseCreateParamsNonStreaming,
  ResponseFunctionToolCall,
  ResponseInputItem,
} from 'openai/resources/responses/responses';
import { RunArtifacts } from './artifacts.ts';
import { BrowserSession } from './browser.ts';
import type { Config } from './config.ts';
import { createLlmClient } from './llm.ts';
import { NUDGE_PROMPT, SYSTEM_PROMPT, taskPrompt } from './prompts.ts';
import { renderReport, type RunResult, type StepRecord } from './report.ts';
import { Secrets } from './secrets.ts';
import { findTool, toolSpecs, type ToolContext, type ToolOutcome, type Verdict } from './tools.ts';
import { applyVars } from './vars.ts';

const SNAPSHOT_HEADER = '\n--- Current page ---\n';
const MAX_NUDGES = 2;
const SKIPPED_OUTPUT = 'Not run: an earlier action in this batch failed.';

/** Live progress for callers such as the web UI. Text is already redacted. */
export type RunEvent =
  | { type: 'started'; runDir: string }
  | { type: 'message'; text: string }
  | { type: 'step'; step: StepRecord };

export async function runTask(
  config: Config,
  taskPath: string,
  signal: AbortSignal,
  onEvent: (event: RunEvent) => void = () => {},
): Promise<RunResult> {
  // Public vars are filled in first, so the model sees their real values; secrets stay placeholders.
  const task = applyVars(await readFile(taskPath, 'utf8'), config.vars);
  const secrets = new Secrets(task);
  const taskName = path.basename(taskPath, path.extname(taskPath));
  const artifacts = await RunArtifacts.create(config.runsDir, taskName, (text) => secrets.redact(text));
  const llm = createLlmClient(config);
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(config.runTimeoutMs)]);
  const say = (text: string) => console.log(secrets.redact(text));

  const startedAt = new Date();
  const steps: StepRecord[] = [];
  const usage = { inputTokens: 0, outputTokens: 0 };
  let verdict: Verdict | undefined;
  let failure: string | undefined;

  say(`Running ${taskPath} with ${config.model}\nEvidence: ${artifacts.dir}`);
  onEvent({ type: 'started', runDir: artifacts.dir });
  const browser = await BrowserSession.start(config);
  const context: ToolContext = { browser, secrets, memory: new Map() };

  try {
    // The conversation is kept here rather than on the server (store: false), so old snapshots can be trimmed
    // and page content is not retained by the service. Reasoning is passed back in encrypted form.
    const input: ResponseInputItem[] = [{ role: 'user', content: taskPrompt(task) }];
    let nudges = 0;
    let turn = 0;

    while (!verdict) {
      runSignal.throwIfAborted();
      const request: ResponseCreateParamsNonStreaming = {
        model: config.model,
        instructions: SYSTEM_PROMPT,
        input,
        tools: toolSpecs,
        reasoning: config.reasoningEffort ? { effort: config.reasoningEffort } : undefined,
        store: false,
        include: ['reasoning.encrypted_content'],
      };
      // Written before sending, so a request that errors out is still on disk.
      const llmFile = `llm/turn-${String(++turn).padStart(3, '0')}`;
      if (config.logRequests) await artifacts.write(`${llmFile}.request.json`, JSON.stringify(request, null, 2));
      const response = await llm.responses.create(request, { signal: runSignal });
      if (config.logRequests) await artifacts.write(`${llmFile}.response.json`, JSON.stringify(response, null, 2));
      usage.inputTokens += response.usage?.input_tokens ?? 0;
      usage.outputTokens += response.usage?.output_tokens ?? 0;

      const calls = response.output.filter((item) => item.type === 'function_call');
      const text = response.output_text;
      await artifacts.log({ type: 'model', text, toolCalls: calls.map(({ name, arguments: args }) => ({ name, args })), usage: response.usage });
      if (text) {
        say(`  💬 ${text}`);
        onEvent({ type: 'message', text: secrets.redact(text) });
      }
      input.push(...(response.output as ResponseInputItem[]));

      if (calls.length === 0) {
        if (++nudges > MAX_NUDGES) throw new Error('The model stopped calling tools without giving a verdict');
        input.push({ role: 'user', content: NUDGE_PROMPT });
        continue;
      }
      nudges = 0;

      // Several calls in one response form a batch on the same page: only the last one gets a fresh snapshot,
      // so refs from the snapshot the model saw stay valid, and the batch stops at the first error.
      let stopped = false;
      for (const [i, call] of calls.entries()) {
        if (stopped) {
          input.push({ type: 'function_call_output', call_id: call.call_id, output: SKIPPED_OUTPUT });
          continue;
        }
        if (steps.length >= config.maxSteps) throw new Error(`Reached the step limit (${config.maxSteps}) without a verdict`);
        runSignal.throwIfAborted();
        const step = await executeStep(steps.length + 1, call, context, artifacts, i === calls.length - 1);
        let { content } = step;
        const { record } = step;
        steps.push(record);
        onEvent({ type: 'step', step: { ...record, message: secrets.redact(record.message), error: record.error && secrets.redact(record.error) } });
        say(`  ${record.error ? '✗' : '✓'} [${record.step}] ${record.message}${record.error ? ` (${firstLine(record.error)})` : ''}`);
        if (step.verdict) {
          input.push({ type: 'function_call_output', call_id: call.call_id, output: content });
          verdict = step.verdict;
          break;
        }
        if (record.error && i < calls.length - 1) {
          stopped = true;
          content += secrets.redact(await pageState(context));
        }
        input.push({ type: 'function_call_output', call_id: call.call_id, output: content });
      }
      dropOldSnapshots(input);
    }
  } catch (err) {
    failure = runSignal.aborted ? abortReason(runSignal, config) : describeError(err);
    await artifacts.log({ type: 'error', message: failure });
  } finally {
    // A trace holds typed values in plain text and is large, so it is only kept to debug runs that did not pass.
    await browser.close(traceKept(config, verdict) ? artifacts.path('trace.zip') : undefined);
  }

  const result: RunResult = {
    status: verdict?.status ?? 'error',
    summary: verdict?.summary ?? `Run did not complete: ${failure}`,
    task: taskPath,
    model: config.model,
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    usage,
    runDir: artifacts.dir,
    trace: traceKept(config, verdict) ? 'trace.zip' : undefined,
    remembered: Object.fromEntries([...context.memory].map(([name, value]) => [name, secrets.redact(value)])),
    steps,
  };
  await artifacts.write('result.json', JSON.stringify(result, null, 2));
  await artifacts.write('report.md', renderReport(result));
  return result;
}

function traceKept(config: Config, verdict: Verdict | undefined): boolean {
  return config.trace && verdict?.status !== 'passed';
}

/** Runs one tool call, then captures evidence (screenshot) and, at the end of a batch, the page state the model sees next. */
async function executeStep(
  step: number,
  call: ResponseFunctionToolCall,
  context: ToolContext,
  artifacts: RunArtifacts,
  withSnapshot: boolean,
): Promise<{ record: StepRecord; content: string; verdict?: Verdict }> {
  const { browser, secrets } = context;
  const { name } = call;
  let args: unknown = call.arguments;
  let outcome: ToolOutcome | undefined;
  let error: string | undefined;
  try {
    args = JSON.parse(call.arguments || '{}');
    const tool = findTool(name);
    if (!tool) throw new Error(`Unknown tool "${name}"`);
    outcome = await tool.run(args, context);
  } catch (err) {
    error = describeError(err);
  }
  if (browser.closed) throw new Error('The browser was closed');

  await browser.settle();
  const label = [name, elementOf(args) ?? outcome?.verdict?.status].filter(Boolean).join(' ');
  const shot = artifacts.screenshotFile(step, label);
  const saved = await browser.screenshot(shot.absolute);

  const record: StepRecord = {
    step,
    tool: name,
    args,
    message: outcome?.message ?? `${name} ${call.arguments}`,
    error,
    locator: outcome?.locator,
    screenshot: saved ? shot.relative : undefined,
  };
  const parts = [error ? `Error: ${error}` : record.message, ...browser.drainEvents()];
  if (withSnapshot && !outcome?.verdict) parts.push(await pageState(context));
  const content = secrets.redact(parts.join('\n'));
  await artifacts.log({ type: 'tool', ...record, result: content });
  return { record, content, verdict: outcome?.verdict };
}

/** What the model sees after a batch: saved values, then the page. Both sit after the header, so older copies are trimmed together. */
async function pageState({ browser, memory }: ToolContext): Promise<string> {
  const remembered = [...memory].map(([name, value]) => `- ${name}: ${value}`);
  const saved = remembered.length ? `Remembered values:\n${remembered.join('\n')}\n\n` : '';
  return SNAPSHOT_HEADER + saved + (await browser.snapshot());
}

/** Only the latest page snapshot is useful to the model; older ones just burn tokens. */
function dropOldSnapshots(input: ResponseInputItem[]): void {
  let keptLatest = false;
  for (let i = input.length - 1; i >= 0; i--) {
    const item = input[i];
    if (item.type !== 'function_call_output' || typeof item.output !== 'string') continue;
    const at = item.output.indexOf(SNAPSHOT_HEADER);
    if (at === -1) continue;
    if (!keptLatest) {
      keptLatest = true;
      continue;
    }
    item.output = item.output.slice(0, at) + '\n[older page snapshot removed]';
  }
}

function elementOf(args: unknown): string | undefined {
  if (typeof args === 'object' && args !== null && 'element' in args && typeof args.element === 'string') return args.element;
  return undefined;
}

function abortReason(signal: AbortSignal, config: Config): string {
  if (signal.reason instanceof DOMException && signal.reason.name === 'TimeoutError') {
    return `Run timed out after ${config.runTimeoutMs / 60_000} minutes`;
  }
  return signal.reason instanceof Error ? signal.reason.message : String(signal.reason);
}

/** Call-log lines that say why an action could not run; the rest of the log is retry noise. */
const BLOCKER = /intercepts pointer events|element is not (visible|enabled|editable|stable|attached)|element is outside of the viewport/;

/** Playwright errors carry a long call log. Keep the error itself plus the lines that say what blocked the action. */
function describeError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const [head, log = ''] = message.split('\nCall log:');
  const lines = stripVTControlCharacters(log).split('\n').map((line) => line.replace(/^[\s-]+/, '').slice(0, 300));
  const blockers = [...new Set(lines.filter((line) => BLOCKER.test(line)))].slice(0, 3);
  const covered = blockers.some((line) => line.includes('intercepts pointer events'));
  return [
    head.trim(),
    ...blockers.map((line) => `- ${line}`),
    covered ? 'Another element covers the target, probably an open menu, popup or overlay (it may not be in the snapshot). Close it first, e.g. hover with no ref to move the mouse away, press Escape or click its close button, then retry.' : '',
  ].filter(Boolean).join('\n').slice(0, 1500);
}

function firstLine(text: string): string {
  return text.split('\n')[0];
}
