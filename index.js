/**
 * @local/dsh-deveco — DevEco Studio tools for DeepSeek Harness.
 *
 * Host-only ESM bundle plugin: no dependencies, no harness imports. Registers the
 * ten `deveco_*` model-facing tools, the floating toolbar's two loopback HTTP
 * routes, and stops every child process (builds, hilog captures, IDE launches)
 * when the plugin unloads.
 *
 * Config keys are documented in cordis.patch.yml; every path is optional because
 * discovery covers the standard DevEco Studio and command-line-tools layouts.
 */

import { createControlHandler } from './src/control.js';
import { disposeAll } from './src/exec.js';
import { createRuntime } from './src/runtime.js';
import { createToolDefinitions } from './src/tools.js';

export const inject = ['tools'];

/**
 * Register tools, toolbar routes and teardown.
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

  if (webServer !== undefined && webServer !== null && typeof webServer.register === 'function') {
    const handler = createControlHandler(runtime);
    for (const path of ['/dsh-deveco/state', '/dsh-deveco/control']) {
      ctx.effect(() => webServer.register({ kind: 'exact', path, handler }), `dsh-deveco: route ${path}`);
    }
  }
}
