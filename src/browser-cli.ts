import { ConfigurationError, loadConfig } from './config/env.js';
import { InteractiveBrowserSession } from './browser/interactive-browser.js';
import { createProvider } from './providers/provider-factory.js';

async function main(): Promise<void> {
  let browser: InteractiveBrowserSession | undefined;
  try {
    const config = loadConfig(process.env);
    const provider = createProvider(config);
    browser = new InteractiveBrowserSession(config, provider);
    const stop = () => void browser?.shutdown();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    await browser.start();
    await browser.waitUntilClosed();
  } catch (error) {
    process.exitCode = error instanceof ConfigurationError ? 3 : 1;
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  } finally {
    await browser?.shutdown();
    await browser?.finish();
  }
}

void main();
