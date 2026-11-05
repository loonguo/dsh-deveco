import assert from 'node:assert/strict';

import { apply } from '../index.js';
import { createRuntime } from '../src/runtime.js';
import { createToolDefinitions } from '../src/tools.js';

/** Minimal Cordis-like context: effect ownership plus tool/route registries. */
function fakeContext() {
  const tools = new Map();
  const routes = new Map();
  const effects = [];
  const ctx = {
    tools: {
      register(definition) {
        tools.set(definition.name, definition);
        return () => tools.delete(definition.name);
      },
    },
    get(name) {
      if (name === 'webServer') return { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path); } };
      return undefined;
    },
    effect(execute) {
      const dispose = execute();
      effects.push(dispose);
      return dispose;
    },
  };
  return { ctx, tools, routes, effects };
}

const { ctx, tools, routes, effects } = fakeContext();
apply(ctx, { devecoPath: 'D:\\Software\\DevEco Studio' });
assert.equal(tools.size, 10, 'ten tools are registered on apply');
assert.ok(routes.has('/dsh-deveco/state'));
assert.ok(routes.has('/dsh-deveco/control'));
assert.equal(effects.length, 13, 'ten tools + two routes + one teardown effect');
for (const dispose of effects) dispose();
assert.equal(tools.size, 0, 'disposing the plugin unregisters every tool');

const runtime = createRuntime({ devecoPath: 'D:\\Software\\DevEco Studio' });
const definitions = createToolDefinitions({ runtime, ctx });
const build = definitions.find((tool) => tool.name === 'deveco_build');
await assert.rejects(() => build.execute({}, {}), /no HarmonyOS project was found/);
const ui = definitions.find((tool) => tool.name === 'deveco_ui');
await assert.rejects(() => ui.execute({ action: 'nope' }, {}), /must be one of/);
await assert.rejects(() => ui.execute({ action: 'tap' }, {}), /requires x and y/);
const device = definitions.find((tool) => tool.name === 'deveco_device');
await assert.rejects(() => device.execute({ action: 'emulator_start' }, {}), /requires the emulator instance name/);

console.log('plugin: ok');

/* The Host renders tool output through the enforced JSON-Schema subset; a
 * keyword outside it (or an array `type`) makes registration throw, which
 * unmounts the whole plugin row. Guard the subset here. */
const ALLOWED = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'oneOf']);
function assertSubset(node, path) {
  if (node === null || typeof node !== 'object') throw new Error(`${path}: schema node must be an object`);
  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED.has(key)) throw new Error(`${path}: unsupported schema keyword "${key}"`);
    if (key === 'type' && typeof value !== 'string') throw new Error(`${path}: "type" must be a single string`);
    if (key === 'properties') for (const [name, child] of Object.entries(value)) assertSubset(child, `${path}.${name}`);
    if (key === 'items') assertSubset(value, `${path}[]`);
    if (key === 'oneOf') value.forEach((child, index) => assertSubset(child, `${path}|${index}`));
    if (key === 'additionalProperties' && typeof value !== 'boolean' && typeof value !== 'object') throw new Error(`${path}: additionalProperties must be boolean or a schema`);
  }
}
for (const tool of definitions) {
  assertSubset(tool.output.schema, `${tool.name}.output`);
}
console.log('schemas: ok');

