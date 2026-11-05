import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import path from 'node:path';

import { createRuntime } from '../src/runtime.js';
import { createToolDefinitions } from '../src/tools.js';

const root = 'D:\\DeepSeekHarness\\dsh-deveco\\.e2e';
const projectDir = path.join(root, 'DemoApp');
if (existsSync(projectDir)) rmSync(projectDir, { recursive: true, force: true });

const runtime = createRuntime({ devecoPath: 'D:\\Software\\DevEco Studio' });
const ctx = { get: () => undefined };
const tools = new Map(createToolDefinitions({ runtime, ctx }).map((tool) => [tool.name, tool]));
const call = async (name, args) => {
  const tool = tools.get(name);
  assert.ok(tool, `tool ${name} exists`);
  const value = await tool.execute(args, {});
  const blocks = tool.output.render(args, value);
  return { value, blocks };
};

const summary = {};

// 1. scaffold
const init = await call('deveco_project_init', { directory: projectDir, name: 'DemoApp', bundleName: 'com.example.demoapp' });
summary.project_init = { directory: init.value.directory, files: init.value.files, bundle: init.value.bundleName };
assert.ok(existsSync(path.join(projectDir, 'entry', 'src', 'main', 'module.json5')));

// 2. build
const build = await call('deveco_build', { project: projectDir, timeoutMs: 900000 });
summary.build = { ok: build.value.ok, errors: build.value.errors, warnings: build.value.warnings, artifacts: build.value.artifacts.map((artifact) => artifact.path), diagnostics: build.value.diagnostics.slice(0, 5) };
assert.equal(build.value.ok, true, `build failed: ${build.blocks[0].text.slice(-3000)}`);
assert.ok(build.value.artifacts.length > 0);

// 3. run (install + launch)
const run = await call('deveco_run', { project: projectDir, install: true });
summary.run = { ok: run.value.ok, stage: run.value.stage, pid: run.value.pid, steps: run.value.steps };
assert.equal(run.value.ok, true, `run failed: ${run.blocks[0].text.slice(-3000)}`);
assert.ok(Number.isInteger(run.value.pid));

// 4. screenshot
const shot = await call('deveco_ui', { action: 'screenshot' });
summary.screenshot = { file: shot.value.file, width: shot.value.width, height: shot.value.height, hasImage: Boolean(shot.value.image) };
assert.ok(existsSync(shot.value.file));

// 5. layout
const layout = await call('deveco_ui', { action: 'layout' });
const button = layout.value.nodes.find((node) => node.text === 'Tap me');
summary.layout = { nodes: layout.value.count, tapButton: button ? button.center : null };
assert.ok(button, 'the template page exposes a "Tap me" button');

// 6. tap and confirm the counter changes
await call('deveco_ui', { action: 'tap', x: button.center.x, y: button.center.y });
await new Promise((resolve) => setTimeout(resolve, 800));
const afterTap = await call('deveco_ui', { action: 'layout' });
summary.afterTap = afterTap.value.nodes.filter((node) => String(node.text).startsWith('Tapped')).map((node) => node.text);

// 7. debug lifecycle
const debugStart = await call('deveco_debug', { action: 'start', project: projectDir });
summary.debugStart = { ok: debugStart.value.ok, pid: debugStart.value.pid };
const debugStatus = await call('deveco_debug', { action: 'status', project: projectDir });
summary.debugStatus = debugStatus.value.status;
const debugCancel = await call('deveco_debug', { action: 'cancel', project: projectDir });
summary.debugCancel = { stopped: debugCancel.value.stopped };
assert.equal(debugStart.value.ok, true, `debug start failed: ${debugStart.blocks[0].text}`);

// 8. crash log read (may be empty on an emulator)
const crash = await call('deveco_log', { action: 'crash' });
summary.crash = { files: crash.value.files?.length ?? 0, note: crash.value.note ?? '' };

console.log(JSON.stringify(summary, null, 2));
console.log('e2e: ok');
