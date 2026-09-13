import { describe, expect, it } from 'vitest';
import { ConfigurationError, loadConfig } from '../../src/config/env.js';

describe('environment validation', () => {
  it('defaults to AWS-free mock inspector mode', () => {
    const config = loadConfig({});
    expect(config.GUARDIAN_PROVIDER).toBe('mock');
    expect(config.MODEL_PROVIDER).toBe('mock');
    expect(config.GUARDIAN_MODE).toBe('inspector');
    expect(config.GUARDIAN_DISPLAY_PROFILE).toBe('laptop');
    expect(config.GUARDIAN_VIEWPORT_WIDTH).toBe(1440);
    expect(config.GUARDIAN_VIEWPORT_HEIGHT).toBe(900);
    expect(config.GUARDIAN_DEMO_PACING).toBe(false);
    expect(config.GUARDIAN_RECORD_VIDEO).toBe(false);
    expect(config.GUARDIAN_RECORD_TRACE).toBe(false);
    expect(config.GUARDIAN_REPORT_EMBED_SCREENSHOTS).toBe(true);
    expect(config.OPENAI_MODEL).toBe('gpt-5.6-terra');
    expect(config.OPENAI_MAX_OUTPUT_TOKENS).toBe(800);
    expect(config.MAX_MODEL_CALLS_PER_AUDIT).toBe(3);
    expect(config.MAX_CONCURRENT_AUDITS).toBe(1);
    expect(config.SCREENSHOT_MAX_WIDTH).toBe(1280);
    expect(config.SCREENSHOT_JPEG_QUALITY).toBe(75);
    expect(config.BROWSER_VIEWPORT_WIDTH).toBe(1440);
    expect(config.BROWSER_VIEWPORT_HEIGHT).toBe(900);
    expect(config.BROWSER_SLOW_MO_MS).toBe(250);
    expect(config.CONSENT_DISCOVERY_MAX_MS).toBe(10_000);
    expect(config.CONSENT_DISCOVERY_POLL_MS).toBe(250);
  });
  it('requires region and model only for Bedrock', () => {
    expect(() => loadConfig({ GUARDIAN_PROVIDER: 'bedrock' })).toThrow(ConfigurationError);
    expect(
      loadConfig({
        GUARDIAN_PROVIDER: 'bedrock',
        AWS_REGION: 'us-east-1',
        BEDROCK_MODEL_ID: 'model',
      }).BEDROCK_MODEL_ID,
    ).toBe('model');
  });
  it('ignores blank configuration belonging to unselected providers', () => {
    const config = loadConfig({
      MODEL_PROVIDER: 'mock',
      AWS_REGION: '',
      BEDROCK_MODEL_ID: '',
      OPENAI_API_KEY: '',
      OPENAI_MODEL: '',
    });
    expect(config.MODEL_PROVIDER).toBe('mock');
    expect(config.AWS_REGION).toBeUndefined();
    expect(config.BEDROCK_MODEL_ID).toBeUndefined();
    expect(config.OPENAI_API_KEY).toBeUndefined();
    expect(config.OPENAI_MODEL).toBe('gpt-5.6-terra');
  });
  it('still rejects blank configuration required by the selected provider', () => {
    expect(() =>
      loadConfig({
        MODEL_PROVIDER: 'bedrock',
        AWS_REGION: ' ',
        BEDROCK_MODEL_ID: '',
      }),
    ).toThrow(/AWS_REGION|BEDROCK_MODEL_ID/);
    expect(() => loadConfig({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: ' ' })).toThrow(
      /OPENAI_API_KEY/,
    );
  });
  it('requires an API key only when OpenAI is selected', () => {
    expect(() => loadConfig({ MODEL_PROVIDER: 'openai' })).toThrow(ConfigurationError);
    expect(loadConfig({ MODEL_PROVIDER: 'openai', OPENAI_API_KEY: 'test-key' }).OPENAI_MODEL).toBe(
      'gpt-5.6-terra',
    );
    expect(loadConfig({ MODEL_PROVIDER: 'mock' }).OPENAI_API_KEY).toBeUndefined();
  });

  it('prefers MODEL_PROVIDER while retaining the legacy alias', () => {
    expect(loadConfig({ GUARDIAN_PROVIDER: 'mock' }).MODEL_PROVIDER).toBe('mock');
    expect(
      loadConfig({
        MODEL_PROVIDER: 'openai',
        GUARDIAN_PROVIDER: 'mock',
        OPENAI_API_KEY: 'test-key',
      }).GUARDIAN_PROVIDER,
    ).toBe('openai');
  });
});
