import { describe, expect, it } from 'vitest';
import { actionFingerprint, evaluateAction } from '../../src/safety/action-policy.js';
import { isInternalElementId } from '../../src/safety/target-validator.js';
import { state } from '../helpers.js';

const page = state({
  elements: [
    {
      id: 'guardian-element-1',
      role: 'button',
      name: 'Reject All',
      label: '',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      disabled: false,
      kind: 'button',
      containerId: 'guardian-container-1',
    },
    {
      id: 'guardian-element-2',
      role: 'button',
      name: 'Accept All',
      label: '',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      disabled: false,
      kind: 'button',
      containerId: 'guardian-container-1',
    },
    {
      id: 'guardian-element-3',
      role: 'checkbox',
      name: '',
      label: 'Analytics tracking',
      bounds: { x: 0, y: 0, width: 10, height: 10 },
      checked: true,
      disabled: false,
      kind: 'checkbox',
      containerId: 'guardian-container-1',
    },
  ],
});

describe('action safety', () => {
  it('allows reject and disabling non-essential tracking', () => {
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['NONE'],
          summary: 'reject',
          confidence: 0.9,
          action: { type: 'CLICK_REJECT', elementId: 'guardian-element-1' },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'do not bypass reject',
          confidence: 0.9,
          action: {
            type: 'SET_CONSENT_TOGGLE',
            elementId: 'guardian-element-3',
            desiredState: false,
          },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'off',
          confidence: 0.9,
          action: {
            type: 'SET_CONSENT_TOGGLE',
            elementId: 'guardian-element-3',
            desiredState: false,
          },
        },
        state({ elements: [page.elements[2]!] }),
        0.75,
      ).allowed,
    ).toBe(true);
  });
  it('denies acceptance, stale IDs, and low confidence', () => {
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['UNKNOWN'],
          summary: 'bad',
          confidence: 0.9,
          action: { type: 'CLICK_REJECT', elementId: 'guardian-element-2' },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['UNKNOWN'],
          summary: 'stale',
          confidence: 0.9,
          action: { type: 'CLICK_REJECT', elementId: 'guardian-element-99' },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(false);
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['UNKNOWN'],
          summary: 'low',
          confidence: 0.5,
          action: { type: 'STOP_UNCERTAIN' },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(false);
  });
  it('allows only verified scrollable consent containers and never ordinary buttons', () => {
    const scrollState = state({
      elements: [],
      containers: [
        {
          ...page.containers[0]!,
          scrollHeight: 900,
          clientHeight: 300,
          scrollable: true,
        },
      ],
    });
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['OBSTRUCTION'],
          summary: 'scroll',
          confidence: 0.9,
          action: {
            type: 'SCROLL_MODAL',
            containerId: 'guardian-container-1',
            direction: 'down',
            amount: 'page',
          },
        },
        scrollState,
        0.75,
      ).allowed,
    ).toBe(true);
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['OBSTRUCTION'],
          summary: 'bad scroll',
          confidence: 0.9,
          action: {
            type: 'SCROLL_MODAL',
            elementId: 'guardian-element-1',
            direction: 'down',
            amount: 'page',
          },
        },
        page,
        0.75,
      ).allowed,
    ).toBe(false);
  });
  it('rejects purchase, authentication, deletion, download, and unrelated submit controls', () => {
    const forbidden = ['Buy now', 'Log in', 'Delete Account', 'Download', 'Submit order'];
    for (const [index, name] of forbidden.entries()) {
      const unsafePage = state({
        elements: [
          {
            ...page.elements[0]!,
            id: `guardian-element-${index + 10}`,
            name,
          },
        ],
      });
      expect(
        evaluateAction(
          {
            bannerDetected: true,
            darkPatterns: ['UNKNOWN'],
            summary: 'unsafe',
            confidence: 1,
            action: {
              type: 'CLICK_REJECT',
              elementId: `guardian-element-${index + 10}`,
            },
          },
          unsafePage,
          0.75,
        ).allowed,
      ).toBe(false);
    }
    for (const metadata of [{ submitsForm: true }, { downloads: true }]) {
      const unsafePage = state({
        elements: [{ ...page.elements[0]!, ...metadata }],
      });
      expect(
        evaluateAction(
          {
            bannerDetected: true,
            darkPatterns: ['UNKNOWN'],
            summary: 'unsafe metadata',
            confidence: 1,
            action: { type: 'CLICK_REJECT', elementId: 'guardian-element-1' },
          },
          unsafePage,
          0.75,
        ).allowed,
      ).toBe(false);
    }
  });
  it('validates internal IDs and creates stable loop fingerprints', () => {
    expect(isInternalElementId('guardian-element-12')).toBe(true);
    expect(isInternalElementId('#accept')).toBe(false);
    const decision = {
      bannerDetected: true,
      darkPatterns: ['NONE'] as const,
      summary: 'reject',
      confidence: 0.9,
      action: { type: 'CLICK_REJECT' as const, elementId: 'guardian-element-1' },
    };
    expect(actionFingerprint(decision, page)).toBe(actionFingerprint(decision, page));
  });
  it('allows a validated batch of optional toggles and blocks necessary categories', () => {
    const optionalOnly = state({ elements: [page.elements[2]!] });
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'disable optional controls',
          confidence: 1,
          action: {
            type: 'SET_CONSENT_TOGGLES',
            targets: [{ elementId: 'guardian-element-3', desiredState: false }],
          },
        },
        optionalOnly,
        0.75,
      ).allowed,
    ).toBe(true);
    const necessary = state({
      elements: [
        {
          ...page.elements[2]!,
          name: 'Strictly necessary cookies — Always Active',
        },
      ],
    });
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'unsafe batch',
          confidence: 1,
          action: {
            type: 'SET_CONSENT_TOGGLES',
            targets: [{ elementId: 'guardian-element-3', desiredState: false }],
          },
        },
        necessary,
        0.75,
      ).allowed,
    ).toBe(false);
    for (const elements of [
      [{ ...page.elements[2]!, disabled: true }],
      [{ ...page.elements[2]!, kind: 'button' as const, role: 'button' }],
    ]) {
      expect(
        evaluateAction(
          {
            bannerDetected: true,
            darkPatterns: ['PRESELECTED_TRACKING'],
            summary: 'invalid batch',
            confidence: 1,
            action: {
              type: 'SET_CONSENT_TOGGLES',
              targets: [{ elementId: 'guardian-element-3', desiredState: false }],
            },
          },
          state({ elements }),
          0.75,
        ).allowed,
      ).toBe(false);
    }
    expect(
      evaluateAction(
        {
          bannerDetected: true,
          darkPatterns: ['PRESELECTED_TRACKING'],
          summary: 'unknown batch target',
          confidence: 1,
          action: {
            type: 'SET_CONSENT_TOGGLES',
            targets: [{ elementId: 'guardian-element-99', desiredState: false }],
          },
        },
        optionalOnly,
        0.75,
      ).allowed,
    ).toBe(false);
  });
});
