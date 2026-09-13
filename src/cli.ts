import { GuardianLoop } from './agent/agent-loop.js';
import { BRAND } from './config/brand.js';
import { ConfigurationError, loadConfig } from './config/env.js';
import { createProvider } from './providers/provider-factory.js';
import { ProviderError } from './providers/reasoning-provider.js';

interface CliArgs {
  url: string;
  mode?: 'inspector' | 'guardian';
  provider?: 'mock' | 'bedrock' | 'openai';
  displayProfile?: 'laptop' | 'recording' | 'custom';
}

const help = `${BRAND.wordmark}

${BRAND.tagline}

Usage:
  npm run no-thanks -- --url <http-or-https-url> [--mode inspector|guardian] [--provider mock|bedrock|openai]
                     [--display-profile laptop|recording|custom]
  npm run guardian -- --url <http-or-https-url> [--mode inspector|guardian] [--provider mock|bedrock|openai]
                     [--display-profile laptop|recording|custom]

Modes:
  inspector  Headed Chromium with a floating visual overlay; optional demo pacing via environment variables.
  guardian   Headless Chromium by default with no artificial delays; inspect it afterward with artifacts, video, or trace.

"Hidden rejection" describes a cookie-banner dark pattern and is unrelated to Playwright headless mode.`;
function parseArgs(args: string[]): CliArgs {
  const read = (flag: string) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const url = read('--url') ?? args.find((arg) => /^https?:\/\//i.test(arg));
  if (!url) throw new ConfigurationError('Missing --url <http-or-https-url>');
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol))
    throw new ConfigurationError('URL must use http or https');
  const mode = read('--mode');
  const provider = read('--provider');
  const displayProfile = read('--display-profile');
  if (mode && !['inspector', 'guardian'].includes(mode))
    throw new ConfigurationError('--mode must be inspector or guardian');
  if (provider && !['mock', 'bedrock', 'openai'].includes(provider))
    throw new ConfigurationError('--provider must be mock, bedrock, or openai');
  if (displayProfile && !['laptop', 'recording', 'custom'].includes(displayProfile))
    throw new ConfigurationError('--display-profile must be laptop, recording, or custom');
  return {
    url: parsed.href,
    ...(mode ? { mode: mode as 'inspector' | 'guardian' } : {}),
    ...(provider ? { provider: provider as 'mock' | 'bedrock' | 'openai' } : {}),
    ...(displayProfile
      ? { displayProfile: displayProfile as 'laptop' | 'recording' | 'custom' }
      : {}),
  };
}
async function main(): Promise<void> {
  try {
    if (process.argv.includes('--help') || process.argv.includes('-h')) {
      console.log(help);
      return;
    }
    const args = parseArgs(process.argv.slice(2));
    const config = loadConfig({
      ...process.env,
      ...(args.mode ? { GUARDIAN_MODE: args.mode } : {}),
      ...(args.provider ? { MODEL_PROVIDER: args.provider } : {}),
      ...(args.displayProfile ? { GUARDIAN_DISPLAY_PROFILE: args.displayProfile } : {}),
    });
    const report = await new GuardianLoop(config, createProvider(config)).run(args.url);
    console.log(
      JSON.stringify(
        {
          bannerDetected: report.bannerDetected,
          darkPatterns: report.darkPatterns,
          actionsPerformed: report.actions.length,
          safetyStops: report.safetyStops,
          verification: report.verification.level,
          artifactDirectory: report.artifactDirectory,
        },
        null,
        2,
      ),
    );
    if (report.safetyStops.length || ['FAILED', 'UNVERIFIED'].includes(report.verification.level))
      process.exitCode = 2;
  } catch (error) {
    process.exitCode =
      error instanceof ConfigurationError ||
      (error instanceof ProviderError && error.code === 'CONFIGURATION')
        ? 3
        : 1;
    let message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    if (process.env.OPENAI_API_KEY)
      message = message.replaceAll(process.env.OPENAI_API_KEY, '[REDACTED]');
    console.error(message.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[REDACTED]'));
  }
}
void main();
