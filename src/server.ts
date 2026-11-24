/**
 * Local web UI: list, edit and run the tasks in tasks/, and watch each run live.
 * Usage: npm run ui [-- --port 4300] [--open]
 * Without --port it takes the first free port from 4300; if this folder's QA Genie is already running, it reuses that one.
 * It has no login and listens on localhost only: whoever can reach it can edit tasks and run them with the secrets in .env.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { z } from 'zod';
import { runTask, type RunEvent } from './agent.ts';
import { DEFAULT_TOKEN_SCOPE, loadConfig, loadDotEnv, runsDir as configuredRunsDir, saveDotEnv } from './config.ts';
import { createLlmClient } from './llm.ts';
import type { RunResult, RunStatus } from './report.ts';
import { placeholderNames } from './secrets.ts';
import { deleteVar, loadTaskOrder, loadVars, saveTaskOrder, saveVar, saveVarOrder, VAR_NAME, VARS_FILE, varNames } from './vars.ts';

const HOST = '127.0.0.1';
const FIRST_PORT = 4300;
const PORTS_TO_TRY = 20;
const TASKS_DIR = 'tasks';
const DELETED_TASKS_DIR = path.join(TASKS_DIR, '.deleted'); // deleted tasks are moved here, so they can be recovered
const UI_DIR = path.join(import.meta.dirname, '..', 'ui');
const UI_FILES: Record<string, string> = { '/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css' };
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
};
// Names are checked before they touch the file system, so requests cannot reach outside tasks/ and runs/.
const TASK_NAME = /^[\w-][\w.-]*\.md$/;
const RUN_ID = /^[\w-][\w.-]*$/;
const RUN_FILE = /^(report\.md|result\.json|screenshots\/[\w.-]+\.png)$/;
const NEW_TASK = '# Steps\n\n1. \n\n# Expected\n\n1. \n';
const MAX_BODY = 1_000_000;

const NewTaskBody = z.object({ name: z.string() });
const RenameTaskBody = z.object({ name: z.string() });
const SaveTaskBody = z.object({ content: z.string() });
const SaveVarBody = z.object({ value: z.string() });
const OrderBody = z.object({ names: z.array(z.string()) });
const SettingValue = z.string().refine((value) => !/[\r\n]/.test(value), 'Line breaks are not allowed');
const SaveSettingsBody = z.object({
  endpoint: z.url(),
  model: SettingValue.refine((value) => value.trim() !== '', 'Enter the model deployment name'),
  apiKey: SettingValue.optional(), // empty keeps the saved key
  secrets: z.record(z.string(), SettingValue).default({}), // values for {{env.NAME}} in tasks; empty keeps the saved value
});
const StartRunBody = z.object({ task: z.string() });
const StopRunBody = z.object({ task: z.string() });
const DEFAULT_MAX_PARALLEL_RUNS = 3; // each run uses about 50-130k tokens a minute; see MAX_PARALLEL_RUNS

type RunUpdate =
  | { type: 'queued'; startedAt: string }
  | { type: 'started'; id: string; dir: string }
  | Exclude<RunEvent, { type: 'started' }>
  | { type: 'finished'; status: RunStatus; summary: string; durationMs: number };

/** What the browser receives over /api/events. Updates name the task whose run they belong to. */
type UiEvent =
  | (RunUpdate & { task: string })
  | { type: 'idle' }; // sent on connect when no run has been started since the server started

/** The latest run of a task started from the UI. Different tasks run at the same time, each in its own browser. */
interface LiveRun {
  task: string;
  events: UiEvent[];
  controller: AbortController;
  running: boolean;
  done: Promise<void>;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

loadDotEnv();
const runsDir = path.resolve(configuredRunsDir());
const requestedPort = flag('--port');
let port = Number(requestedPort ?? FIRST_PORT);
const clients = new Set<ServerResponse>();
const liveRuns = new Map<string, LiveRun>(); // by task, in the order they were started

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  checkOrigin(req);
  const { pathname } = new URL(req.url ?? '/', 'http://localhost');
  const { method } = req;
  let match: RegExpMatchArray | null;

  if (method === 'GET' && UI_FILES[pathname]) return sendFile(res, path.join(UI_DIR, UI_FILES[pathname]));
  if (method === 'GET' && pathname === '/api/events') return subscribe(req, res);
  if (method === 'GET' && pathname === '/api/health') return sendJson(res, { app: 'qa-genie', dir: process.cwd() });
  if (pathname === '/api/settings' && method === 'GET') return sendJson(res, await readSettings());
  if (pathname === '/api/settings' && method === 'PUT') {
    await saveSettings(await readBody(req, SaveSettingsBody));
    return sendEmpty(res);
  }

