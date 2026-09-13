import { Model, type BaseModelConfig, type ModelStreamEvent, type Tool } from '@strands-agents/sdk';
import type { GuardianDecision } from '../agent/decision-schema.js';
import { invokeGuardianReasoning } from '../agent/guardian-agent.js';
import type { DarkPattern, PageState } from '../domain/types.js';
import type { ModelScreenshot, ReasoningProvider } from './reasoning-provider.js';

class DeterministicDecisionModel extends Model<BaseModelConfig> {
  private config: BaseModelConfig = {
    modelId: 'guardian-deterministic-mock',
    contextWindowLimit: 32_000,
  };
  constructor(private readonly decision: GuardianDecision) {
    super();
  }
  updateConfig(config: BaseModelConfig): void {
    this.config = { ...this.config, ...config };
  }
  getConfig(): BaseModelConfig {
    return { ...this.config };
  }
  async *stream(): AsyncIterable<ModelStreamEvent> {
    yield { type: 'modelMessageStartEvent', role: 'assistant' };
    yield {
      type: 'modelContentBlockStartEvent',
      start: {
        type: 'toolUseStart',
        name: 'strands_structured_output',
        toolUseId: 'guardian-decision-1',
      },
    };
    yield {
      type: 'modelContentBlockDeltaEvent',
      delta: { type: 'toolUseInputDelta', input: JSON.stringify(this.decision) },
    };
    yield { type: 'modelContentBlockStopEvent' };
    yield { type: 'modelMessageStopEvent', stopReason: 'toolUse' };
    yield {
      type: 'modelMetadataEvent',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      metrics: { latencyMs: 0 },
    };
  }
}

export class MockProvider implements ReasoningProvider {
  readonly name = 'mock' as const;
  async decide(
    state: PageState,
    screenshot: ModelScreenshot | undefined,
    tools: Tool[],
  ): Promise<GuardianDecision> {
    return invokeGuardianReasoning(
      new DeterministicDecisionModel(mockDecision(state)),
      state,
      screenshot,
      tools,
    );
  }
}

export function mockDecision(state: PageState): GuardianDecision {
  if (!state.bannerDetected)
    return {
      bannerDetected: false,
      darkPatterns: ['NONE'],
      summary: 'No visible cookie-consent interface remains.',
      confidence: 0.99,
      action: { type: 'NO_BANNER' },
    };
  const text = state.sanitizedText;
  const patterns: DarkPattern[] = [];
  const elements = state.elements;
  const hasAccept = elements.some((element) =>
    /accept|allow all|agree/i.test(`${element.name} ${element.label}`),
  );
  const reject = elements.find((element) =>
    /\b(reject|deny|decline|refuse|necessary only|essential only|opt out|no[\s,]+thank(?:s| you))\b/i.test(
      `${element.name} ${element.label}`,
    ),
  );
  const preferences = elements.find(
    (element) =>
      ['button', 'link'].includes(element.kind) &&
      /\b(manage|preferences?|settings|customi[sz]e|options)\b/i.test(
        `${element.name} ${element.label}`,
      ) &&
      !/\b(save|confirm|apply)\b/i.test(`${element.name} ${element.label}`),
  );
  const enabledNonEssential = elements.filter(
    (element) =>
      element.checked === true &&
      /analytics|advertis|marketing|tracking|targeting|personal|social|performance|functional/i.test(
        `${element.name} ${element.label} ${element.categoryLabel ?? ''}`,
      ),
  );
  const save = elements.find(
    (element) =>
      ['button', 'link'].includes(element.kind) &&
      /\b(save|confirm|apply)\b/i.test(`${element.name} ${element.label}`),
  );
  const scrollable = state.containers.find(
    (container) =>
      container.scrollable && container.scrollTop + container.clientHeight < container.scrollHeight,
  );
  if (hasAccept && (reject || preferences)) patterns.push('ASYMMETRIC_EMPHASIS');
  if (!reject && preferences) patterns.push('HIDDEN_REJECTION', 'MULTI_LAYERED_CONSENT');
  if (enabledNonEssential.length > 0) patterns.push('PRESELECTED_TRACKING');
  if (
    /partners may|improve your experience|legitimate interest|continue without/i.test(text) &&
    !reject &&
    !preferences
  )
    patterns.push('CONFUSING_WORDING');
  if (reject)
    return {
      bannerDetected: true,
      darkPatterns: patterns.length ? patterns : ['NONE'],
      summary: 'Use the explicit rejection control.',
      confidence: 0.99,
      action: { type: 'CLICK_REJECT', elementId: reject.id },
    };
  if (enabledNonEssential.length > 0)
    return {
      bannerDetected: true,
      darkPatterns: patterns.length ? patterns : ['PRESELECTED_TRACKING'],
      summary: `Disable ${enabledNonEssential.length} preselected non-essential consent control(s)${save ? ' and confirm the choices' : ''}.`,
      confidence: 0.98,
      action: {
        type: 'SET_CONSENT_TOGGLES',
        targets: enabledNonEssential.map(({ id }) => ({
          elementId: id,
          desiredState: false as const,
        })),
        ...(save ? { saveElementId: save.id } : {}),
      },
    };
  if (preferences)
    return {
      bannerDetected: true,
      darkPatterns: patterns.length ? patterns : ['HIDDEN_REJECTION'],
      summary: 'Open the consent preferences to find strict rejection controls.',
      confidence: 0.96,
      action: { type: 'OPEN_PREFERENCES', elementId: preferences.id },
    };
  if (scrollable)
    return {
      bannerDetected: true,
      darkPatterns: patterns.length ? patterns : ['OBSTRUCTION'],
      summary: 'Scroll the registered consent region to reveal additional privacy controls.',
      confidence: 0.95,
      action: {
        type: 'SCROLL_MODAL',
        containerId: scrollable.id,
        direction: 'down',
        amount: 'page',
      },
    };
  if (save && enabledNonEssential.length === 0 && !scrollable)
    return {
      bannerDetected: true,
      darkPatterns: patterns.length ? patterns : ['MULTI_LAYERED_CONSENT'],
      summary: 'Save the privacy-preserving toggle choices.',
      confidence: 0.97,
      action: { type: 'SAVE_PREFERENCES', elementId: save.id },
    };
  return {
    bannerDetected: true,
    darkPatterns: patterns.length ? patterns : ['UNKNOWN'],
    summary: 'The visible controls do not provide an unambiguous privacy-preserving action.',
    confidence: 0.55,
    action: { type: 'STOP_UNCERTAIN' },
  };
}
