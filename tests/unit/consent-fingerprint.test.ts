import { describe, expect, it } from 'vitest';
import { consentStateFingerprint } from '../../src/browser/perception.js';
import { state } from '../helpers.js';

describe('consent-state fingerprint', () => {
  it('ignores unrelated advertising frame animations and navigation', () => {
    const first = state({
      frames: [
        { index: 0, url: 'https://example.test', name: '', accessible: true },
        { index: 1, url: 'https://ads.test/creative-one', name: 'advert', accessible: true },
      ],
    });
    const second = state({
      frames: [
        { index: 0, url: 'https://example.test', name: '', accessible: true },
        { index: 1, url: 'https://ads.test/creative-two', name: 'advert', accessible: true },
      ],
    });
    expect(consentStateFingerprint(first)).toBe(consentStateFingerprint(second));
  });

  it('changes when registered consent controls or their states change', () => {
    const first = state({
      elements: [
        {
          id: 'guardian-element-1',
          frameIndex: 0,
          frameUrl: 'https://example.test',
          role: 'checkbox',
          name: 'Analytics',
          label: 'Analytics cookies',
          bounds: { x: 0, y: 0, width: 20, height: 20 },
          checked: true,
          disabled: false,
          kind: 'checkbox',
          containerId: 'guardian-container-1',
        },
      ],
    });
    const second = state({
      elements: [{ ...first.elements[0]!, checked: false }],
    });
    expect(consentStateFingerprint(first)).not.toBe(consentStateFingerprint(second));
  });

  it('ignores registry IDs, enumeration order, scroll offsets, and minor layout changes', () => {
    const first = state({
      elements: [
        {
          id: 'guardian-element-1',
          frameIndex: 0,
          frameUrl: 'https://cmp.example.test/preferences',
          role: 'switch',
          name: 'Analytics cookies',
          label: 'Analytics cookies',
          categoryLabel: 'Analytics cookies',
          bounds: { x: 10, y: 20, width: 50, height: 28 },
          checked: true,
          ariaChecked: 'true',
          disabled: false,
          kind: 'switch',
          containerId: 'guardian-container-1',
        },
        {
          id: 'guardian-element-2',
          frameIndex: 0,
          frameUrl: 'https://cmp.example.test/preferences',
          role: 'button',
          name: 'Confirm choices',
          label: '',
          bounds: { x: 20, y: 80, width: 120, height: 40 },
          disabled: false,
          kind: 'button',
          containerId: 'guardian-container-1',
        },
      ],
      containers: [
        {
          ...state().containers[0]!,
          frameUrl: 'https://cmp.example.test/preferences',
          scrollTop: 10,
          scrollHeight: 800,
          clientHeight: 300,
          scrollable: true,
        },
      ],
    });
    const second = state({
      elements: [...first.elements].reverse().map((element, index) => ({
        ...element,
        id: `guardian-element-${index + 50}`,
        containerId: 'guardian-container-99',
        frameIndex: 4,
        bounds: { ...element.bounds, y: element.bounds.y + 2 },
      })),
      containers: [
        {
          ...first.containers[0]!,
          id: 'guardian-container-99',
          frameIndex: 4,
          scrollTop: 240,
          clientHeight: 302,
        },
      ],
    });
    expect(consentStateFingerprint(first)).toBe(consentStateFingerprint(second));
  });
});