  if (pathname === '/api/vars' && method === 'GET') return sendJson(res, { file: VARS_FILE, vars: loadVars(), usedBy: await varUsage() });
  if (pathname === '/api/var-order' && method === 'PUT') {
    saveVarOrder((await readBody(req, OrderBody)).names);
    return sendEmpty(res);
  }
  if (pathname === '/api/task-order' && method === 'PUT') {
    saveTaskOrder((await readBody(req, OrderBody)).names.map(taskName));
    return sendEmpty(res);
  }
  if ((method === 'PUT' || method === 'DELETE') && (match = pathname.match(/^\/api\/vars\/([^/]+)$/))) {
    const name = decode(match[1]);
    if (!VAR_NAME.test(name)) throw new HttpError(400, 'Variable names may only contain letters, digits and _');
    if (method === 'DELETE') deleteVar(name);
    else saveVar(name, (await readBody(req, SaveVarBody)).value);
    return sendEmpty(res);
  }
  if (pathname === '/api/tasks' && method === 'GET') return sendJson(res, await listTasks());
  if (pathname === '/api/tasks' && method === 'POST') {
    const name = taskName((await readBody(req, NewTaskBody)).name);
    await writeFile(taskFile(name), NEW_TASK, { flag: 'wx' });
    return sendJson(res, { name }, 201);
  }
  if (method === 'POST' && pathname.startsWith('/api/tasks/') && pathname.endsWith('/rename')) {
    const from = taskName(decode(pathname.slice('/api/tasks/'.length, -'/rename'.length)));
    const to = taskName((await readBody(req, RenameTaskBody)).name.trim());
    await renameTask(from, to);
    return sendJson(res, { name: to });
  }
  if ((match = pathname.match(/^\/api\/tasks\/([^/]+)$/))) {
    const file = taskFile(taskName(decode(match[1])));
    if (method === 'GET') return sendJson(res, { content: await readFile(file, 'utf8') });
    if (method === 'PUT') {
      const { content } = await readBody(req, SaveTaskBody);
      // The browser always sends \n; keep the file's own line endings.
      const crlf = (await readFile(file, 'utf8')).includes('\r\n');
      await writeFile(file, crlf ? content.replace(/\r?\n/g, '\r\n') : content);
      return sendEmpty(res);
    }
    if (method === 'DELETE') {
      await deleteTask(path.basename(file));
      return sendEmpty(res);
    }
  }

  if (pathname === '/api/runs' && method === 'GET') return sendJson(res, await listRuns());
  if (pathname === '/api/runs' && method === 'POST') {
    const { task } = await readBody(req, StartRunBody);
    startRun(taskName(task));
    return sendEmpty(res, 202);
  }
  if (pathname === '/api/runs/stop' && method === 'POST') {
    liveRuns.get(taskName((await readBody(req, StopRunBody)).task))?.controller.abort(new Error('Stopped from the UI'));
    return sendEmpty(res);
  }
  if ((method === 'GET' || method === 'DELETE') && (match = pathname.match(/^\/api\/runs\/([^/]+)$/))) {
    const id = runId(decode(match[1]));
    if (method === 'GET') return sendJson(res, await readResult(id));
    await deleteRun(id);
    return sendEmpty(res);
  }
  if (method === 'GET' && (match = pathname.match(/^\/runs\/([^/]+)\/(.+)$/))) {
    const file = decode(match[2]);
    if (!RUN_FILE.test(file)) throw new HttpError(404, 'Not found');
    return sendFile(res, path.join(runsDir, runId(decode(match[1])), file));
  }
  throw new HttpError(404, 'Not found');
}

/** Renames a task's file, keeping its place in the list and its run history. */
async function renameTask(from: string, to: string): Promise<void> {
  if (liveRuns.get(from)?.running) throw new HttpError(409, `${from} is running. Stop it first.`);
  if (from === to) return;
  const caseOnly = from.toLowerCase() === to.toLowerCase();
  if (!caseOnly && existsSync(taskFile(to))) throw new HttpError(409, `A task called ${to.replace(/\.md$/, '')} already exists`);
  if (caseOnly) {
    // Windows treats the two names as the same file, so go through a temporary name.
    const temp = taskFile(`${to}.renaming`);
    await rename(taskFile(from), temp);
    await rename(temp, taskFile(to));
  } else {
    await rename(taskFile(from), taskFile(to));
  }
  const order = loadTaskOrder();
  if (order.includes(from)) saveTaskOrder(order.map((task) => (task === from ? to : task)));
  liveRuns.delete(from); // its finished run is listed from the run folder from now on
  await moveRunHistory(from, to);
}

