import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import type { ReasoningEffort } from 'openai/resources/shared';
import { loadVars } from './vars.ts';

export interface Config {
  /** Foundry OpenAI-compatible endpoint, e.g. https://<resource>.openai.azure.com/openai/v1/ */
  endpoint: string;
  /** Deployment name of the model in Foundry. */
  model: string;
  /** Optional API key. When unset, Entra ID (DefaultAzureCredential) is used. */
  apiKey?: string;
  tokenScope: string;
  /** Sent as reasoning_effort when set. Empty means the model default. */
  reasoningEffort?: ReasoningEffort;
  headless: boolean;
  /** Browser channel: unset for bundled Chromium, or "msedge" / "chrome". */
  browserChannel?: string;
  /** Connect to a remote Playwright browser server instead of launching one locally. */
  browserWsEndpoint?: string;
  maxSteps: number;
  runTimeoutMs: number;
  trace: boolean;
  /** Save the exact request and raw response of every model call to llm/ in the run folder. */
  logRequests: boolean;
  runsDir: string;
  /** Public values for {{vars.NAME}}, from qa-genie.config.json. */
  vars: Record<string, string>;
}

export const DEFAULT_TOKEN_SCOPE = 'https://cognitiveservices.azure.com/.default';

/** .env wins over OS variables, so names like USERNAME (set by Windows) mean what the .env file says. */
export function loadDotEnv(file = '.env'): void {
  if (existsSync(file)) Object.assign(process.env, parseEnv(readFileSync(file, 'utf8')));
}

/** Sets values in the .env file, keeping its other lines and comments, and applies them to this process. */
export function saveDotEnv(values: Record<string, string>, file = '.env'): void {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const lines = text ? text.split(/\r?\n/) : [];
  if (lines.at(-1) === '') lines.pop();
  for (const [name, value] of Object.entries(values)) {
    const line = `${name}=${envValue(value)}`;
    const i = lines.findIndex((existing) => existing.startsWith(`${name}=`));
    if (i === -1) lines.push(line);
    else lines[i] = line;
    process.env[name] = value;
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  writeFileSync(file, lines.join(eol) + eol);
}

/** Quotes a value when needed, so spaces, # and quote characters survive being read back. */
function envValue(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Values cannot contain line breaks');
  if (!/[\s#'"`]/.test(value)) return value;
  const quote = ["'", '"', '`'].find((q) => !value.includes(q));
  if (!quote) throw new Error(`Values cannot contain all three quote characters ' " and \``);
  return quote + value + quote;
}

/** Where run evidence is written. Needs no other settings, so the web UI can start before it is set up. */
export function runsDir(): string {
  return process.env.RUNS_DIR || 'runs';
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const env = process.env;
  const config: Config = {
    endpoint: required('FOUNDRY_ENDPOINT'),
    model: required('FOUNDRY_MODEL'),
    apiKey: env.FOUNDRY_API_KEY || undefined,
    tokenScope: env.FOUNDRY_TOKEN_SCOPE || DEFAULT_TOKEN_SCOPE,
    reasoningEffort: (env.REASONING_EFFORT || undefined) as ReasoningEffort | undefined,
    headless: bool('HEADLESS', false),
    browserChannel: env.BROWSER_CHANNEL || undefined,
    browserWsEndpoint: env.BROWSER_WS_ENDPOINT || undefined,
    maxSteps: int('MAX_STEPS', 100),
    runTimeoutMs: int('RUN_TIMEOUT_MINUTES', 15) * 60_000,
    trace: bool('TRACE', false),
    logRequests: bool('LOG_REQUESTS', false),
    runsDir: runsDir(),
    vars: overrides.vars ?? loadVars(),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) Object.assign(config, { [key]: value });
  }
  return config;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name} (see .env.example)`);
  return value;
}

function bool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  return value ? /^(1|true|yes)$/i.test(value) : fallback;
}

function int(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
