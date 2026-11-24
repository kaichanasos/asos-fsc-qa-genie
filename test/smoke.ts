/**
 * Offline end-to-end check: a fake OpenAI-compatible server plays the model with a fixed script,
 * so the browser, tools, evidence and secret handling can be verified without Azure.
 * Usage: npm run smoke [-- --headed]
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { runTask } from '../src/agent.ts';
import { loadConfig } from '../src/config.ts';

const USER = 'smoke-user';
const PASSWORD = 'smoke-pass-123';
const HAND_TYPED = 'typed-by-a-person-456'; // a password not from .env, so only the password-field hiding can keep it out
const HAND_EMAIL = 'someone.real@example.com'; // likewise an email, which the page also repeats as text

const APP_HTML = `<!doctype html><title>Smoke App</title>
<h1>Sign in</h1>
<form id="f">
  <label>Username <input name="u"></label>
  <label>Password <input name="p" type="password"></label>
  <button>Sign in</button>
</form>
<label>PIN <input name="pin" type="password"></label>
<label>Contact email <input name="email" type="email"></label>
<p>Signing in as SOMEONE.REAL@example.com</p>
<p id="msg"></p>
<script>
  document.querySelector('[name=pin]').value = "${HAND_TYPED}";
  document.querySelector('[name=email]').value = "${HAND_EMAIL}";
  f.onsubmit = (e) => {
    e.preventDefault();
    const ok = f.u.value === "${USER}" && f.p.value === "${PASSWORD}";
    msg.textContent = ok ? "Welcome, " + f.u.value + "!" : "Invalid credentials";
  };
</script>`;

const leaks: string[] = [];
let trimmedSnapshotsSeen = false;
let rememberedValueSeen = false;
let appUrl = ''; // a public {{vars.NAME}} value, so the model sees it as is
let varValueSeen = false;

type InputItem = { type?: string; output?: string };

function call(name: string, args: Record<string, unknown>) {
  const id = Math.random().toString(36).slice(2);
  return { type: 'function_call', id: `fc_${id}`, call_id: `call_${id}`, name, arguments: JSON.stringify(args), status: 'completed' };
}

function refFor(snapshot: string, role: string, name: string): string {
  const match = snapshot.match(new RegExp(String.raw`${role} "${name}"[^\n]*?\[ref=(\w+)\]`));
  if (!match) throw new Error(`No ${role} "${name}" in the snapshot`);
  return match[1];
}

/** The scripted "model": picks the next action from how many tool results it has seen so far. */
function nextToolCalls(input: InputItem[]) {
  const results = input.filter((item) => item.type === 'function_call_output');
  const page = String(results.at(-1)?.output ?? '');
  switch (results.length) {
    case 0:
      return [call('navigate', { url: appUrl })];
    case 1:
      return [
        call('remember', { name: 'Page heading', value: 'Sign in' }),
        call('type', { ref: refFor(page, 'textbox', 'Username'), element: 'Username field', text: '{{env.SMOKE_USER}}' }),
      ];
    case 3:
      return [
        call('type', { ref: refFor(page, 'textbox', 'Password'), element: 'Password field', text: '{{env.SMOKE_PASSWORD}}' }),
        call('click', { ref: refFor(page, 'button', 'Sign in'), element: 'Sign in button' }),
      ];
    default: {
      const welcomed = page.includes('Welcome');
      const summary = welcomed ? 'Welcome message shown after login.' : 'No welcome message after login.';
      return [call('finish', { status: welcomed ? 'passed' : 'failed', summary })];
    }
  }
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}