/** Past runs are matched to tasks by the name in their result.json, so point them at the new name. */
async function moveRunHistory(from: string, to: string): Promise<void> {
  const ids = existsSync(runsDir) ? (await readdir(runsDir)).filter((id) => RUN_ID.test(id)) : [];
  await Promise.all(
    ids.map(async (id) => {
      const file = path.join(runsDir, id, 'result.json');
      const result = await readResult(id).catch(() => undefined);
      if (!result || path.basename(result.task) !== from) return;
      result.task = result.task.slice(0, -from.length) + to; // keeps the folder part as it was written
      await writeFile(file, JSON.stringify(result, null, 2));
    }),
  );
}

async function deleteTask(name: string): Promise<void> {
  if (liveRuns.get(name)?.running) throw new HttpError(409, `${name} is running. Stop it first.`);
  await mkdir(DELETED_TASKS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await rename(taskFile(name), path.join(DELETED_TASKS_DIR, `${stamp}_${name}`));
  const order = loadTaskOrder();
  if (order.includes(name)) saveTaskOrder(order.filter((task) => task !== name));
}

/** Deletes a finished run's folder for good. Only folders with a result.json count as runs, like in listRuns. */
async function deleteRun(id: string): Promise<void> {
  const live = [...liveRuns.values()].find((run) => run.events.some((event) => event.type === 'started' && event.id === id));
  if (live?.running) throw new HttpError(409, `${live.task} is still running. Stop it first.`);
  await readResult(id); // 404 when it is not a finished run
  await rm(path.join(runsDir, id), { recursive: true, maxRetries: 3 });
  if (live) liveRuns.delete(live.task); // so a reloaded page does not replay a run that no longer exists
}

function startRun(task: string): void {
  if (liveRuns.get(task)?.running) throw new HttpError(409, `${task} is already running`);
  const running = runningRuns().length;
  const limit = Number(process.env.MAX_PARALLEL_RUNS) || DEFAULT_MAX_PARALLEL_RUNS;
  if (running >= limit) throw new HttpError(409, `${running} tasks are already running, the most allowed at once. Wait for one to finish, or raise MAX_PARALLEL_RUNS in .env.`);
  const run: LiveRun = { task, events: [], controller: new AbortController(), running: true, done: Promise.resolve() };
  liveRuns.delete(task); // re-added at the end, so a reloaded page replays runs in the order they started
  liveRuns.set(task, run);
  publish(run, { type: 'queued', startedAt: new Date().toISOString() });
  run.done = execute(run);
}

async function execute(run: LiveRun): Promise<void> {
  const startedAt = Date.now();
  let verdict: { status: RunStatus; summary: string };
  try {
    loadDotEnv(); // so edits to .env apply without restarting the server
    const config = loadConfig();
    const result = await runTask(config, `${TASKS_DIR}/${run.task}`, run.controller.signal, (event) => {
      if (event.type === 'started') publish(run, { type: 'started', id: path.basename(event.runDir), dir: event.runDir });
      else publish(run, event);
    });
    verdict = result;
  } catch (err) {
    verdict = { status: 'error', summary: err instanceof Error ? err.message : String(err) };
  }
  run.running = false;
  publish(run, { type: 'finished', status: verdict.status, summary: verdict.summary, durationMs: Date.now() - startedAt });
}

function runningRuns(): LiveRun[] {
  return [...liveRuns.values()].filter((run) => run.running);
}

function publish(run: LiveRun, update: RunUpdate): void {
  const event: UiEvent = { ...update, task: run.task };
  run.events.push(event);
  for (const client of clients) client.write(sse(event));
}

/** Server-sent events. A new subscriber first gets the latest run of each task replayed, so a reloaded page catches up. */
function subscribe(req: IncomingMessage, res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
  const events = [...liveRuns.values()].flatMap((run) => run.events);
  for (const event of events.length ? events : [{ type: 'idle' } as const]) res.write(sse(event));
  clients.add(res);
  req.on('close', () => clients.delete(res));
}

function sse(event: UiEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** Settings for the Settings dialog. The API key and secret values are never sent back, only whether they are set. */
async function readSettings() {
  loadDotEnv();
  const env = process.env;
  return {
    endpoint: env.FOUNDRY_ENDPOINT ?? '',
    model: env.FOUNDRY_MODEL ?? '',
    hasKey: Boolean(env.FOUNDRY_API_KEY),
    secrets: (await taskSecretNames()).map((name) => ({ name, set: Boolean(env[name]) })),
  };
}

async function saveSettings({ endpoint, model, apiKey, secrets }: z.infer<typeof SaveSettingsBody>): Promise<void> {
  loadDotEnv();
  const used = new Set(await taskSecretNames());
  const unused = Object.keys(secrets).filter((name) => !used.has(name));
  if (unused.length) throw new HttpError(400, `Not used by any task: ${unused.join(', ')}`);
  await checkModel(endpoint, model, apiKey || process.env.FOUNDRY_API_KEY || undefined);
  const filled = Object.fromEntries(Object.entries(secrets).filter(([, value]) => value));
  saveDotEnv({ ...filled, FOUNDRY_ENDPOINT: endpoint, FOUNDRY_MODEL: model, ...(apiKey ? { FOUNDRY_API_KEY: apiKey } : {}) });
}

/** Makes a tiny request, so a wrong endpoint, model name or key shows up when saving rather than in the middle of a run. */
async function checkModel(endpoint: string, model: string, apiKey: string | undefined): Promise<void> {
  const llm = createLlmClient({ endpoint, apiKey, tokenScope: process.env.FOUNDRY_TOKEN_SCOPE || DEFAULT_TOKEN_SCOPE });
  try {
    await llm.responses.create({ model, input: 'Reply with OK.', max_output_tokens: 64, store: false }, { timeout: 30_000, maxRetries: 1 });
  } catch (err) {
    const status = (err as { status?: number }).status;
    const detail = err instanceof Error ? err.message.split('\n')[0] : String(err);
    if (status === 401 || status === 403) throw new HttpError(400, 'The API key was not accepted. Check that it was copied in full.');
    if (status === 404) throw new HttpError(400, `There is no model deployment named "${model}" at this endpoint.`);
    if (!apiKey && /credential|authentication/i.test(`${(err as Error).name} ${detail}`)) {
      throw new HttpError(400, `Enter an API key. Signing in to Azure without one did not work: ${detail}`);
    }
    if (status === undefined) throw new HttpError(400, `Could not reach the endpoint. Check the address, and that you are on the company network or VPN. (${detail})`);
    throw new HttpError(400, `The model replied with an error: ${detail}`);
  }
}

/** Which tasks use each {{vars.NAME}}, so deleting a variable can warn about them. */
async function varUsage(): Promise<Record<string, string[]>> {
  const usedBy: Record<string, string[]> = {};
  for (const task of (await readdir(TASKS_DIR)).filter((name) => TASK_NAME.test(name))) {
    for (const name of new Set(varNames(await readFile(taskFile(task), 'utf8')))) (usedBy[name] ??= []).push(task);
  }
  return usedBy;
}

/** The NAMEs of every {{env.NAME}} the tasks use, so the Settings dialog can ask for their values. */
async function taskSecretNames(): Promise<string[]> {
  const names = (await readdir(TASKS_DIR)).filter((name) => TASK_NAME.test(name));
  const texts = await Promise.all(names.map((name) => readFile(taskFile(name), 'utf8')));
  return [...new Set(texts.flatMap(placeholderNames))].sort();
}

async function listTasks() {
  const runs = await listRuns();
  const order = loadTaskOrder();
  const rank = (name: string) => (order.includes(name) ? order.indexOf(name) : Infinity);
  const names = (await readdir(TASKS_DIR)).filter((name) => TASK_NAME.test(name)).sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  return names.map((name) => ({ name, lastRun: runs.find((run) => run.task === name) }));
}

/** Finished runs, newest first. Folders without a result.json (still running, or not a run) are skipped. */
async function listRuns() {
  const ids = existsSync(runsDir) ? (await readdir(runsDir)).filter((id) => RUN_ID.test(id)) : [];
  const runs = await Promise.all(
    ids.map((id) =>
      readResult(id).then(
        ({ task, status, summary, startedAt, durationMs, steps }) =>
          ({ id, task: path.basename(task), status, summary, startedAt, durationMs, steps: steps.length }),
        () => undefined,
      ),
    ),
  );
  return runs.filter((run) => run !== undefined).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

async function readResult(id: string): Promise<RunResult> {
  return JSON.parse(await readFile(path.join(runsDir, id, 'result.json'), 'utf8')) as RunResult;
}

/** Stops other websites open in the same browser from using this server (DNS rebinding, cross-site requests). */
function checkOrigin(req: IncomingMessage): void {
  const host = req.headers.host;
  if (host !== `${HOST}:${port}` && host !== `localhost:${port}`) throw new HttpError(403, 'Unexpected Host header');
  if (req.method !== 'GET' && req.headers.origin !== `http://${host}`) throw new HttpError(403, 'Cross-origin request refused');
}

async function readBody<S extends z.ZodType>(req: IncomingMessage, schema: S): Promise<z.infer<S>> {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > MAX_BODY) throw new HttpError(413, 'Request body too large');
  }
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'Request body is not JSON');
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

function taskName(name: string): string {
  const withExtension = name.endsWith('.md') ? name : `${name}.md`;
  if (!TASK_NAME.test(withExtension)) throw new HttpError(400, 'Task names may only contain letters, digits, ".", "_" and "-"');
  return withExtension;
}

function taskFile(name: string): string {
  return path.join(TASKS_DIR, name);
}

function runId(id: string): string {
  if (!RUN_ID.test(id)) throw new HttpError(404, 'Not found');
  return id;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    throw new HttpError(400, 'Malformed URL');
  }
}

