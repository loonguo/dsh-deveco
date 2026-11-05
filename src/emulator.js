/**
 * HarmonyOS emulator control through DevEco Studio's Emulator.exe.
 *
 * The emulator CLI reports instances as JSON (`-list -details`), starts and
 * stops them by name, and can capture a screenshot without an hdc round-trip.
 * Starting is asynchronous: the process stays alive with its window, so it is
 * spawned detached and the caller polls for `isRunning`.
 *
 * @module @local/dsh-deveco/emulator
 */

import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';

import { run } from './exec.js';

/** Parse the JSON instance list printed by `Emulator.exe -list -details`. */
export function parseInstanceList(stdout) {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  try {
    const list = JSON.parse(stdout.slice(start, end + 1));
    if (!Array.isArray(list)) return [];
    return list.map((entry) => ({
      name: String(entry?.name ?? ''),
      deviceType: String(entry?.deviceType ?? ''),
      api: String(entry?.['os.apiVersion'] ?? ''),
      running: String(entry?.isRunning ?? '').toLowerCase() === 'true',
      hdcPort: String(entry?.['hw.hdc.port'] ?? ''),
      instancePath: String(entry?.instancePath ?? ''),
      imageRoot: String(entry?.imageRoot ?? ''),
      imageSubPath: String(entry?.imageSubPath ?? ''),
    }));
  } catch {
    return [];
  }
}

/**
 * Build the emulator facade.
 * @param {{ paths: () => any, config: Record<string, any> }} runtime
 */
export function createEmulatorService(runtime) {
  const exe = () => {
    const found = runtime.paths().tools.emulator;
    if (!found) throw new Error('Emulator.exe was not found; it ships inside DevEco Studio at tools/emulator.');
    return found;
  };

  const timeout = () => Math.max(30000, Number(runtime.config.defaultTimeoutMs ?? 60000));

  /** List instances, newest state fetched each call. */
  const list = async () => {
    const result = await run(exe(), ['-list', '-details'], { timeoutMs: timeout(), maxBytes: 1024 * 1024 });
    const output = result.stdout.trim();
    const instances = parseInstanceList(output);
    if (instances.length === 0 && result.code !== 0) {
      throw new Error(`the emulator did not return an instance list: ${(result.output || result.stderr).trim().slice(0, 600)}`);
    }
    return { instances, output };
  };

  /** Start one instance and wait until it reports running. */
  const start = async (name, options = {}) => {
    const args = ['-start', name];
    if (options.noWindow === true) args.push('-noWindow');
    const child = spawn(exe(), args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    const deadline = Date.now() + (options.timeoutMs ?? 240000);
    let lastState = null;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      try {
        const { instances } = await list();
        const instance = instances.find((entry) => entry.name === name) ?? null;
        if (instance && instance.running) return { running: true, instance, pid: child.pid ?? null };
        lastState = instance;
      } catch {
        /* the emulator is still initialising its CLI state */
      }
    }
    return {
      running: false,
      instance: lastState,
      pid: child.pid ?? null,
      hint: 'The instance did not report running in time. Check the emulator window for an agreement or license prompt, then retry.',
    };
  };

  /** Stop one instance. */
  const stop = async (name) => {
    const result = await run(exe(), ['-stop', name], { timeoutMs: 60000 });
    return { ok: /success|stop/i.test(result.output) && result.code === 0, output: result.output.trim() };
  };

  /** Capture the emulator window/screen straight from the emulator CLI. */
  const screenshot = async (name, file) => {
    const result = await run(exe(), ['-instance', name, '-screenshot', '-screenshotPath', file], { timeoutMs: 60000 });
    const ok = existsSync(file) && statSync(file).size > 0;
    return { ok, output: result.output.trim(), file };
  };

  return { path: exe, list, start, stop, screenshot };
}
