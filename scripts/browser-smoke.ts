import { mkdir, mkdtemp, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { InteractiveBrowserSession } from '../src/browser/interactive-browser.js';
import { loadConfig } from '../src/config/env.js';
import { createFixtureServer } from '../src/fixtures/server.js';
import { MockProvider } from '../src/providers/mock-provider.js';

await mkdir(path.resolve('.dpg'), { recursive: true });
const profileDirectory = await mkdtemp(path.resolve('.dpg', 'browser-smoke-profile-'));
const { server, url } = await createFixtureServer();
const config = loadConfig({
  MODEL_PROVIDER: 'mock',
  GUARDIAN_ARTIFACT_DIR: 'artifacts',
  BROWSER_SLOW_MO_MS: '0',
});
const browser = new InteractiveBrowserSession(config, new MockProvider(), {
  profileDirectory,
  headlessOverride: process.env.DPG_SMOKE_HEADLESS === 'true',
  navigationDebounceMs: 50,
  stabilizationMs: 50,
});

try {
  await browser.start();
  const first = browser.pages()[0];
  if (!first) throw new Error('Persistent browser did not create an initial tab');
  await first.goto(`${url}/visible-reject`, { waitUntil: 'domcontentloaded' });
  await browser.waitForIdle();
  const second = await browser.openTab(`${url}/preselected-toggles`);
  await browser.waitForIdle();
  await first.goto(`${url}/nested-settings`, { waitUntil: 'domcontentloaded' });
  await browser.waitForIdle();
  await second.close();
  await first.close();
  await browser.shutdown();
} finally {
  await browser.shutdown();
  await browser.finish();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const artifactRoot = path.resolve(config.GUARDIAN_ARTIFACT_DIR);
const entries = await import('node:fs/promises').then(({ readdir }) =>
  readdir(artifactRoot, { withFileTypes: true }),
);
const latest = entries
  .filter((entry) => entry.isDirectory() && entry.name.startsWith('browser-session-'))
  .map((entry) => entry.name)
  .sort()
  .at(-1);
if (!latest) throw new Error('Browser smoke test did not produce a session directory');
const sessionDirectory = path.join(artifactRoot, latest);
const manifest = JSON.parse(
  await readFile(path.join(sessionDirectory, 'browser-session.json'), 'utf8'),
) as {
  endedAt?: string;
  tabs: Array<{ tabId: string; videoPath?: string; auditRunIds: string[] }>;
};
if (!manifest.endedAt || manifest.tabs.length !== 2)
  throw new Error('Browser session manifest was not finalized with two tabs');
if (
  (manifest.tabs[0]?.auditRunIds.length ?? 0) < 2 ||
  (manifest.tabs[1]?.auditRunIds.length ?? 0) < 1
)
  throw new Error('Expected two first-tab audits and one second-tab audit');
for (const tab of manifest.tabs) {
  if (!tab.videoPath || (await stat(path.join(sessionDirectory, tab.videoPath))).size === 0)
    throw new Error(`Recording was not finalized for ${tab.tabId}`);
}
const html = await readFile(path.join(sessionDirectory, 'report.html'), 'utf8');
for (const tab of manifest.tabs) {
  for (const auditRunId of tab.auditRunIds)
    if (!html.includes(auditRunId)) throw new Error(`Report omitted ${auditRunId}`);
  if (!html.includes(tab.videoPath!)) throw new Error(`Report omitted ${tab.tabId} recording`);
}
console.log(
  JSON.stringify(
    {
      sessionDirectory,
      tabs: manifest.tabs.map(({ tabId, auditRunIds, videoPath }) => ({
        tabId,
        auditRunIds,
        videoPath,
      })),
    },
    null,
    2,
  ),
);
