import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config/env.js';
import { createProvider } from '../../src/providers/provider-factory.js';
import { headlessForMode } from '../../src/browser/browser-session.js';

describe('provider and mode selection', () => {
  it('selects mock without touching AWS', () =>
    expect(createProvider(loadConfig({})).name).toBe('mock'));
  it('constructs lazy bedrock provider from configuration', () =>
    expect(
      createProvider(
        loadConfig({
          GUARDIAN_PROVIDER: 'bedrock',
          AWS_REGION: 'us-east-1',
          BEDROCK_MODEL_ID: 'test',
        }),
      ).name,
    ).toBe('bedrock'));
  it('configures OpenAI without making a network call', () => {
    const provider = createProvider(
      loadConfig({
        MODEL_PROVIDER: 'openai',
        OPENAI_API_KEY: 'test-key-never-sent',
        OPENAI_MODEL: 'gpt-5.6-luna',
        OPENAI_MAX_OUTPUT_TOKENS: '321',
      }),
    );
    expect(provider.name).toBe('openai');
    expect(provider.modelId).toBe('gpt-5.6-luna');
  });
  it('wires inspector headed and guardian headless', () => {
    expect(headlessForMode('inspector')).toBe(false);
    expect(headlessForMode('guardian')).toBe(true);
  });
});
