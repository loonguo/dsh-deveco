import assert from 'node:assert/strict';

import { createRuntime } from '../src/runtime.js';
import { createToolbarServer } from '../src/server.js';

const PROJECT_DIR = 'D:\\DeepSeekHarness\\projects\\HelloWorld';
const NON_PROJECT_DIR = 'D:\\DeepSeekHarness\\dsh-deveco';

/** A session whose workspace is the HarmonyOS project. */
const projectRuntime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => PROJECT_DIR },
);
const projectServer = await createToolbarServer(projectRuntime, { port: 0 });
assert.equal(projectServer.host, '127.0.0.1');
assert.ok(projectServer.port > 0);

const get = async (server, path) => {
  const response = await fetch(`${server.origin}${path}`);
  return { status: response.status, body: await response.json().catch(() => ({})) };
};
const post = async (server, payload) => {
  const response = await fetch(`${server.origin}/control`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json().catch(() => ({})) };
};

const ping = await get(projectServer, '/ping');
assert.equal(ping.status, 200);
assert.equal(ping.body.app, 'dsh-deveco');

const initial = await get(projectServer, '/state?sessionId=session-project');
assert.equal(initial.status, 200);
assert.equal(initial.body.ok, true);
assert.ok(initial.body.state.project, 'a project workspace resolves its project');
assert.equal(initial.body.state.project.dir, PROJECT_DIR);
assert.equal(typeof initial.body.state.ideRunning, 'boolean');
assert.equal(initial.body.state.port, projectServer.port);

const built = await post(projectServer, { action: 'build', sessionId: 'session-project' });
assert.equal(built.status, 200, `toolbar build must not fail: ${JSON.stringify(built.body)}`);
assert.equal(built.body.ok, true);
assert.ok(built.body.state.lastBuild, 'the build result reaches the toolbar state');

const ran = await post(projectServer, { action: 'run', sessionId: 'session-project' });
assert.equal(ran.status, 200, `toolbar run must not fail: ${JSON.stringify(ran.body)}`);
assert.equal(ran.body.ok, true);
assert.ok(Number.isInteger(ran.body.state.pid) && ran.body.state.pid > 0);
assert.equal(ran.body.state.running, true);

const unknown = await post(projectServer, { action: 'nope', sessionId: 'session-project' });
assert.equal(unknown.status, 400);
const missing = await get(projectServer, '/nope');
assert.equal(missing.status, 404);

// A workspace without a HarmonyOS project reports no project, so the panel hides.
const emptyRuntime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => NON_PROJECT_DIR },
);
const emptyServer = await createToolbarServer(emptyRuntime, { port: 0 });
const empty = await get(emptyServer, '/state?sessionId=session-empty');
assert.equal(empty.status, 200);
assert.equal(empty.body.state.project, null, 'a non-project workspace must not borrow another project');

await projectServer.close();
// A workspace that is a folder of projects resolves the project inside it.
const containerRuntime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => 'D:\\DeepSeekHarness\\projects' },
);
const containerServer = await createToolbarServer(containerRuntime, { port: 0 });
const container = await get(containerServer, '/state?sessionId=session-container');
assert.equal(container.status, 200);
assert.ok(container.body.state.project, 'a workspace of projects resolves a project');
assert.equal(container.body.state.project.name, 'HelloWorld');

await projectServer.close();
await emptyServer.close();
await containerServer.close();
projectRuntime.dispose();
emptyRuntime.dispose();
containerRuntime.dispose();
console.log(
  JSON.stringify(
    {
      port: initial.body.state.port,
      project: initial.body.state.project,
      build: built.body.state.lastBuild,
      runPid: ran.body.state.pid,
      nonProjectState: empty.body.state.project,
      containerProject: container.body.state.project,
    },
    null,
    2,
  ),
);
console.log('toolbar: ok');
