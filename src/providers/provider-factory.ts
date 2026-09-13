import type { GuardianConfig } from '../config/env.js';
import { BedrockProvider } from './bedrock-provider.js';
import { MockProvider } from './mock-provider.js';
import { OpenAIProvider } from './openai-provider.js';
import type { ReasoningProvider } from './reasoning-provider.js';

export function createProvider(config: GuardianConfig): ReasoningProvider {
  if (config.MODEL_PROVIDER === 'mock') return new MockProvider();
  if (config.MODEL_PROVIDER === 'openai') {
    if (!config.OPENAI_API_KEY)
      throw new Error('OpenAI requires OPENAI_API_KEY when MODEL_PROVIDER=openai');
    return new OpenAIProvider({
      apiKey: config.OPENAI_API_KEY,
      modelId: config.OPENAI_MODEL,
      maxTokens: config.OPENAI_MAX_OUTPUT_TOKENS,
    });
  }
  if (!config.AWS_REGION || !config.BEDROCK_MODEL_ID)
    throw new Error('Bedrock requires AWS_REGION and BEDROCK_MODEL_ID');
  return new BedrockProvider({ region: config.AWS_REGION, modelId: config.BEDROCK_MODEL_ID });
}
