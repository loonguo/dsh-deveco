import assert from 'node:assert/strict';

import { createRuntime } from '../src/runtime.js';

/**
 * Cold-start check for the toolbar's Run button: no device attached, so the
 * runtime must start the stopped emulator itself, wait for hdc, then install
 * and launch the project.
 */
const runtime = createRuntime({ devecoPath: 'D:\\Software\\DevEco Studio' });
const projectDir = process.argv[2] ?? 'D:\\DeepSeekHarness\\projects\\HelloWorld';

const started = Date.now();
const result = await runtime.run({ projectDir, install: true });
const seconds = Math.round((Date.now() - started) / 1000);

assert.equal(result.ok, true, `run should succeed: ${JSON.stringify(result.steps)} ${result.output ?? ''}`);
assert.ok(Number.isInteger(result.pid) && result.pid > 0, 'a pid is reported');
assert.ok(
  result.steps.some((step) => step.step === 'emulator' && step.ok === true),
  `the emulator should have been started by the run: ${JSON.stringify(result.steps)}`,
);
assert.equal(result.project.bundleName, 'com.example.helloworld');

console.log(JSON.stringify({ pid: result.pid, seconds, device: result.device.key, steps: result.steps }, null, 2));
console.log('run: ok');
runtime.dispose();
