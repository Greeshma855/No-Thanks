import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { BRAND } from '../config/brand.js';

const root = path.resolve(process.cwd(), 'fixtures/cookie-pages');
const allowed = new Set([
  'visible-reject',
  'nested-settings',
  'preselected-toggles',
  'ambiguous-banner',
  'delayed-banner',
  'iframe-host',
  'iframe-consent',
  'no-banner',
  'iframe-consent-sibling',
  'sticky-action-bar',
  'scrolling-preferences',
  'custom-toggle-proxies',
  'dynamic-ad-reject',
  'stale-consent-target',
]);

export async function createFixtureServer(port = 0): Promise<{ server: Server; url: string }> {
  const server = createServer(async (request, response) => {
    const name =
      new URL(request.url ?? '/', 'http://localhost').pathname.split('/').filter(Boolean)[0] ??
      'visible-reject';
    if (!allowed.has(name)) {
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    try {
      const html = await readFile(path.join(root, name, 'index.html'));
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(html);
    } catch {
      response.writeHead(500);
      response.end('Fixture unavailable');
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Fixture server did not bind to TCP');
  return { server, url: `http://127.0.0.1:${address.port}` };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const portArg = process.argv.indexOf('--port');
  const port = Number(portArg >= 0 ? process.argv[portArg + 1] : (process.env.PORT ?? 4173));
  void createFixtureServer(port).then(({ url }) =>
    console.log(`${BRAND.productName} fixtures: ${url}`),
  );
}
