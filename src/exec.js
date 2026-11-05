/**
 * Process execution for the DevEco toolchain.
 *
 * hvigor, hdc, the emulator and DevEco Studio itself are all ordinary local
 * programs, so this module owns one bounded runner: spawn with pipes, cap the
 * captured output, honour a timeout, and reap the whole process tree on
 * Windows (`taskkill /T`) so a timed-out build cannot leave a daemon behind.
 *
 * Nothing here imports the harness; the plugin stays a plain ESM package.
 *
 * @module @local/dsh-deveco/exec
 */

import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

/** Output kept per stream when a caller does not ask for a smaller cap. */
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** Children currently running, so plugin unload can terminate them. */
const active = new Set();

/** @param {string} file @param {string[]} args */
function quoteForCmd(file, args) {
  const quote = (value) => (/[\s"&|<>^]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  return [quote(file), ...args.map(quote)].join(' ');
}

/**
 * Whether a file is a Windows batch wrapper that must run through cmd.exe.
 * @param {string} file
 */
function isBatch(file) {
  return process.platform === 'win32' && /\.(bat|cmd)$/i.test(file);
}

/**
 * Run one program to completion.
 *
 * @param {string} file executable path
 * @param {string[]} [args]
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, timeoutMs?: number, signal?: AbortSignal, maxBytes?: number, stdin?: string, detached?: boolean }} [options]
 * @returns {Promise<{ code: number|null, signal: string|null, stdout: string, stderr: string, output: string, timedOut: boolean, spawnError: Error|null, durationMs: number, command: string }>}
 */
export function run(file, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 60000,
    signal,
    maxBytes = DEFAULT_MAX_BYTES,
    stdin,
    detached = false,
  } = options;
  const batch = isBatch(file);
  const command = batch ? `cmd.exe /d /s /c ${quoteForCmd(file, args)}` : [file, ...args].join(' ');
  const started = Date.now();

  return new Promise((resolve) => {
    let child;
    try {
      child =
        process.platform === 'win32' && batch
          ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoteForCmd(file, args)], {
              cwd,
              env,
              windowsHide: true,
              detached,
            })
          : spawn(file, args, { cwd, env, windowsHide: true, detached });
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        stdout: '',
        stderr: '',
        output: String(error?.message ?? error),
        timedOut: false,
        spawnError: error,
        durationMs: Date.now() - started,
        command,
      });
      return;
    }

    active.add(child);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let spawnError = null;
    let settled = false;

    const append = (current, chunk) => {
      if (current.length >= maxBytes) return current;
      const text = chunk.toString('utf8');
      return current.length + text.length > maxBytes ? current + text.slice(0, maxBytes - current.length) : current + text;
    };

    child.stdout?.on('data', (chunk) => {
      stdout = append(stdout, chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr = append(stderr, chunk);
    });

    if (stdin !== undefined) {
      try {
        child.stdin?.end(stdin);
      } catch {
        /* a program that closes stdin early is not an error */
      }
    }

    const finish = (code, signalName) => {
      if (settled) return;
      settled = true;
      active.delete(child);
      clearTimeout(timer);
      resolve({
        code,
        signal: signalName,
        stdout,
        stderr,
        output: stderr.length > 0 ? `${stdout}${stdout && !stdout.endsWith('\n') ? '\n' : ''}${stderr}` : stdout,
        timedOut,
        spawnError,
        durationMs: Date.now() - started,
        command,
      });
    };

    const killTree = () => {
      if (child.pid === undefined) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        });
      } else {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killTree();
      // A killed tree may not report exit on every platform; settle anyway.
      setTimeout(() => finish(null, 'SIGKILL'), 1500);
    }, Math.max(1000, timeoutMs));

    child.on('error', (error) => {
      spawnError = error;
    });
    child.on('close', (code, signalName) => {
      finish(code, signalName);
    });

    if (signal !== undefined) {
      const onAbort = () => {
        timedOut = false;
        killTree();
        setTimeout(() => finish(null, 'SIGKILL'), 1000);
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Start a long-lived program that streams lines to a callback. Used by hilog
 * capture and the emulator (which keeps its window process alive).
 *
 * @param {string} file
 * @param {string[]} args
 * @param {{ cwd?: string, env?: Record<string, string|undefined>, onLine?: (line: string, stream: 'stdout'|'stderr') => void, onExit?: (code: number|null) => void, maxLines?: number, buffer?: boolean }} [options]
 */
export function startStream(file, args, options = {}) {
  const { cwd, env, onLine, onExit, maxLines = 5000, buffer = true } = options;
  const batch = isBatch(file);
  const child =
    process.platform === 'win32' && batch
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', quoteForCmd(file, args)], { cwd, env, windowsHide: true })
      : spawn(file, args, { cwd, env, windowsHide: true });

  active.add(child);
  const lines = [];
  let partial = { stdout: '', stderr: '' };
  let closed = false;

  const accept = (stream, text) => {
    const combined = partial[stream] + text;
    const parts = combined.split(/\r?\n/);
    partial[stream] = parts.pop() ?? '';
    for (const line of parts) {
      if (buffer) {
        lines.push(line);
        if (lines.length > maxLines) lines.splice(0, lines.length - maxLines);
      }
      try {
        onLine?.(line, stream);
      } catch {
        /* a listener must not break the stream */
      }
    }
  };

  child.stdout?.on('data', (chunk) => accept('stdout', chunk.toString('utf8')));
  child.stderr?.on('data', (chunk) => accept('stderr', chunk.toString('utf8')));
  child.on('error', () => {});
  child.on('close', (code) => {
    closed = true;
    active.delete(child);
    for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
      if (partial[stream].length > 0) {
        const line = partial[stream];
        partial[stream] = '';
        if (buffer) lines.push(line);
        try {
          onLine?.(line, stream);
        } catch {
          /* ignore */
        }
      }
    }
    try {
      onExit?.(code);
    } catch {
      /* ignore */
    }
  });

  return {
    get pid() {
      return child.pid ?? null;
    },
    get closed() {
      return closed;
    },
    /** Lines captured so far (copy). */
    read() {
      return [...lines];
    },
    /** Remove the first n buffered lines and return them. */
    take(count) {
      return lines.splice(0, Math.max(0, count));
    },
    stop() {
      if (closed) return;
      if (process.platform === 'win32' && child.pid !== undefined) {
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        });
      } else {
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }
    },
  };
}

/** Whether a path exists (files only). @param {string} file */
export async function isFile(file) {
  try {
    await access(file, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Join and normalise, keeping a Windows drive prefix intact. @param {...string} parts */
export function joinPath(...parts) {
  return path.normalize(path.join(...parts));
}

/** Terminate every child this module started (plugin unload / HMR). */
export function disposeAll() {
  for (const child of active) {
    try {
      if (process.platform === 'win32' && child.pid !== undefined) {
        spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill();
      }
    } catch {
      /* best effort during teardown */
    }
  }
  active.clear();
}
