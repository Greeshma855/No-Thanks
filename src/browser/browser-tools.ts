import { tool, type InvokableTool } from '@strands-agents/sdk';
import { z } from 'zod';
import type { GuardianDecision } from '../agent/decision-schema.js';
import type { PageState } from '../domain/types.js';
import { evaluateAction } from '../safety/action-policy.js';
import { calculateVerificationLevel } from '../verification/consent-verifier.js';
import type { BrowserSession } from './browser-session.js';
import { compactState } from './perception.js';

export type GuardianTool = InvokableTool<never, unknown>;

export function createBrowserTools(
  session: BrowserSession,
  getState: () => PageState,
  minConfidence: number,
) {
  const inspectPage = tool({
    name: 'inspect_page',
    description: 'Return only the current sanitized consent-interface snapshot.',
    inputSchema: z.object({}),
    callback: async () => compactState(await session.inspect()),
  });
  const clickConsentElement = tool({
    name: 'click_consent_element',
    description:
      'Click one registered reject, preference, or save control; arbitrary selectors are impossible.',
    inputSchema: z.object({
      elementId: z.string().regex(/^guardian-element-\d+$/),
      purpose: z.enum(['reject', 'preferences', 'save']),
    }),
    callback: async ({ elementId, purpose }) => {
      const type =
        purpose === 'reject'
          ? 'CLICK_REJECT'
          : purpose === 'preferences'
            ? 'OPEN_PREFERENCES'
            : 'SAVE_PREFERENCES';
      enforce(
        {
          bannerDetected: true,
          darkPatterns: ['UNKNOWN'],
          summary: 'Tool boundary check.',
          confidence: 1,
          action: { type, elementId },
        },
        getState(),
        minConfidence,
      );
      await session.clickRegistered(elementId);
      return { success: true, elementId, purpose };
    },
  });
  const setConsentToggle = tool({
    name: 'set_consent_toggle',
    description: 'Disable one registered, clearly non-essential consent toggle.',
    inputSchema: z.object({
      elementId: z.string().regex(/^guardian-element-\d+$/),
      desiredState: z.literal(false),
    }),
    callback: async ({ elementId, desiredState }) => {
      enforce(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'Tool boundary check.',
          confidence: 1,
          action: { type: 'SET_CONSENT_TOGGLE', elementId, desiredState },
        },
        getState(),
        minConfidence,
      );
      await session.setToggle(elementId, desiredState);
      return { success: true, elementId, desiredState };
    },
  });
  const setConsentToggles = tool({
    name: 'set_consent_toggles',
    description:
      'Disable a model-selected batch of registered non-essential consent toggles and optionally save only after every state is confirmed off.',
    inputSchema: z.object({
      targets: z
        .array(
          z.object({
            elementId: z.string().regex(/^guardian-element-\d+$/),
            desiredState: z.literal(false),
          }),
        )
        .min(1)
        .max(20),
      saveElementId: z
        .string()
        .regex(/^guardian-element-\d+$/)
        .optional(),
    }),
    callback: async ({ targets, saveElementId }) => {
      enforce(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'Batch tool boundary check.',
          confidence: 1,
          action: {
            type: 'SET_CONSENT_TOGGLES',
            targets,
            ...(saveElementId ? { saveElementId } : {}),
          },
        },
        getState(),
        minConfidence,
      );
      return session.setToggles(targets, saveElementId);
    },
  });
  const scrollConsentContainer = tool({
    name: 'scroll_consent_container',
    description:
      'Scroll a registered, verified scrollable consent container and report measured movement.',
    inputSchema: z.object({
      containerId: z
        .string()
        .regex(/^guardian-container-\d+$/)
        .optional(),
      elementId: z
        .string()
        .regex(/^guardian-element-\d+$/)
        .optional(),
      direction: z.enum(['up', 'down']),
      amount: z.enum(['small', 'page']),
    }),
    callback: async ({ containerId, elementId, direction, amount }) => {
      const legacyElement = elementId ? session.registry.get(elementId) : undefined;
      const resolvedContainerId = containerId ?? legacyElement?.containerId;
      if (!resolvedContainerId) throw new Error('Scroll target is not registered');
      enforce(
        {
          bannerDetected: true,
          darkPatterns: ['UNKNOWN'],
          summary: 'Tool boundary check.',
          confidence: 1,
          action: {
            type: 'SCROLL_MODAL',
            containerId: resolvedContainerId,
            direction,
            amount,
            ...(elementId ? { elementId } : {}),
          },
        },
        getState(),
        minConfidence,
      );
      return session.scrollContainer(resolvedContainerId, direction, amount);
    },
  });
  const verifyConsentState = tool({
    name: 'verify_consent_state',
    description: 'Calculate honest, evidence-backed consent verification.',
    inputSchema: z.object({}),
    callback: async () => calculateVerificationLevel(getState(), await session.inspect()),
  });
  return {
    all: [
      inspectPage,
      clickConsentElement,
      setConsentToggle,
      setConsentToggles,
      scrollConsentContainer,
      verifyConsentState,
    ],
    inspectPage,
    clickConsentElement,
    setConsentToggle,
    setConsentToggles,
    scrollConsentContainer,
    verifyConsentState,
  };
}

function enforce(decision: GuardianDecision, state: PageState, minConfidence: number): void {
  const result = evaluateAction(decision, state, minConfidence);
  if (!result.allowed) throw new Error(`Safety policy rejected tool call: ${result.reason}`);
}