const server = createServer(async (req, res) => {
  if (req.url === '/app') {
    res.writeHead(200, { 'content-type': 'text/html' }).end(APP_HTML);
    return;
  }
  if (req.method !== 'POST' || req.url !== '/v1/responses') {
    res.writeHead(404).end();
    return;
  }
  const raw = await readBody(req);
  for (const secret of [USER, PASSWORD, HAND_TYPED, HAND_EMAIL]) if (raw.toLowerCase().includes(secret.toLowerCase())) leaks.push(`model request contained "${secret}"`);
  if (raw.includes('[older page snapshot removed]')) trimmedSnapshotsSeen = true;
  if (raw.includes(`Go to ${appUrl}`)) varValueSeen = true;
  // The request body is JSON, so the newline arrives escaped.
  if (raw.includes(JSON.stringify('Remembered values:\n- Page heading: Sign in').slice(1, -1))) rememberedValueSeen = true;
  try {
    const output = nextToolCalls(JSON.parse(raw).input);
    const usage = { input_tokens: Math.ceil(raw.length / 4), output_tokens: 20, total_tokens: 0 };
    const body = { id: 'resp_smoke', object: 'response', created_at: 0, status: 'completed', model: 'smoke', output, usage };
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(err) } }));
  }
});

await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
appUrl = `${base}/app`;
Object.assign(process.env, {
  FOUNDRY_ENDPOINT: `${base}/v1/`,
  FOUNDRY_MODEL: 'smoke',
  FOUNDRY_API_KEY: 'smoke',
  SMOKE_USER: USER,
  SMOKE_PASSWORD: PASSWORD,
});
const config = loadConfig({ headless: !process.argv.includes('--headed'), trace: true, runsDir: path.join('runs', 'smoke'), logRequests: true, vars: { SMOKE_APP_URL: appUrl } });

try {
  const result = await runTask(config, 'test/smoke-login.md', new AbortController().signal);
  assert.equal(result.status, 'passed', result.summary);
  assert.equal(result.steps.length, 6);
  assert.equal(readdirSync(path.join(result.runDir, 'screenshots')).length, result.steps.length, 'one screenshot per step');
  for (const file of ['report.md', 'result.json', 'transcript.jsonl']) {
    assert.ok(existsSync(path.join(result.runDir, file)), `${file} is written`);
  }
  assert.ok(!existsSync(path.join(result.runDir, 'trace.zip')), 'the trace of a passing run is discarded');
  const llmFiles = readdirSync(path.join(result.runDir, 'llm')).map((file) => path.join('llm', file));
  assert.ok(llmFiles.includes(path.join('llm', 'turn-001.request.json')), 'model requests are logged');
  assert.equal(llmFiles.length % 2, 0, 'every logged request has its response');
  for (const file of ['report.md', 'result.json', 'transcript.jsonl', ...llmFiles]) {
    const text = readFileSync(path.join(result.runDir, file), 'utf8');
    for (const secret of [USER, PASSWORD, HAND_TYPED, HAND_EMAIL]) if (text.toLowerCase().includes(secret.toLowerCase())) leaks.push(`${file} contained "${secret}"`);
  }
  assert.deepEqual(leaks, [], 'secrets never leave the tool layer');
  assert.match(readFileSync(path.join(result.runDir, 'transcript.jsonl'), 'utf8'), /textbox \\"PIN\\" \[ref=\w+\]: <hidden>/, 'password fields show as hidden');
  assert.ok(trimmedSnapshotsSeen, 'older snapshots are trimmed from the conversation');
  assert.ok(rememberedValueSeen, 'remembered values are shown with later snapshots');
  assert.ok(varValueSeen, 'public vars reach the model as their real values');
  assert.deepEqual(result.remembered, { 'Page heading': 'Sign in' });
  assert.match(readFileSync(path.join(result.runDir, 'report.md'), 'utf8'), /\| Page heading \| Sign in \|/, 'remembered values are in the report');
  assert.match(result.steps.find((s) => s.tool === 'click')?.locator ?? '', /getByRole/, 'durable locator recorded');
  console.log(`\nSmoke test passed. Evidence: ${result.runDir}`);
} finally {
  server.closeAllConnections();
  server.close();
}
