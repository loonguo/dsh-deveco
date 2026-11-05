import assert from 'node:assert/strict';
import http from 'node:http';

import { createControlHandler } from '../src/control.js';
import { createRuntime } from '../src/runtime.js';

/** A session whose working directory is this plugin repository, not a project. */
const runtime = createRuntime(
  { devecoPath: 'D:\\Software\\DevEco Studio' },
  { resolveSessionDirectory: () => 'D:\\DeepSeekHarness\\dsh-deveco' },
);
const handler = createControlHandler(runtime);
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const get = () =>
  new Promise((resolve, reject) => {
    http
      .get({ host: '127.0.0.1', port, path: '/dsh-deveco/state?sessionId=session-test' }, (response) => {
        let body = '';
        response.on('data', (chunk) => (body += chunk));
        response.on('end', () => resolve(JSON.parse(body)));
      })
      .on('error', reject);
  });

const post = (payload) =>
  new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: '/dsh-deveco/control', method: 'POST', headers: { 'content-type': 'application/json' } }, (response) => {
      let body = '';
      response.on('data', (chunk) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(payload));
  });

const initial = await get();
assert.equal(initial.ok, true);
assert.ok(initial.state.project, 'a non-project session still resolves a project for the toolbar');
assert.ok(initial.state.project.name.length > 0);
assert.ok(initial.state.device, 'the attached emulator is reported');

const built = await post({ action: 'build', sessionId: 'session-test' });
assert.equal(built.status, 200, `toolbar build must not fail: ${JSON.stringify(built.body)}`);
assert.equal(built.body.ok, true);
assert.ok(built.body.state.lastBuild, 'the build result reaches the toolbar state');
assert.equal(built.body.state.project.name, initial.state.project.name);

const unknown = await post({ action: 'nope', sessionId: 'session-test' });
assert.equal(unknown.status, 400);

// The Run button installs and launches the resolved project on the emulator.
const ran = await post({ action: 'run', sessionId: 'session-test' });
assert.equal(ran.status, 200, `toolbar run must not fail: ${JSON.stringify(ran.body)}`);
assert.equal(ran.body.ok, true);
assert.equal(ran.body.state.running, true);
assert.ok(Number.isInteger(ran.body.state.pid));

server.close();
runtime.dispose();
console.log(JSON.stringify({ project: initial.state.project, build: built.body.state.lastBuild, runPid: ran.body.state.pid }, null, 2));
console.log('toolbar: ok');
