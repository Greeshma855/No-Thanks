import type { Model, Tool } from '@strands-agents/sdk';
import type { GuardianDecision } from '../agent/decision-schema.js';
import { invokeGuardianReasoning } from '../agent/guardian-agent.js';
import type { PageState } from '../domain/types.js';
import {
  ProviderError,
  type ModelScreenshot,
  type ReasoningProvider,
} from './reasoning-provider.js';

export interface BedrockProviderOptions {
  region: string;
  modelId: string;
  modelFactory?: () => Promise<Model>;
}

export class BedrockProvider implements ReasoningProvider {
  readonly name = 'bedrock' as const;
  readonly modelId: string;
  constructor(private readonly options: BedrockProviderOptions) {
    this.modelId = options.modelId;
  }
  async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    try {
      const model = await (this.options.modelFactory
        ? this.options.modelFactory()
        : this.createModel());
      return await invokeGuardianReasoning(model, state, screenshot, tools);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /credential|accessdenied|unauthori/i.test(message)
        ? 'AUTHORIZATION'
        : /throttl|rate exceeded/i.test(message)
          ? 'THROTTLED'
          : /validation|schema|structured/i.test(message)
            ? 'MALFORMED_OUTPUT'
            : 'UNAVAILABLE';
      throw new ProviderError(code, `Bedrock ${code.toLowerCase()}: ${message}`, { cause: error });
    }
  }
  private async createModel(): Promise<Model> {
    const { BedrockModel } = await import('@strands-agents/sdk');
    return new BedrockModel({
      region: this.options.region,
      modelId: this.options.modelId,
      maxTokens: 1200,
      temperature: 0,
      stream: true,
    });
  }
}
