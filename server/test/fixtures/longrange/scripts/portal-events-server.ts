/**
 * Long-range T7 harness: a real HTTP server hosting the Portal's public
 * learning-event Route Handler (`POST /api/learning/events`) against the real
 * PostgreSQL e2e database.
 *
 * This file is a test fixture only. It is NOT production code and is not
 * imported by the application. The Admin e2e spec spawns it with the Portal's
 * own toolchain (`node --import tsx --require scripts/register-tsconfig-paths.cjs`)
 * so the real `@/` module aliases and the real `pg` store are exercised.
 *
 * Two arrangement steps happen before the server starts:
 *   1. the Portal schema bootstrap runs (`ensureSchema`), which creates
 *      `learning_events` and `learning_plan_entries` (migration 029);
 *   2. a frozen-plan projection is seeded for `cv-longrange-A` / `cv-longrange-B`
 *      (unless `--no-projection`), so the spec can observe both the strict
 *      stage-validation path and the v1 "no projection -> stageValidated=false"
 *      path from design §16 (edge ②).
 *
 * Two product users and their sessions are created through the Portal's public
 * store API (local file storage; only the event ledger uses PostgreSQL), then
 * the handler treats every request exactly as production does: cookie session
 * -> userId, server clock -> receivedAt, append-only ledger.
 *
 * Output contract (stdout, one line): `LONGRANGE_EVENTS_READY {json}` with
 * `{ port, aliceToken, bobToken, aliceUserId, bobUserId, projection }`.
 */
import http from 'node:http';
import { mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const portalRoot = process.env.LG_PORTAL_ROOT;
if (!portalRoot) throw new Error('LG_PORTAL_ROOT is required');
const dataDir = process.env.LONGRANGE_DATA_DIR;
if (!dataDir) throw new Error('LONGRANGE_DATA_DIR is required');
const projection = !process.argv.includes('--no-projection');

const moduleUrl = (relative: string) =>
  pathToFileURL(`${portalRoot}/${relative}`).href;

interface DbModule {
  ensureSchema: () => Promise<void>;
  query: (sql: string, params: unknown[]) => Promise<unknown>;
  closePool: () => Promise<void>;
}

interface ProductStoreModule {
  registerUser: (input: {
    email: string;
    password: string;
    locale: string;
  }) => Promise<{ id: string }>;
  verifyEmailToken: (token: string) => Promise<void>;
  issueEmailVerificationToken: (userId: string) => Promise<string>;
  createSession: (userId: string) => Promise<{ token: string }>;
}

interface EventsHttpModule {
  createLearningEventsPostHandler: () => (
    request: Request,
  ) => Promise<Response>;
}

async function main() {
  mkdirSync(dataDir as string, { recursive: true });
  process.chdir(dataDir as string);

  const db = (await import(
    moduleUrl('services/persistence/db.ts')
  )) as unknown as DbModule;
  const productStore = (await import(
    moduleUrl('services/productStore.ts')
  )) as unknown as ProductStoreModule;
  const eventsHttp = (await import(
    moduleUrl('services/learningEventsHttp.ts')
  )) as unknown as EventsHttpModule;

  await db.ensureSchema();

  const planRows: Array<[string, string, string, string]> = [
    ['cv-longrange-A', 'entry-A1', 'step-A1', '001'],
    ['cv-longrange-A', 'entry-A2', 'step-A2', '002'],
    ['cv-longrange-B', 'entry-B1', 'step-B1', '001'],
  ];

  if (projection) {
    for (const [contentVersionId, entryId, stageKey, orderKey] of planRows) {
      await db.query(
        `INSERT INTO learning_plan_entries (content_version_id, entry_id, stage_key, order_key)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (content_version_id, entry_id) DO NOTHING`,
        [contentVersionId, entryId, stageKey, orderKey],
      );
    }
  }

  async function signedInUser(email: string) {
    const user = await productStore.registerUser({
      email,
      password: 'password1',
      locale: 'en-GB',
    });
    await productStore.verifyEmailToken(
      await productStore.issueEmailVerificationToken(user.id),
    );
    const { token } = await productStore.createSession(user.id);
    return { id: user.id, token };
  }

  const stamp = `${process.pid}-${Date.now()}`;
  const alice = await signedInUser(
    `longrange-session-alice-${stamp}@example.test`,
  );
  const bob = await signedInUser(`longrange-session-bob-${stamp}@example.test`);

  const handler = eventsHttp.createLearningEventsPostHandler();

  function toWebRequest(
    req: http.IncomingMessage,
    origin: string,
    body?: Buffer,
  ): Request {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (value === undefined) continue;
      if (Array.isArray(value))
        for (const item of value) headers.append(name, item);
      else headers.set(name, value);
    }
    const method = req.method || 'GET';
    return new Request(`${origin}${req.url || '/'}`, {
      method,
      headers,
      ...(method === 'GET' || method === 'HEAD'
        ? {}
        : { body: body ?? Buffer.alloc(0) }),
    });
  }

  async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  const server = http.createServer((req, res) => {
    void handleRequest(req, res);
  });

  async function handleRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    try {
      if (
        req.method === 'GET' &&
        (req.url === '/__health' || req.url === '/health')
      ) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, projection }));
        return;
      }
      const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
      const body = await readBody(req);
      const response =
        req.method === 'POST' && req.url === '/api/learning/events'
          ? await handler(toWebRequest(req, origin, body))
          : new Response(JSON.stringify({ ok: false, error: 'not found' }), {
              status: 404,
            });
      const buffer = Buffer.from(await response.arrayBuffer());
      const headers: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        headers[name] = value;
      });
      res.writeHead(response.status, headers);
      res.end(buffer);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  }

  server.listen(0, '127.0.0.1', () => {
    const address = server.address() as { port: number };
    process.stdout.write(
      `LONGRANGE_EVENTS_READY ${JSON.stringify({
        port: address.port,
        aliceToken: alice.token,
        bobToken: bob.token,
        aliceUserId: alice.id,
        bobUserId: bob.id,
        projection,
      })}\n`,
    );
  });

  async function shutdown() {
    server.close();
    await db.closePool().catch(() => undefined);
    process.exit(0);
  }
  process.on('SIGTERM', () => {
    void shutdown();
  });
  process.on('SIGINT', () => {
    void shutdown();
  });
}

void main().catch((error) => {
  const stack = (error as Error | undefined)?.stack;
  process.stderr.write(`LONGRANGE_EVENTS_FAILED ${String(stack ?? error)}\n`);
  process.exit(1);
});
