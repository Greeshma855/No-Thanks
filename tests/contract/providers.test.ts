import { describe, expect, it } from 'vitest';
import { Model, type BaseModelConfig, type ModelStreamEvent } from '@strands-agents/sdk';
import { MockProvider } from '../../src/providers/mock-provider.js';
import { BedrockProvider } from '../../src/providers/bedrock-provider.js';
import { OpenAIProvider } from '../../src/providers/openai-provider.js';
import { state } from '../helpers.js';

const expected = {
  bannerDetected: false,
  darkPatterns: ['NONE'] as const,
  summary: 'No banner.',
  confidence: 0.99,
  action: { type: 'NO_BANNER' as const },
};
class ContractModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = { modelId: 'contract' };
  updateConfig(value: BaseModelConfig): void {
    this.config = { ...this.config, ...value };
  }
  getConfig(): BaseModelConfig {
    return this.config;
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield {
      type: 'modelContentBlockStartEvent',
      start: { type: 'toolUseStart', name: 'strands_structured_output', toolUseId: 'contract-1' },
    };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(expected) },
    };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
  }
}

describe.each([
  ['mock', new MockProvider()],
  [
    'mock Bedrock/Strands response',
    new BedrockProvider({
      region: 'test',
      modelId: 'test',
      modelFactory: async () => new ContractModel(),
    }),
  ],
  [
    'mock OpenAI/Strands Responses response',
    new OpenAIProvider({
      apiKey: 'test-key-never-sent',
      modelId: 'gpt-5.6-terra',
      maxTokens: 800,
      modelFactory: () => new ContractModel(),
    }),
  ],
])('%s provider contract', (_name, provider) => {
  it('returns a schema-valid decision without AWS', async () => {
    const decision = await provider.decide(
      state({ bannerDetected: false, containers: [] }),
      { bytes: new Uint8Array([1]), format: 'png' },
      [],
    );
    expect(decision.action.type).toBe('NO_BANNER');
    expect(decision.confidence).toBeGreaterThan(0.75);
  });
});
