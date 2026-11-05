/**
 * Debug-session lifecycle for a HarmonyOS app.
 *
 * What the framework exposes over hdc is the *debug-wait* protocol: the app can
 * be started paused (`aa start -D`), toggled into wait mode (`aa appdebug`),
 * attached and detached (`aa attach`/`aa detach`), and its debug transport can
 * be forwarded (`hdc fport tcp:<port> ark:<pid>@<tid>@Debugger`). Breakpoints and
 * stepping themselves live inside DevEco Studio's JDI/CDP debugger, which owns
 * a private handshake; this module prepares the exact state DevEco attaches to,
 * reports transport diagnostics, and hands the project to the IDE.
 *
 * @module @local/dsh-deveco/debug
 */

import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';

/** Whether a `wc`-style websocket handshake was accepted at `port`. */
function probeWebSocket(port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const key = randomBytes(16).toString('base64');
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write(
        `GET / HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    });
    let data = '';
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on('data', (chunk) => {
      data += chunk.toString('latin1');
      if (data.includes('\r\n\r\n')) {
        const expected = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        finish({
          status: data.startsWith('HTTP/1.1 101') ? 101 : Number((data.match(/^HTTP\/1\.1 (\d+)/) ?? [])[1] ?? 0),
          accepted: data.includes(expected),
          response: data.slice(0, 200),
        });
      }
    });
    socket.on('error', (error) => finish({ status: 0, accepted: false, response: `error: ${error.message}` }));
    socket.on('close', () => finish({ status: 0, accepted: false, response: data.slice(0, 200) || 'closed without a response' }));
    setTimeout(() => finish({ status: 0, accepted: false, response: data.slice(0, 200) || 'no response' }), timeoutMs);
  });
}

/** Milliseconds helper. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build the debug facade.
 * @param {{ device: any, paths: () => any, config: Record<string, any> }} runtime
 */
export function createDebugService(runtime) {
  const pollPid = async (device, bundleName, attempts = 15) => {
    for (let index = 0; index < attempts; index += 1) {
      const pid = await runtime.device.pidOf(device, bundleName).catch(() => null);
      if (pid !== null) return pid;
      await sleep(800);
    }
    return null;
  };

  /**
   * Start the app in debug-wait mode.
   * @param {any} device
   * @param {{ bundleName: string, ability: string, moduleName?: string, persist?: boolean }} options
   */
  const start = async (device, options) => {
    await runtime.device.forceStop(device, options.bundleName).catch(() => ({ ok: false }));
    const waitMode = await runtime.device.appDebug(device, options.bundleName, options.persist === true ? 'persist' : 'set');
    const launched = await runtime.device.startAbility(device, {
      bundleName: options.bundleName,
      ability: options.ability,
      moduleName: options.moduleName,
      debug: true,
    });
    if (!launched.ok) {
      return { ok: false, stage: 'launch', output: `${waitMode.output}\n${launched.output}`.trim() };
    }
    const pid = await pollPid(device, options.bundleName);
    if (pid === null) {
      return { ok: false, stage: 'pid', output: launched.output, note: 'the ability started but no process appeared; check hilog for a crash.' };
    }
    return {
      ok: true,
      pid,
      waiting: true,
      device: device.key,
      bundleName: options.bundleName,
      ability: options.ability,
      appDebug: waitMode.output,
      output: launched.output,
      next: [
        'The app is paused waiting for a debugger.',
        'Attach DevEco Studio\'s debugger to this bundle, or call deveco_debug action "attach" to mark it attached.',
        'Use deveco_log or deveco_debug action "status" to follow the process, and action "cancel" to leave debug mode.',
      ],
    };
  };

  /** Attach/detach the debug marker. */
  const attach = async (device, bundleName, attachIt) => {
    const result = await runtime.device.debugAttach(device, bundleName, attachIt);
    return { ok: result.ok, output: result.output, action: attachIt ? 'attach' : 'detach' };
  };

  /** Report the current debug state of one bundle. */
  const status = async (device, bundleName) => {
    const [pid, appDebug, jpids] = await Promise.all([
      runtime.device.pidOf(device, bundleName).catch(() => null),
      runtime.device.appDebug(device, bundleName, 'get').catch(() => ({ output: '' })),
      runtime.device.jpid(device).catch(() => []),
    ]);
    return {
      device: device.key,
      bundleName,
      pid,
      running: pid !== null,
      inDebugTransport: pid !== null && jpids.includes(pid),
      appDebug: appDebug.output,
    };
  };

  /** Leave debug mode: cancel wait, detach, force-stop. */
  const cancel = async (device, bundleName) => {
    const detached = await runtime.device.debugAttach(device, bundleName, false).catch(() => ({ ok: false, output: '' }));
    const cancelled = await runtime.device.appDebug(device, bundleName, 'cancel').catch(() => ({ ok: false, output: '' }));
    const stopped = await runtime.device.forceStop(device, bundleName).catch(() => ({ ok: false, output: '' }));
    return { ok: true, detached: detached.output, cancelled: cancelled.output, stopped: stopped.output };
  };

  /**
   * Forward the ArkTS debug transport and report what the endpoint answers.
   * This is diagnostic: it proves whether a plain CDP/WebSocket client can talk
   * to the runtime on this ROM, which decides if in-DSH stepping is possible.
   */
  const probe = async (device, bundleName, startPort = 9330) => {
    const pid = await runtime.device.pidOf(device, bundleName);
    if (pid === null) throw new Error(`"${bundleName}" is not running; start it with deveco_debug action "start" first.`);
    const attempts = [];
    let port = startPort;
    for (const service of ['Debugger', 'PandaDebugger']) {
      const task = `ark:${pid}@${pid}@${service}`;
      const forwarded = await runtime.device.fport(device, port, task);
      const socket = forwarded.ok ? await probeWebSocket(port) : { status: 0, accepted: false, response: forwarded.output };
      attempts.push({ task, port, forwarded: forwarded.ok, ...socket });
      if (forwarded.ok) await runtime.device.fportRemove(device, `tcp:${port}`).catch(() => ({ ok: false }));
      port += 1;
    }
    return {
      pid,
      attempts,
      compatible: attempts.some((attempt) => attempt.accepted === true),
      hint: attempts.some((attempt) => attempt.accepted === true)
        ? 'A CDP endpoint accepted the WebSocket handshake.'
        : 'The ROM endpoint did not accept a plain CDP WebSocket handshake; DevEco Studio owns the private debugger handshake on this build. Use deveco_open to continue interactive stepping in the IDE.',
    };
  };

  return { start, attach, status, cancel, probe, pollPid };
}
