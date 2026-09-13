import { GuardianLoop } from '../src/agent/agent-loop.js';
import { loadConfig } from '../src/config/env.js';
import { createProvider } from '../src/providers/provider-factory.js';

const urlIndex = process.argv.indexOf('--url');
const url = urlIndex >= 0 ? process.argv[urlIndex + 1] : undefined;
if (!url) throw new Error('Usage: npm run bedrock:smoke -- --url https://example.com');
const config = loadConfig({
  ...process.env,
  MODEL_PROVIDER: 'bedrock',
  GUARDIAN_MODE: 'guardian',
});
const report = await new GuardianLoop(config, createProvider(config)).run(url);
console.log(JSON.stringify(report, null, 2));
