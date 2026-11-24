import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

export const VARS_FILE = 'qa-genie.config.json';
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PLACEHOLDER = /\{\{\s*vars\.([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

const ConfigFile = z.object({
  vars: z.record(z.string().regex(VAR_NAME, 'Use letters, digits and _'), z.string()).default({}),
  taskOrder: z.array(z.string()).default([]), // set by dragging tasks in the web UI
});

/**
 * Public values shared by all tasks (site URLs, test data), read from qa-genie.config.json.
 * Unlike {{env.NAME}} secrets, the model sees them and reports show them.
 */
export function loadVars(file = VARS_FILE): Record<string, string> {
  const parsed = ConfigFile.safeParse(readConfigFile(file));
  if (!parsed.success) throw new Error(`${file} is invalid:\n${z.prettifyError(parsed.error)}`);
  return parsed.data.vars;
}

/** Sets one variable, keeping the rest of the file (other settings, key order). */
export function saveVar(name: string, value: string, file = VARS_FILE): void {
  if (!VAR_NAME.test(name)) throw new Error(`${name} is not a valid variable name: use letters, digits and _`);
  loadVars(file); // refuses to rewrite a file that is already invalid
  const json = readConfigFile(file) as { vars?: Record<string, string> };
  json.vars = { ...json.vars, [name]: value };
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** Removes one variable, keeping the rest of the file. */
export function deleteVar(name: string, file = VARS_FILE): void {
  const vars = loadVars(file);
  if (!Object.hasOwn(vars, name)) throw new Error(`${name} does not exist. Reload the page.`);
  delete vars[name];
  const json = readConfigFile(file) as Record<string, unknown>;
  json.vars = vars;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** The NAMEs of the {{vars.NAME}} placeholders in a text. */
export function varNames(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]);
}

/** Puts the variables in this order, keeping their values and the rest of the file. */
export function saveVarOrder(names: string[], file = VARS_FILE): void {
  const vars = loadVars(file);
  const complete = names.length === Object.keys(vars).length && new Set(names).size === names.length && names.every((name) => Object.hasOwn(vars, name));
  if (!complete) throw new Error('The new order must list every variable once. Reload the page and try again.');
  const json = readConfigFile(file) as Record<string, unknown>;
  json.vars = Object.fromEntries(names.map((name) => [name, vars[name]]));
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

/** The order tasks are listed in, by file name. Tasks missing from it (new ones) are listed after, alphabetically. */
export function loadTaskOrder(file = VARS_FILE): string[] {
  const parsed = ConfigFile.safeParse(readConfigFile(file));
  return parsed.success ? parsed.data.taskOrder : [];
}

export function saveTaskOrder(names: string[], file = VARS_FILE): void {
  loadVars(file); // refuses to rewrite a file that is already invalid
  const json = readConfigFile(file) as Record<string, unknown>;
  json.taskOrder = names;
  writeFileSync(file, JSON.stringify(json, null, 2) + '\n');
}

function readConfigFile(file: string): unknown {
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (err) {
    throw new Error(`${file} is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
}

/** Replaces {{vars.NAME}} with its value. An unknown name fails the run before the browser opens. */
export function applyVars(task: string, vars: Record<string, string>): string {
  return task.replace(PLACEHOLDER, (placeholder, name: string) => {
    if (!Object.hasOwn(vars, name)) throw new Error(`${placeholder} is not defined in ${VARS_FILE}`);
    return vars[name];
  });
}
