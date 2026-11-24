/**
 * Builds dist/QA-Genie.zip for people who don't use a terminal: the app, this machine's node.exe,
 * production dependencies and a double-click launcher (scripts/zip/Start QA Genie.cmd).
 * Usage: npm run package   (on Windows)
 * The API key and secrets in .env are never included. Its endpoint and model become the starter settings,
 * so people only have to paste the key. tasks/ and qa-genie.config.json become the starter tasks and variables.
 */
import { execFileSync, execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';

if (process.platform !== 'win32') throw new Error('Build the zip on Windows: it bundles the node.exe running this script');

const ROOT = path.join(import.meta.dirname, '..');
const DIST = path.join(ROOT, 'dist');
const NAME = 'QA Genie';
const OUT = path.join(DIST, NAME);
const APP = path.join(OUT, 'app');
const STARTER = path.join(APP, 'starter');
const ZIP = path.join(DIST, 'QA-Genie.zip');

rmSync(DIST, { recursive: true, force: true });
mkdirSync(STARTER, { recursive: true });

for (const item of ['src', 'ui', 'package.json', 'package-lock.json']) cpSync(path.join(ROOT, item), path.join(APP, item), { recursive: true });
for (const file of ['Start QA Genie.cmd', 'README.txt']) cpSync(path.join(ROOT, 'scripts', 'zip', file), path.join(OUT, file));
cpSync(process.execPath, path.join(OUT, 'node', 'node.exe'));

// Installed fresh rather than copied, so development-only packages and local changes stay out.
console.log('Installing production dependencies...');
execSync('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', { cwd: APP, stdio: 'inherit' });

// Deleted tasks (tasks/.deleted) stay behind.
cpSync(path.join(ROOT, 'tasks'), path.join(STARTER, 'tasks'), { recursive: true, filter: (source) => path.basename(source) !== '.deleted' });
if (existsSync(path.join(ROOT, 'qa-genie.config.json'))) cpSync(path.join(ROOT, 'qa-genie.config.json'), path.join(STARTER, 'qa-genie.config.json'));
const dev = existsSync(path.join(ROOT, '.env')) ? parseEnv(readFileSync(path.join(ROOT, '.env'), 'utf8')) : {};
const starterEnv = [
  '# QA Genie settings. Change the model and key in QA Genie: the Settings button at the top left.',
  `FOUNDRY_ENDPOINT=${dev.FOUNDRY_ENDPOINT ?? ''}`,
  `FOUNDRY_MODEL=${dev.FOUNDRY_MODEL ?? ''}`,
  'FOUNDRY_API_KEY=',
  `REASONING_EFFORT=${dev.REASONING_EFFORT ?? ''}`,
  '# The installed Google Chrome, so the zip needs no browser of its own',
  'BROWSER_CHANNEL=chrome',
  'TRACE=false',
  'LOG_REQUESTS=false',
];
writeFileSync(path.join(STARTER, '.env'), starterEnv.join('\r\n') + '\r\n');

// Windows' own tar writes zip files when the name ends in .zip.
console.log('Zipping...');
execFileSync(path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32', 'tar.exe'), ['-a', '-cf', ZIP, NAME], { cwd: DIST, stdio: 'inherit' });
console.log(`\nBuilt ${ZIP} (${Math.round(statSync(ZIP).size / 1e6)} MB). Never contains .env's API key or secrets.`);
