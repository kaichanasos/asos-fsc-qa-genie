// Temporary probe: does a model accept QA Genie's exact request shape, and how fast is it?
import OpenAI from 'openai';
import { readFileSync } from 'node:fs';

const [, , model, reqFile] = process.argv;
const llm = new OpenAI({ baseURL: process.env.FOUNDRY_ENDPOINT, apiKey: process.env.FOUNDRY_API_KEY, maxRetries: 0 });
const saved = JSON.parse(readFileSync(reqFile, 'utf8'));
const request = { ...saved, model };
for (const key of ['reasoning', 'include']) if (process.argv.includes(`--no-${key}`)) delete request[key];

const t0 = Date.now();
try {
  const r = await llm.responses.create(request);
  const calls = r.output.filter((o) => o.type === 'function_call').map((o) => `${o.name} ${o.arguments}`);
  console.log(JSON.stringify({ model, ms: Date.now() - t0, usage: r.usage, calls, text: r.output_text.slice(0, 200) }, null, 2));
} catch (err) {
  console.log(JSON.stringify({ model, ms: Date.now() - t0, error: `${err.status ?? ''} ${err.message}`.slice(0, 600) }, null, 2));
}
