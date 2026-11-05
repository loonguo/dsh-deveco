/**
 * DevEco Studio (IntelliJ platform) handoff: open a project, reveal a file at a
 * line, and report whether an IDE instance is already running.
 *
 * The IDE is a GUI process that must outlive the tool call, so it is spawned
 * detached and never awaited to completion. A second launch is forwarded to the
 * already running instance by the platform's own single-instance mechanism.
 *
 * @module @local/dsh-deveco/ide
 */

import { spawn } from 'node:child_process';

import { run } from './exec.js';

/**
 * Build the IDE facade.
 * @param {{ paths: () => any, config: Record<string, any> }} runtime
 */
export function createIdeService(runtime) {
  const exe = () => {
    const found = runtime.paths().deveco?.exe;
    if (!found) throw new Error('DevEco Studio was not found; set devecoPath in the dsh-deveco config.');
    return found;
  };

  /** Whether devecostudio64.exe is running. */
  const running = async () => {
    const result = await run('tasklist.exe', ['/FI', 'IMAGENAME eq devecostudio64.exe', '/NH'], { timeoutMs: 20000, maxBytes: 64 * 1024 });
    return /devecostudio64\.exe/i.test(result.output);
  };

  /**
   * Open a project, optionally revealing one file at a line.
   * @param {{ projectDir?: string, file?: string, line?: number }} options
   */
  const open = async (options) => {
    const args = [];
    if (options.projectDir) args.push(options.projectDir);
    if (options.file) {
      if (Number.isFinite(options.line)) args.push('--line', String(Math.max(1, Math.round(options.line))));
      args.push(options.file);
    }
    const child = spawn(exe(), args, { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    return {
      launched: true,
      pid: child.pid ?? null,
      alreadyRunning: await running(),
      executable: exe(),
      arguments: args,
    };
  };

  return { open, running, path: exe };
}