function sendJson(res: ServerResponse, body: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': CONTENT_TYPES['.json'], 'cache-control': 'no-store' }).end(JSON.stringify(body));
}

function sendEmpty(res: ServerResponse, status = 204): void {
  res.writeHead(status).end();
}

async function sendFile(res: ServerResponse, file: string): Promise<void> {
  const body = await readFile(file);
  const type = CONTENT_TYPES[path.extname(file)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }).end(body);
}

function toHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') return new HttpError(404, 'Not found');
  if (code === 'EEXIST') return new HttpError(409, 'A task with that name already exists');
  console.error(err);
  return new HttpError(500, err instanceof Error ? err.message : String(err));
}

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

/** Listens on the first free port from 4300, unless --port is given. If this QA Genie is already running, opens that one instead. */
async function start(): Promise<void> {
  for (let tries = 1; ; tries++) {
    try {
      await listen();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw err;
      if (await isThisQaGenie(port)) {
        console.log(`QA Genie is already running: http://${HOST}:${port}`);
        if (process.argv.includes('--open')) openBrowser(`http://${HOST}:${port}`);
        process.exit(0);
      }
      if (requestedPort || tries === PORTS_TO_TRY) throw new Error(`Port ${port} is in use by another program`);
      port++;
    }
  }
  const url = `http://${HOST}:${port}`;
  console.log(`QA Genie UI: ${url}  (Ctrl+C to stop)`);
  if (process.argv.includes('--open')) openBrowser(url);
}

