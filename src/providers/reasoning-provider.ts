import type { Tool } from '@strands-agents/sdk';
import type { GuardianDecision } from '../agent/decision-schema.js';
import type { PageState } from '../domain/types.js';

export interface ReasoningProvider {
  readonly name: 'mock' | 'bedrock' | 'openai';
  readonly modelId?: string;
  decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision>;
}

export interface ModelScreenshot {
  bytes: Uint8Array;
  format: 'png' | 'jpeg';
}

export type ProviderErrorCode =
  | 'CONFIGURATION'
  | 'AUTHORIZATION'
  | 'THROTTLED'
  | 'UNAVAILABLE'
  | 'MALFORMED_OUTPUT';
export class ProviderError extends Error {
  override readonly name = 'ProviderError';
  constructor(
    readonly code: ProviderErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
