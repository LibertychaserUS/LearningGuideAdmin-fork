import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  BUILD_META_NAME,
  isStaticAssetPath,
  readBuildVersion,
  registerMissingAssetRoute,
  registerVersionRoute,
  setNoStore,
  withBuildMeta,
} from './build-version';

function fakeRes() {
  const headers: Record<string, string> = {};
  let body = '';
  return {
    headers,
    get body() {
      return body;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
    },
    end(value: string) {
      body = value;
    },
  };
}

describe('build identity', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'lg-build-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('changes with the entry document and is stable otherwise', () => {
    writeFileSync(join(dir, 'index.html'), '<html><script src="/assets/index-AAA.js"></script></html>');
    const first = readBuildVersion(dir);
    expect(first).toMatch(/^[a-f0-9]{16}$/);
    expect(readBuildVersion(dir)).toBe(first);

    // A new build rewrites the hashed asset name, so the identity must move.
    writeFileSync(join(dir, 'index.html'), '<html><script src="/assets/index-BBB.js"></script></html>');
    expect(readBuildVersion(dir)).not.toBe(first);
  });

  it('reports no identity instead of throwing when there is no front-end build', () => {
    expect(readBuildVersion(dir)).toBeNull();
  });
});

describe('GET /version.json', () => {
  it('is no-store and carries the identity', () => {
    let handler: ((req: unknown, res: ReturnType<typeof fakeRes>) => void) | undefined;
    const express = {
      get(path: string, fn: typeof handler) {
        expect(path).toBe('/version.json');
        handler = fn;
      },
    };
    registerVersionRoute(express, 'abcdef1234567890');
    const res = fakeRes();
    handler!(null, res);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
    expect(res.headers.pragma).toBe('no-cache');
    expect(res.headers.expires).toBe('0');
    expect(JSON.parse(res.body)).toEqual({ version: 'abcdef1234567890' });
  });

  it('still answers when the service has no front-end build', () => {
    let handler: ((req: unknown, res: ReturnType<typeof fakeRes>) => void) | undefined;
    registerVersionRoute({ get: (_p, fn) => void (handler = fn) }, null);
    const res = fakeRes();
    handler!(null, res);
    expect(JSON.parse(res.body)).toEqual({ version: null });
  });
});

describe('entry document build meta', () => {
  const html = '<!doctype html><html><head><title>x</title></head><body></body></html>';

  it('names the build the client is actually running', () => {
    const withMeta = withBuildMeta(html, 'abc123');
    expect(withMeta).toContain(`<meta name="${BUILD_META_NAME}" content="abc123"`);
    // Injected before </head> so it is parsed before the module script runs.
    expect(withMeta.indexOf(BUILD_META_NAME)).toBeLessThan(withMeta.indexOf('</head>'));
  });

  it('is idempotent and leaves a build-less document untouched', () => {
    const withMeta = withBuildMeta(html, 'abc123');
    expect(withBuildMeta(withMeta, 'abc123')).toBe(withMeta);
    expect(withBuildMeta(html, null)).toBe(html);
  });
});

describe('setNoStore', () => {
  it('applies the same headers every caller relies on', () => {
    const res = fakeRes();
    setNoStore(res);
    expect(res.headers['cache-control']).toBe('no-store, no-cache, must-revalidate, proxy-revalidate');
  });
});

/**
 * The SPA fallback is a catch-all regex, so route ordering is the real hazard:
 * if /version.json were registered after it, the client would receive index.html
 * and the watcher would silently read no version at all.
 */
describe('route ordering against the SPA fallback', () => {
  let dir: string;
  let server: import('node:http').Server;
  let base: string;

  beforeAll(async () => {
    // CommonJS require keeps this spec runnable under jest's default vm without
    // --experimental-vm-modules (dynamic import() is unavailable there).
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const express = require('express');
    dir = mkdtempSync(join(tmpdir(), 'lg-route-'));
    writeFileSync(join(dir, 'index.html'), '<html><head></head><body><div id="root"></div></body></html>');
    mkdirSync(join(dir, 'assets'));
    writeFileSync(join(dir, 'assets', 'index-NEW.js'), 'console.log(1)');
    const version = readBuildVersion(dir);

    const app = express();
    app.use(express.static(dir, { index: false }));
    registerVersionRoute(app as never, version);
    registerMissingAssetRoute(app as never);
    app.get(/^\/(?!api(?:\/|$)|health$).*/, (_req, res: never) => {
      const out = res as unknown as { setHeader: (n: string, v: string) => void; sendFile: (p: string) => void };
      setNoStore(out as never);
      out.sendFile(join(dir, 'index.html'));
    });

    server = app.listen(0);
    await new Promise(resolve => server.once('listening', resolve));
    const address = server.address() as import('node:net').AddressInfo;
    base = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  });

  it('answers /version.json as JSON rather than with the SPA document', async () => {
    const response = await fetch(`${base}/version.json`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = (await response.json()) as { version: string };
    expect(body.version).toBe(readBuildVersion(dir));
  });

  it('still serves the SPA document for app routes', async () => {
    const response = await fetch(`${base}/en-GB/backoffice/sign-in`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('id="root"');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });

  it('still serves an asset that exists', async () => {
    const response = await fetch(`${base}/assets/index-NEW.js`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('console.log(1)');
  });

  // 发布时新旧实例并存：取不到的哈希脚本若回成 index.html，浏览器会因 MIME 不对拒绝执行，整页白屏。
  it.each([
    '/assets/index-GONE.js',
    '/assets/index-GONE.css',
    '/assets/x/y.woff2',
    '/sw.js',
    '/main.mjs',
    '/app.js.map',
  ])(
    'answers a missing asset %s with a non-cacheable 404, never the SPA document',
    async (path) => {
      const response = await fetch(`${base}${path}`);
      expect(response.status).toBe(404);
      expect(response.headers.get('content-type')).not.toContain('text/html');
      expect(response.headers.get('cache-control')).toContain('no-store');
      expect(await response.text()).not.toContain('id="root"');
    },
  );
});

describe('isStaticAssetPath', () => {
  it.each([
    '/assets/index-abc.js',
    '/assets/a.css',
    '/assets/font.woff2',
    '/x.mjs',
    '/x.js.map',
  ])('treats %s as an asset', (path) => {
    expect(isStaticAssetPath(path)).toBe(true);
  });
  it.each([
    '/',
    '/zh-CN/help-desk',
    '/zh-CN/help-desk/0b5c3f8e-1d2a-4c6b-9e7f-123456789abc',
    '/en-GB/course/editor',
    '/version.json',
    '/api/files/notes.css',
    '/api/assets/x.js',
  ])('leaves app route %s to the SPA', (path) => {
    expect(isStaticAssetPath(path)).toBe(false);
  });
});
