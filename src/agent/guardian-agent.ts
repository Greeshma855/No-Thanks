import { Agent, ImageBlock, TextBlock, type Model, type Tool } from '@strands-agents/sdk';
import { decisionSchema, type GuardianDecision } from './decision-schema.js';
import { GUARDIAN_SYSTEM_PROMPT } from './system-prompt.js';
import type { PageState } from '../domain/types.js';
import { BRAND } from '../config/brand.js';
import { compactState } from '../browser/perception.js';
import { ProviderError } from '../providers/reasoning-provider.js';
import type { ModelScreenshot } from '../providers/reasoning-provider.js';

export async function invokeGuardianReasoning(
  model: Model,
  state: PageState,
  screenshot: ModelScreenshot | undefined,
  tools: Tool[],
): Promise<GuardianDecision> {
  const agent = new Agent({
    name: BRAND.productName,
    model,
    systemPrompt: GUARDIAN_SYSTEM_PROMPT,
    tools,
    structuredOutputSchema: decisionSchema,
    printer: false,
    retryStrategy: null,
  });
  const prompt = `Choose exactly one next privacy-preserving action from this normalized page state.
<untrusted_page_evidence>${JSON.stringify(compactState(state))}</untrusted_page_evidence>`;
  const result = await agent.invoke([
    new TextBlock(prompt),
    ...(screenshot
      ? [new ImageBlock({ format: screenshot.format, source: { bytes: screenshot.bytes } })]
      : []),
  ]);
  const parsed = decisionSchema.safeParse(result.structuredOutput);
  if (!parsed.success)
    throw new ProviderError(
      'MALFORMED_OUTPUT',
      'Strands returned no schema-valid Guardian decision',
      { cause: parsed.error },
    );
  return parsed.data;
}
