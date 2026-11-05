/**
 * The toolbar's own loopback HTTP carrier.
 *
 * The DSH page is loaded over `file://` in the desktop application, where a
 * relative `fetch('/dsh-deveco/state')` never reaches a plugin route — only the
 * Electron IPC bridge answers, with 404. The panel therefore talks to this small
 * server instead: one listener on 127.0.0.1, a stable port range the client
 * probes, and CORS limited to the origins a local page can have.
 *
 * Security posture: loopback clients only, GET for state and POST for actions,
 * JSON bodies capped at 64 KiB, no file system or shell surface beyond the
 * runtime methods the tools already expose.
 *
 * @module @local/dsh-deveco/server
 */

import http from 'node:http';

const DEFAULT_PORT = 5731;
const PORT_ATTEMPTS = 10;
const MAX_BODY = 64 * 1024;
const ACTIONS = new Set(['build', 'run', 'stop', 'open']);

/** Only loopback peers may drive the toolbar. */
function isLoopbackPeer(address) {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1' || (typeof address === 'string' && address.startsWith('127.'));
}

function corsHeaders(request) {
  const origin = request.headers.origin;
  return {
    'access-control-allow-origin': typeof origin === 'string' && origin !== '' ? origin : '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type',
    'access-control-max-age': '600',
    ...(request.headers['access-control-request-private-network'] === 'true' ? { 'access-control-allow-private-network': 'true' } : {}),
    vary: 'Origin',
    'cache-control': 'no-store',
  };
}

function sendJson(response, status, payload, headers) {
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('request body is too large'));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    request.on('error', reject);
  });
}

/** Build one server instance plus the handler bound to it. */
function makeServer(runtime, host) {
  /** @type {import('node:http').Server | undefined} */
  let server;
  const handler = async (request, response) => {
    const headers = corsHeaders(request);
    if (request.method === 'OPTIONS') {
      response.writeHead(204, headers);
      response.end();
      return;
    }
    if (!isLoopbackPeer(request.socket.remoteAddress ?? '')) {
      sendJson(response, 403, { ok: false, error: 'the DevEco toolbar only accepts loopback clients' }, headers);
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', `http://${host}`);
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid request URL' }, headers);
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/ping') {
        sendJson(response, 200, { ok: true, app: 'dsh-deveco', port: server?.address()?.port ?? null }, headers);
        return;
      }
      if (request.method === 'GET' && url.pathname === '/state') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const state = await runtime.toolbarState(sessionId);
        sendJson(response, 200, { ...state, sessionId: sessionId ?? null }, headers);
        return;
      }
      if (request.method === 'POST' && url.pathname === '/control') {
        const body = await readBody(request);
        const action = typeof body.action === 'string' ? body.action : '';
        if (!ACTIONS.has(action)) {
          sendJson(response, 400, { ok: false, error: `unknown action "${action}"` }, headers);
          return;
        }
        const control = {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          projectDir: typeof body.project === 'string' ? body.project : undefined,
        };
        if (action === 'run') control.build = false;
        await runtime.perform(action, control);
        const state = await runtime.toolbarState(control.sessionId);
        sendJson(response, 200, state, headers);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'use GET /state or POST /control' }, headers);
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) }, headers);
    }
  };
  server = http.createServer(handler);
  return server;
}

/**
 * Start the toolbar server, walking the port range until one binds.
 * @param {any} runtime
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<{ port: number, host: string, origin: string, close: () => Promise<void> }>}
 */
export async function createToolbarServer(runtime, options = {}) {
  const host = options.host ?? '127.0.0.1';
  const startPort = Number(options.port ?? DEFAULT_PORT);
  let lastError = null;
  for (let attempt = 0; attempt < PORT_ATTEMPTS; attempt += 1) {
    const port = startPort + attempt;
    const server = makeServer(runtime, host);
    try {
      await new Promise((resolve, reject) => {
        const onError = (error) => {
          server.off('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.off('error', onError);
          resolve(undefined);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
      const actual = server.address()?.port ?? port;
      if (runtime !== null && typeof runtime === 'object') runtime.toolbarPort = actual;
      return {
        port: actual,
        host,
        origin: `http://${host}:${actual}`,
        close: () =>
          new Promise((resolve) => {
            try {
              server.closeAllConnections?.();
            } catch {
              /* already closing */
            }
            server.close(() => resolve(undefined));
          }),
      };
    } catch (error) {
      lastError = error;
      server.close();
      if (error?.code !== 'EADDRINUSE') break;
    }
  }
  throw new Error(`cannot start the DevEco toolbar server on ${host}:${startPort}-${startPort + PORT_ATTEMPTS - 1}: ${lastError?.message ?? 'unknown error'}`);
}
