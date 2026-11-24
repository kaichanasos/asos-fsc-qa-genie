import { DefaultAzureCredential, getBearerTokenProvider } from '@azure/identity';
import OpenAI from 'openai';
import type { Config } from './config.ts';

/** Client for the Foundry OpenAI-compatible (v1) endpoint. Uses Entra ID unless an API key is configured. */
export function createLlmClient(config: Pick<Config, 'endpoint' | 'apiKey' | 'tokenScope'>): OpenAI {
  const apiKey = config.apiKey ?? getBearerTokenProvider(new DefaultAzureCredential(), config.tokenScope);
  return new OpenAI({ baseURL: config.endpoint, apiKey, maxRetries: 3 });
}
