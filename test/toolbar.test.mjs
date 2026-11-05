import assert from 'node:assert/strict';

import { createRuntime } from '../src/runtime.js';
import { createToolbarServer } from '../src/server.js';

/** A session whose working directory is this plugin repository, not a project. */
const runtime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => 'D:\\DeepSeekHarness\\dsh-deveco' },
);
const server = await createToolbarServer(runtime, { port: 0 });
assert.equal(server.host, '127.0.0.1');
assert.ok(server.port > 0);

const get = async (path) => {
  const response = await fetch(`${server.origin}${path}`);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const post = async (payload) => {
  const response = await fetch(`${server.origin}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const ping = await get('/ping');
assert.equal(ping.status, 200);
assert.equal(ping.body.app, 'dsh-deveco');

const initial = await get('/state?sessionId=session-test');
assert.equal(initial.status, 200);
assert.equal(initial.body.ok, true);
assert.ok(initial.body.state.project, 'a non-project session still resolves a project for the toolbar');
assert.ok(initial.body.state.project.name.length > 0);
assert.equal(typeof initial.body.state.ideRunning, 'boolean');
assert.equal(initial.body.state.port, server.port);

const built = await post({ action: 'build', sessionId: 'session-test' });
assert.equal(built.status, 200, `toolbar build must not fail: ${JSON.stringify(built.body)}`);
assert.equal(built.body.ok, true);
assert.ok(built.body.state.lastBuild, 'the build result reaches the toolbar state');
assert.equal(built.body.state.project.name, initial.body.state.project.name);

const unknown = await post({ action: 'nope', sessionId: 'session-test' });
assert.equal(unknown.status, 400);

const missing = await get('/nope');
assert.equal(missing.status, 404);

await server.close();
runtime.dispose();
console.log(JSON.stringify({ port: initial.body.state.port, project: initial.body.state.project, build: built.body.state.lastBuild }, null, 2));
console.log('toolbar: ok');
