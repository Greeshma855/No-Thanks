import type { Model, Tool } from '@strands-agents/sdk';
import { OpenAIModel } from '@strands-agents/sdk/models/openai';
import type { GuardianDecision } from '../agent/decision-schema.js';
import { invokeGuardianReasoning } from '../agent/guardian-agent.js';
import type { PageState } from '../domain/types.js';
import {
  ProviderError,
  type ModelScreenshot,
  type ReasoningProvider,
} from './reasoning-provider.js';

export interface OpenAIProviderOptions {
  apiKey: string;
  modelId: string;
  maxTokens: number;
  modelFactory?: () => Model | Promise<Model>;
}

export class OpenAIProvider implements ReasoningProvider {
  readonly name = 'openai' as const;
  readonly modelId: string;

  constructor(private readonly options: OpenAIProviderOptions) {
    this.modelId = options.modelId;
  }

  async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    try {
      const model = this.options.modelFactory
        ? await this.options.modelFactory()
        : new OpenAIModel({
            api: 'responses',
            apiKey: this.options.apiKey,
            modelId: this.options.modelId,
            maxTokens: this.options.maxTokens,
            stateful: false,
          });
      return await invokeGuardianReasoning(model, state, screenshot, tools);
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const code = /api.?key|auth|unauthori|permission/i.test(message)
        ? 'AUTHORIZATION'
        : /rate.?limit|throttl|429/i.test(message)
          ? 'THROTTLED'
          : /validation|schema|structured|json/i.test(message)
            ? 'MALFORMED_OUTPUT'
            : 'UNAVAILABLE';
      throw new ProviderError(code, `OpenAI ${code.toLowerCase()}: ${message}`, { cause: error });
    }
  }
}
