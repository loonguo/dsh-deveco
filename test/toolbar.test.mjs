import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

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

// A workspace with several projects offers a dropdown and honors a selection.
const multiDir = path.join(process.cwd(), '.test-workspace');
rmSync(multiDir, { recursive: true, force: true });
for (const [name, bundle] of [['Alpha', 'com.test.alpha'], ['Beta', 'com.test.beta']]) {
  const appScope = path.join(multiDir, name, 'AppScope');
  mkdirSync(appScope, { recursive: true });
  writeFileSync(path.join(appScope, 'app.json5'), JSON.stringify({ app: { bundleName: bundle, versionCode: 1000000, versionName: '1.0.0' } }, null, 2));
}
const multiRuntime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => multiDir },
);
const multiServer = await createToolbarServer(multiRuntime, { port: 0 });
const multi = await get(multiServer, '/state?sessionId=session-multi');
assert.equal(multi.status, 200);
assert.equal(multi.body.state.projects.length, 2, 'both workspace projects are listed');
assert.ok(multi.body.state.project, 'a workspace project is selected by default');
const alpha = multi.body.state.projects.find((entry) => entry.name === 'Alpha');
assert.ok(alpha, 'Alpha is listed');
const selected = await post(multiServer, { action: 'select', project: alpha.dir, sessionId: 'session-multi' });
assert.equal(selected.status, 200, `select must succeed: ${JSON.stringify(selected.body)}`);
assert.equal(selected.body.state.project.name, 'Alpha', 'the dropdown selection becomes the active project');
const rejected = await post(multiServer, { action: 'select', project: path.join(multiDir, 'Missing'), sessionId: 'session-multi' });
assert.equal(rejected.status, 400, 'a directory outside the workspace is refused');

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
assert.ok(container.body.state.projects.length >= 1, 'the workspace lists its projects');
assert.equal(container.body.state.project.dir, container.body.state.projects[0].dir, 'the default is the first (most recent) listed project');

await emptyServer.close();
await containerServer.close();
await multiServer.close();
rmSync(multiDir, { recursive: true, force: true });
projectRuntime.dispose();
emptyRuntime.dispose();
containerRuntime.dispose();
multiRuntime.dispose();
console.log(
  JSON.stringify(
    {
      port: initial.body.state.port,
      project: initial.body.state.project,
      build: built.body.state.lastBuild,
      runPid: ran.body.state.pid,
      nonProjectState: empty.body.state.project,
      containerProject: container.body.state.project,
      multiProjects: multi.body.state.projects.map((entry) => entry.name),
      selectedProject: selected.body.state.project.name,
    },
    null,
    2,
  ),
);
console.log('toolbar: ok');