function listen(): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
}

/** True when a QA Genie using the same folder (tasks, runs, settings) is already on that port. */
async function isThisQaGenie(port: number): Promise<boolean> {
  try {
    const res = await fetch(`http://${HOST}:${port}/api/health`, { signal: AbortSignal.timeout(2000) });
    const { app, dir } = (await res.json()) as { app?: string; dir?: string };
    return app === 'qa-genie' && dir === process.cwd();
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  const [command, args] =
    process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]]
    : ['xdg-open', [url]];
  spawn(command, args, { detached: true, stdio: 'ignore' }).on('error', () => console.log(`Open ${url} in your browser.`)).unref();
}

const server = createServer((req, res) => {
  handle(req, res).catch((err: unknown) => {
    const { status, message } = toHttpError(err);
    if (res.headersSent) res.end();
    else sendJson(res, { error: message }, status);
  });
});
start().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

process.on('SIGINT', () => {
  const running = runningRuns();
  if (!running.length || running.some((run) => run.controller.signal.aborted)) process.exit(130);
  console.log(`\nStopping ${running.length === 1 ? 'the run' : `${running.length} runs`} and saving evidence... (Ctrl+C again to force quit)`);
  for (const run of running) run.controller.abort(new Error('Interrupted by user'));
  void Promise.all(running.map((run) => run.done)).then(() => process.exit(130));
});
