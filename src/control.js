/**
 * The toolbar's two loopback routes:
 *   GET  /dsh-deveco/state?sessionId=…  -> { ok, state }
 *   POST /dsh-deveco/control {action}   -> { ok, state } | { ok:false, error }
 *
 * Both go through the same runtime the tools use, so a button press and a model
 * tool call cannot disagree about what is running.
 *
 * @module @local/dsh-deveco/control
 */

/** Read a bounded JSON request body. */
function readJsonBody(request, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

/** Refuse cross-origin requests (the page is served from the same host). */
function sameOriginRequest(request) {
  const origin = request.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    return new URL(origin).host === request.headers.host;
  } catch {
    return false;
  }
}

function sendJson(response, statusCode, payload) {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.setHeader('cache-control', 'no-store');
  response.end(JSON.stringify(payload));
}

/**
 * @param {any} runtime
 * @returns {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse) => Promise<void>}
 */
export function createControlHandler(runtime) {
  return async function handle(request, response) {
    if (!sameOriginRequest(request)) {
      sendJson(response, 403, { ok: false, error: 'cross-origin requests are refused' });
      return;
    }
    let url;
    try {
      url = new URL(request.url ?? '/', 'http://127.0.0.1');
    } catch {
      sendJson(response, 400, { ok: false, error: 'invalid request URL' });
      return;
    }
    try {
      if (request.method === 'GET' && url.pathname === '/dsh-deveco/state') {
        const sessionId = url.searchParams.get('sessionId') ?? undefined;
        const state = await runtime.toolbarState(sessionId);
        sendJson(response, 200, { ...state, sessionId: sessionId ?? null });
        return;
      }
      if (request.method === 'POST' && url.pathname === '/dsh-deveco/control') {
        const body = await readJsonBody(request);
        const action = typeof body.action === 'string' ? body.action : '';
        if (!['build', 'run', 'stop', 'open', 'select'].includes(action)) {
          sendJson(response, 400, { ok: false, error: `unknown action "${action}"` });
          return;
        }
        const options = {
          sessionId: typeof body.sessionId === 'string' ? body.sessionId : undefined,
          projectDir: typeof body.project === 'string' ? body.project : undefined,
        };
        if (action === 'select') {
          runtime.selectToolbarProject(options.sessionId, options.projectDir ?? '');
          const state = await runtime.toolbarState(options.sessionId);
          sendJson(response, 200, state);
          return;
        }
        if (action === 'run') options.build = false;
        await runtime.perform(action, options);
        const state = await runtime.toolbarState(options.sessionId);
        sendJson(response, 200, state);
        return;
      }
      sendJson(response, 404, { ok: false, error: 'unknown dsh-deveco route; use GET /dsh-deveco/state or POST /dsh-deveco/control' });
    } catch (error) {
      sendJson(response, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  };
}
