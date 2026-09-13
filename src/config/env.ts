import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const providerSchema = z.enum(['mock', 'bedrock', 'openai']);
const blankToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;
const optionalNonEmptyString = z.preprocess(blankToUndefined, z.string().trim().min(1).optional());
const booleanString = (fallback: 'true' | 'false' = 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((value) => value === 'true');
const delay = z.coerce.number().int().min(0).max(60_000);

const rawEnvSchema = z.object({
  MODEL_PROVIDER: z.preprocess(blankToUndefined, providerSchema.optional()),
  // Backwards-compatible alias. MODEL_PROVIDER wins when both are present.
  GUARDIAN_PROVIDER: z.preprocess(blankToUndefined, providerSchema.optional()),
  GUARDIAN_MODE: z.enum(['inspector', 'guardian']).default('inspector'),
  GUARDIAN_MAX_STEPS: z.coerce.number().int().min(1).max(30).default(8),
  GUARDIAN_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.75),
  GUARDIAN_ARTIFACT_DIR: z.string().min(1).default('artifacts'),
  GUARDIAN_DISPLAY_PROFILE: z.enum(['laptop', 'recording', 'custom']).default('laptop'),
  GUARDIAN_VIEWPORT_WIDTH: z.coerce.number().int().min(640).max(3840).default(1440),
  GUARDIAN_VIEWPORT_HEIGHT: z.coerce.number().int().min(480).max(2160).default(900),
  GUARDIAN_DEMO_PACING: booleanString(),
  GUARDIAN_SLOW_MO_MS: delay.default(0),
  GUARDIAN_STEP_DELAY_MS: delay.default(0),
  GUARDIAN_HIGHLIGHT_DELAY_MS: delay.default(0),
  GUARDIAN_FINAL_HOLD_MS: delay.default(0),
  GUARDIAN_RECORD_VIDEO: booleanString(),
  GUARDIAN_RECORD_TRACE: booleanString(),
  GUARDIAN_REPORT_EMBED_SCREENSHOTS: booleanString('true'),
  GUARDIAN_ALLOW_MOCK_FALLBACK: booleanString(),
  AWS_REGION: optionalNonEmptyString,
  BEDROCK_MODEL_ID: optionalNonEmptyString,
  OPENAI_API_KEY: optionalNonEmptyString,
  OPENAI_MODEL: z.preprocess(blankToUndefined, z.string().trim().min(1).default('gpt-5.6-terra')),
  OPENAI_MAX_OUTPUT_TOKENS: z.coerce.number().int().min(1).max(128_000).default(800),
  MAX_MODEL_CALLS_PER_AUDIT: z.coerce.number().int().min(1).max(30).default(3),
  MAX_CONCURRENT_AUDITS: z.coerce.number().int().min(1).max(16).default(1),
  SCREENSHOT_MAX_WIDTH: z.coerce.number().int().min(320).max(3840).default(1280),
  SCREENSHOT_JPEG_QUALITY: z.coerce.number().int().min(1).max(100).default(75),
  REMOTE_ANALYSIS_ALLOWED_HOSTS: z.string().default(''),
  BROWSER_VIEWPORT_WIDTH: z.coerce.number().int().min(640).max(3840).default(1440),
  BROWSER_VIEWPORT_HEIGHT: z.coerce.number().int().min(480).max(2160).default(900),
  BROWSER_SLOW_MO_MS: delay.default(250),
  CONSENT_DISCOVERY_MAX_MS: z.coerce.number().int().min(0).max(10_000).default(10_000),
  CONSENT_DISCOVERY_POLL_MS: z.coerce.number().int().min(25).max(1_000).default(250),
});

export const envSchema = rawEnvSchema
  .superRefine((env, context) => {
    const provider = env.MODEL_PROVIDER ?? env.GUARDIAN_PROVIDER ?? 'mock';
    if (provider === 'bedrock') {
      if (!env.AWS_REGION)
        context.addIssue({ code: 'custom', path: ['AWS_REGION'], message: 'required for bedrock' });
      if (!env.BEDROCK_MODEL_ID)
        context.addIssue({
          code: 'custom',
          path: ['BEDROCK_MODEL_ID'],
          message: 'required for bedrock',
        });
    }
    if (provider === 'openai' && !env.OPENAI_API_KEY)
      context.addIssue({
        code: 'custom',
        path: ['OPENAI_API_KEY'],
        message: 'required when MODEL_PROVIDER=openai',
      });
  })
  .transform((env) => {
    const provider = env.MODEL_PROVIDER ?? env.GUARDIAN_PROVIDER ?? 'mock';
    return { ...env, MODEL_PROVIDER: provider, GUARDIAN_PROVIDER: provider };
  });

export type GuardianConfig = z.infer<typeof envSchema>;

export class ConfigurationError extends Error {
  override readonly name = 'ConfigurationError';
}

export function loadConfig(values: NodeJS.ProcessEnv = process.env): GuardianConfig {
  const result = envSchema.safeParse(values);
  if (!result.success)
    throw new ConfigurationError(`Invalid configuration: ${z.prettifyError(result.error)}`);
  return result.data;
}
