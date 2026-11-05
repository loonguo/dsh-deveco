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
  const agents = get('agents');
  const workingDirectory = get('workingDirectory');
  const webServer = get('webServer');

  /** Map a Session id from the page to the directory that session works in. */
  const resolveSessionDirectory = (sessionId) => {
    try {
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

  const runtime = createRuntime(config ?? {}, { resolveSessionDirectory });

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
  // operations stay available there under their original paths.
  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    const handler = createControlHandler(runtime);
    for (const path of ['/dsh-deveco/state', '/dsh-deveco/control']) {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `dsh-deveco: route ${path}`);
    }
  }
}
