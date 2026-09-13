import { z } from 'zod';
import { darkPatternSchema, guardianActionSchema } from '../domain/types.js';

export const decisionSchema = z
  .object({
    bannerDetected: z.boolean(),
    darkPatterns: z.array(darkPatternSchema).min(1),
    summary: z.string().trim().min(1).max(240),
    confidence: z.number().min(0).max(1),
    action: z
      .object({
        type: guardianActionSchema,
        elementId: z
          .string()
          .regex(/^guardian-element-\d+$/)
          .optional(),
        containerId: z
          .string()
          .regex(/^guardian-container-\d+$/)
          .optional(),
        direction: z.enum(['up', 'down']).optional(),
        amount: z.enum(['small', 'page']).optional(),
        desiredState: z.boolean().optional(),
        targets: z
          .array(
            z
              .object({
                elementId: z.string().regex(/^guardian-element-\d+$/),
                desiredState: z.literal(false),
              })
              .strict(),
          )
          .min(1)
          .max(20)
          .optional(),
        saveElementId: z
          .string()
          .regex(/^guardian-element-\d+$/)
          .optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((decision, context) => {
    const needsElement = [
      'CLICK_REJECT',
      'OPEN_PREFERENCES',
      'SET_CONSENT_TOGGLE',
      'SAVE_PREFERENCES',
    ].includes(decision.action.type);
    if (needsElement && !decision.action.elementId)
      context.addIssue({
        code: 'custom',
        path: ['action', 'elementId'],
        message: 'elementId is required for an interactive action',
      });
    if (
      decision.action.type === 'SCROLL_MODAL' &&
      !decision.action.containerId &&
      !decision.action.elementId
    )
      context.addIssue({
        code: 'custom',
        path: ['action', 'containerId'],
        message: 'containerId is required for scrolling',
      });
    if (
      decision.action.type === 'SCROLL_MODAL' &&
      (!decision.action.direction || !decision.action.amount)
    )
      context.addIssue({
        code: 'custom',
        path: ['action'],
        message: 'scrolling requires direction and amount',
      });
    if (decision.action.type === 'SET_CONSENT_TOGGLE' && decision.action.desiredState !== false)
      context.addIssue({
        code: 'custom',
        path: ['action', 'desiredState'],
        message: 'non-essential consent may only be disabled',
      });
    if (decision.action.type === 'SET_CONSENT_TOGGLES' && !decision.action.targets)
      context.addIssue({
        code: 'custom',
        path: ['action', 'targets'],
        message: 'at least one registered toggle target is required',
      });
  })
  .describe('One concise, privacy-preserving browser decision.');
export type GuardianDecision = z.infer<typeof decisionSchema>;
