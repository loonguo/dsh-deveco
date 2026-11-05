/**
 * @local/dsh-deveco — DevEco Studio tools for DeepSeek Harness.
 *
 * Host-only ESM bundle plugin: no dependencies, no harness imports. Registers the
 * ten `deveco_*` model-facing tools, starts the toolbar's own loopback HTTP
 * carrier (the desktop page is `file://`, so DSH plugin routes are unreachable
 * from it), keeps the DSH web-server routes for browser deployments, and stops
 * every child process when the plugin unloads.
 *
 * Config keys are documented in cordis.patch.yml; every path is optional because
 * discovery covers the standard DevEco Studio and command-line-tools layouts.
 */

import { createControlHandler } from './src/control.js';
import { disposeAll } from './src/exec.js';
import { createRuntime } from './src/runtime.js';
import { createToolbarServer } from './src/server.js';
import { createToolDefinitions } from './src/tools.js';

export const inject = ['tools'];

/**
 * Register tools, toolbar carriers and teardown.
 * @param {{ tools: { register(definition: object): () => void }, get?: (name: string) => unknown, effect(execute: () => (() => void) | void, label?: string): void }} ctx
 * @param {Record<string, unknown>} [config]
 */
export function apply(ctx, config) {
  const get = typeof ctx.get === 'function' ? (name) => ctx.get(name) : () => undefined;

  /**
   * Services are looked up on every call, never captured at apply time: plugin
   * rows activate before every dependency of a large profile is registered, so
   * an early `ctx.get('agents')` can legitimately be undefined and would then
   * pin the toolbar to "no session" for the whole process lifetime.
   */
  const resolveSessionDirectory = (sessionId) => {
    try {
      const agents = get('agents');
      const workingDirectory = get('workingDirectory');
      const agent = agents?.get?.(sessionId);
      const session = agent?.session;
      if (session !== undefined && session !== null && typeof workingDirectory?.get === 'function') {
        return workingDirectory.get(session);
      }
    } catch {
      /* a service shape change must not break the toolbar */
    }
    return undefined;
  };

  /** Map a tool call's agent to the directory its session works in. */
  const resolveAgentDirectory = (agent) => {
    try {
      const workingDirectory = get('workingDirectory');
      const session = agent?.session;
      if (session !== undefined && session !== null && typeof workingDirectory?.get === 'function') {
        return workingDirectory.get(session);
      }
    } catch {
      /* a service shape change must not break tool resolution */
    }
    return undefined;
  };

  const runtime = createRuntime(config ?? {}, { resolveSessionDirectory, resolveAgentDirectory });

  // The panel runs in the desktop page (file://), where a relative fetch never
  // reaches a DSH plugin route. A dedicated loopback listener makes the toolbar
  // independent of the host transport; failures are reported, never thrown.
  let fallbackError = '';
  const toolbar = createToolbarServer(runtime, { port: Number(config?.toolbarPort ?? 5731) })
    .then((server) => {
      runtime.toolbarPort = server.port;
      return server;
    })
    .catch((error) => {
      fallbackError = String(error instanceof Error ? error.message : error);
      runtime.toolbarPort = 0;
      return null;
    });
  runtime.toolbarStatus = async () => {
    const server = await toolbar;
    return { port: server?.port ?? 0, error: fallbackError };
  };

  ctx.effect(
    () => () => {
      toolbar.then((server) => server?.close()).catch(() => {});
    },
    'dsh-deveco: stop toolbar server',
  );

  ctx.effect(
    () => () => {
      try {
        runtime.dispose();
      } catch {
        /* best effort during teardown */
      }
      disposeAll();
    },
    'dsh-deveco: stop child processes',
  );

  for (const definition of createToolDefinitions({ runtime, ctx })) {
    ctx.effect(() => ctx.tools.register(definition), `dsh-deveco: tool ${definition.name}`);
  }

  // Browser deployments serve the page from the DSH web server; the same two
  // operations stay available there under their original paths. Registering
  // through `ctx.inject` keeps them working even when the web server activates
  // after this row.
  const registerRoutes = (webServer) => {
    if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return;
    const handler = createControlHandler(runtime);
    for (const path of ['/dsh-deveco/state', '/dsh-deveco/control']) {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `dsh-deveco: route ${path}`);
    }
  };
  const webServerNow = get('webServer');
  if (webServerNow !== undefined && webServerNow !== null) {
    registerRoutes(webServerNow);
  } else if (typeof ctx.inject === 'function') {
    ctx.inject(['webServer'], (scope) => registerRoutes(scope?.webServer ?? get('webServer')));
  }
}
