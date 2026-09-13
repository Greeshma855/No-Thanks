import type { GuardianDecision } from '../agent/decision-schema.js';
import type { ConsentContainer, ConsentElement, PageState } from '../domain/types.js';
import { findRegisteredContainer, findRegisteredElement } from './target-validator.js';

const rejectWords =
  /\b(reject|deny|decline|refuse|necessary only|essential only|opt out|no[\s,]+thank(?:s| you))\b/i;
const preferenceWords = /\b(manage|preferences?|settings|customi[sz]e|options)\b/i;
const saveWords = /\b(save|confirm|apply)\b/i;
const forbiddenWords =
  /\b(accept|allow all|agree|enable all|purchase|buy|checkout|order|delete account|remove account|sign in|log in|authenticate|download|subscribe|submit)\b/i;
const nonEssentialWords =
  /\b(analytics|marketing|tracking|targeting|social|performance|functional)\b|advertis|personali/i;
const essentialWords = /\b(necessary|essential|required|strictly necessary|always active)\b/i;

export interface PolicyResult {
  allowed: boolean;
  reason: string;
  element?: ConsentElement;
  elements?: ConsentElement[];
  saveElement?: ConsentElement;
  container?: ConsentContainer;
}
export function evaluateAction(
  decision: GuardianDecision,
  state: PageState,
  minConfidence: number,
): PolicyResult {
  if (decision.confidence < minConfidence)
    return { allowed: false, reason: `confidence ${decision.confidence} below ${minConfidence}` };
  if (['STOP_SUCCESS', 'STOP_UNCERTAIN', 'NO_BANNER'].includes(decision.action.type))
    return { allowed: true, reason: 'non-interactive terminal action' };
  const visibleReject = state.elements.find(
    (candidate) => !candidate.disabled && rejectWords.test(`${candidate.name} ${candidate.label}`),
  );
  if (decision.action.type === 'SCROLL_MODAL') {
    const legacyElement = decision.action.elementId
      ? findRegisteredElement(state, decision.action.elementId)
      : undefined;
    const containerId = decision.action.containerId ?? legacyElement?.containerId;
    const container = containerId ? findRegisteredContainer(state, containerId) : undefined;
    if (!container)
      return { allowed: false, reason: 'scroll target is not a registered consent container' };
    if (!container.scrollable || container.scrollHeight <= container.clientHeight)
      return {
        allowed: false,
        reason: 'registered consent container is not scrollable',
        container,
      };
    if (legacyElement && legacyElement.containerId !== container.id)
      return { allowed: false, reason: 'legacy scroll element is outside the target container' };
    if (visibleReject)
      return {
        allowed: false,
        reason: 'an explicit rejection control is already visible and must be preferred',
        container,
      };
    return {
      allowed: true,
      reason: 'scroll is confined to a registered consent container',
      container,
    };
  }
  if (decision.action.type === 'SET_CONSENT_TOGGLES') {
    if (visibleReject)
      return {
        allowed: false,
        reason: 'an explicit rejection control is already visible and must be preferred',
      };
    const targets = decision.action.targets ?? [];
    if (targets.length === 0)
      return { allowed: false, reason: 'batch toggle action has no targets' };
    if (new Set(targets.map(({ elementId }) => elementId)).size !== targets.length)
      return { allowed: false, reason: 'batch toggle action contains duplicate targets' };
    const elements: ConsentElement[] = [];
    for (const target of targets) {
      if (target.desiredState !== false)
        return { allowed: false, reason: 'enabling consent is prohibited' };
      const element = findRegisteredElement(state, target.elementId);
      const problem = element ? toggleSafetyProblem(element) : 'target is not currently registered';
      if (problem) return { allowed: false, reason: `${target.elementId}: ${problem}` };
      elements.push(element!);
    }
    const saveElement = decision.action.saveElementId
      ? findRegisteredElement(state, decision.action.saveElementId)
      : undefined;
    if (decision.action.saveElementId && !saveElement)
      return { allowed: false, reason: 'save target is not currently registered' };
    if (saveElement) {
      const saveProblem = interactiveSafetyProblem(saveElement);
      if (saveProblem) return { allowed: false, reason: `save target: ${saveProblem}` };
      if (
        !['button', 'link'].includes(saveElement.kind) ||
        !saveWords.test(elementText(saveElement))
      )
        return { allowed: false, reason: 'save target is not a save/apply control' };
      if (
        !elements.every(
          (element) =>
            element.frameIndex === saveElement.frameIndex &&
            element.frameUrl === saveElement.frameUrl,
        )
      )
        return {
          allowed: false,
          reason: 'batch toggles and save target are not in one consent surface',
        };
    }
    return {
      allowed: true,
      reason: 'batch contains only registered non-essential consent toggles',
      elements,
      ...(saveElement ? { saveElement } : {}),
    };
  }
  const element = decision.action.elementId
    ? findRegisteredElement(state, decision.action.elementId)
    : undefined;
  if (!element) return { allowed: false, reason: 'target is not currently registered' };
  if (visibleReject && decision.action.type !== 'CLICK_REJECT')
    return {
      allowed: false,
      reason: 'an explicit rejection control is already visible and must be preferred',
      element,
    };
  const interactiveProblem = interactiveSafetyProblem(element);
  if (interactiveProblem) return { allowed: false, reason: interactiveProblem, element };
  if (
    element.kind === 'link' &&
    element.href &&
    new URL(element.href).origin !== new URL(state.url).origin
  )
    return { allowed: false, reason: 'cross-origin consent links are prohibited', element };
  const text = `${element.name} ${element.label}`.trim();
  if (forbiddenWords.test(text))
    return {
      allowed: false,
      reason: 'target could expand consent or leave the safe scope',
      element,
    };
  if (decision.action.type === 'CLICK_REJECT' && !rejectWords.test(text))
    return { allowed: false, reason: 'target is not an explicit rejection control', element };
  if (
    decision.action.type === 'OPEN_PREFERENCES' &&
    (!['button', 'link'].includes(element.kind) || !preferenceWords.test(text))
  )
    return { allowed: false, reason: 'target is not a preference control', element };
  if (decision.action.type === 'OPEN_PREFERENCES' && visibleReject)
    return {
      allowed: false,
      reason: 'an explicit rejection control is already visible and must be preferred',
      element,
    };
  if (
    decision.action.type === 'SAVE_PREFERENCES' &&
    (!['button', 'link'].includes(element.kind) || !saveWords.test(text))
  )
    return { allowed: false, reason: 'target is not a save/apply control', element };
  if (decision.action.type === 'SET_CONSENT_TOGGLE') {
    if (decision.action.desiredState !== false)
      return { allowed: false, reason: 'enabling consent is prohibited', element };
    const problem = toggleSafetyProblem(element);
    if (problem) return { allowed: false, reason: problem, element };
  }
  return { allowed: true, reason: 'action is narrowly scoped to consent rejection', element };
}
export function actionFingerprint(decision: GuardianDecision, state: PageState): string {
  return JSON.stringify({
    type: decision.action.type,
    elementId: decision.action.elementId,
    containerId: decision.action.containerId,
    direction: decision.action.direction,
    amount: decision.action.amount,
    desiredState: decision.action.desiredState,
    targets: decision.action.targets,
    saveElementId: decision.action.saveElementId,
    url: state.url,
    elements: state.elements.map((element) => [element.id, element.checked]),
    containers: state.containers.map((container) => [container.id, container.scrollTop]),
    banner: state.bannerDetected,
  });
}

function elementText(element: ConsentElement): string {
  return `${element.name} ${element.label} ${element.categoryLabel ?? ''}`.trim();
}

function interactiveSafetyProblem(element: ConsentElement): string | undefined {
  if (element.disabled) return 'target is disabled';
  if (element.submitsForm) return 'form submission is prohibited';
  if (element.downloads) return 'downloads are prohibited';
  if (forbiddenWords.test(elementText(element)))
    return 'target could expand consent or leave the safe scope';
  return undefined;
}

function toggleSafetyProblem(element: ConsentElement): string | undefined {
  const interactiveProblem = interactiveSafetyProblem(element);
  if (interactiveProblem) return interactiveProblem;
  if (!['checkbox', 'switch'].includes(element.kind)) return 'target is not a toggle';
  const text = elementText(element);
  if (essentialWords.test(text) || !nonEssentialWords.test(text))
    return 'toggle is essential or not clearly non-essential';
  return undefined;
}
