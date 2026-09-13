import { describe, expect, it } from 'vitest';
import {
  isEligibleBrowserUrl,
  isRemoteAnalysisAllowed,
} from '../../src/safety/remote-host-policy.js';

describe('remote analysis and navigation policy', () => {
  it('allows exact hosts, subdomain wildcards, and explicit global opt-in', () => {
    expect(isRemoteAnalysisAllowed('https://example.com/path?token=secret', 'example.com')).toBe(
      true,
    );
    expect(isRemoteAnalysisAllowed('https://www.example.org', '*.example.org')).toBe(true);
    expect(isRemoteAnalysisAllowed('https://example.org', '*.example.org')).toBe(false);
    expect(isRemoteAnalysisAllowed('https://elsewhere.test', '*')).toBe(true);
  });

  it('blocks unapproved hosts and unsupported browser protocols', () => {
    expect(isRemoteAnalysisAllowed('https://evil-example.com', 'example.com')).toBe(false);
    for (const url of [
      'about:blank',
      'chrome://settings',
      'edge://settings',
      'devtools://devtools',
      'file:///private.txt',
      'mailto:test@example.com',
    ])
      expect(isEligibleBrowserUrl(url)).toBe(false);
    expect(isEligibleBrowserUrl('https://example.com')).toBe(true);
  });
});
