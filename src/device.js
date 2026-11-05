/**
 * Device access through hdc: target enumeration, app lifecycle, install,
 * port forwarding and file transfer.
 *
 * All commands target one device explicitly (`hdc -t <key>`), so a machine with
 * an emulator and a phone attached never mixes them up.
 *
 * @module @local/dsh-deveco/device
 */

import { run } from './exec.js';

/** States hdc reports for a usable target. */
const USABLE_STATES = new Set(['Connected', 'Ready']);

/** Parse `hdc list targets -v` output. */
export function parseTargets(text) {
  const targets = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || /^\[Empty\]/i.test(line)) continue;
    const columns = line.split(/\s+/);
    if (columns.length < 3) continue;
    const [key, type, state, ...rest] = columns;
    targets.push({
      key,
      type,
      state,
      name: rest.join(' '),
      // UART COM ports are always listed by hdc on Windows and never carry an
      // emulator or phone; they are reported but not selectable.
      usable: USABLE_STATES.has(state) && type !== 'UART',
    });
  }
  return targets;
}

/** Parse `hdc list targets -v` when hdc exits non-zero but still prints a list. */
export function parseAppDebug(text) {
  return /app debug successfully/i.test(text);
}

/**
 * Build the hdc facade bound to one runtime.
 * @param {{ config: Record<string, any>, paths: () => any }} runtime
 */
export function createDeviceService(runtime) {
  const hdcPath = () => {
    const found = runtime.paths().tools.hdc;
    if (!found) throw new Error('hdc was not found. Set sdkPath in the dsh-deveco config or install the HarmonyOS SDK.');
    return found;
  };

  const timeout = () => Number(runtime.config.defaultTimeoutMs ?? 60000);

  /** Run one hdc command. */
  const hdc = async (args, options = {}) => {
    const requested = options.device ?? runtime.config.device ?? '';
    const device = requested !== null && typeof requested === 'object' ? (requested.key ?? '') : String(requested ?? '');
    const full = device !== '' ? ['-t', device, ...args] : args;
    const result = await run(hdcPath(), full, {
      timeoutMs: options.timeoutMs ?? timeout(),
      signal: options.signal,
      maxBytes: options.maxBytes ?? 512 * 1024,
    });
    if (result.spawnError) throw new Error(`cannot start hdc: ${result.spawnError.message}`);
    return result;
  };

  /** List every target hdc knows about. */
  const list = async () => {
    const result = await hdc(['list', 'targets', '-v']);
    const targets = parseTargets(result.output);
    // hdc prints "[Empty]" and exits 0 when nothing is attached; an actual
    // failure is reported when nothing parsed and the exit code is non-zero.
    return { targets, output: result.output.trim(), code: result.code };
  };

  /**
   * Choose one usable target: an explicit key, the configured default, a
   * substring match, or the only attached device.
   */
  const select = async (requested) => {
    const { targets } = await list();
    const usable = targets.filter((target) => target.usable);
    if (usable.length === 0) {
      const detail = targets.length > 0 ? ` (seen but not usable: ${targets.map((target) => `${target.key} ${target.state}`).join(', ')})` : '';
      throw new Error(`no HarmonyOS device is connected${detail}. Start the emulator (deveco_device action "emulator_start") or enable USB debugging.`);
    }
    const wanted = typeof requested === 'string' && requested.length > 0 ? requested : String(runtime.config.device ?? '');
    if (wanted !== '') {
      const exact = usable.find((target) => target.key === wanted);
      if (exact) return exact;
      const partial = usable.find((target) => target.key.includes(wanted) || target.name.toLowerCase().includes(wanted.toLowerCase()));
      if (partial) return partial;
      throw new Error(`device "${wanted}" is not attached. Attached: ${usable.map((target) => target.key).join(', ')}.`);
    }
    if (usable.length > 1) {
      throw new Error(`several devices are attached (${usable.map((target) => target.key).join(', ')}); pass device explicitly.`);
    }
    return usable[0];
  };

  /** Read a single system parameter. */
  const param = async (name, device) => {
    const result = await hdc(['shell', 'param', 'get', name], { device, timeoutMs: 15000 });
    return result.output.trim();
  };

  /** Describe one device: model, software version, API level and UDID. */
  const info = async (device) => {
    const [model, version, api, udid] = await Promise.all([
      param('const.product.model', device.key).catch(() => ''),
      param('const.product.software.version', device.key).catch(() => ''),
      param('const.ohos.apiversion', device.key).catch(() => ''),
      hdc(['shell', 'bm', 'get', '-u'], { device: device.key, timeoutMs: 15000 })
        .then((result) => {
          const match = result.output.match(/udid of current device is\s*:\s*([0-9A-Fa-f]+)/i);
          return match ? match[1] : '';
        })
        .catch(() => ''),
    ]);
    return {
      key: device.key,
      type: device.type,
      name: device.name,
      model,
      version,
      api,
      udid,
      emulator: /emulator/i.test(model) || device.type === 'TCP',
    };
  };

  /** Install one HAP, replacing an existing installation. */
  const install = async (hapPath, device, options = {}) => {
    const args = ['install', ...(options.replace === false ? [] : ['-r']), hapPath];
    const result = await hdc(args, { device, timeoutMs: options.timeoutMs ?? 180000, maxBytes: 256 * 1024 });
    const ok = /install bundle successfully|success/i.test(result.output) && !/failed|error/i.test(result.output);
    return { ok, output: result.output.trim(), code: result.code, path: hapPath };
  };

  /** Uninstall one bundle. */
  const uninstall = async (bundleName, device) => {
    const result = await hdc(['uninstall', bundleName], { device, timeoutMs: 60000 });
    return { ok: /success/i.test(result.output), output: result.output.trim() };
  };

  /** Start an ability. Returns whether the framework accepted the request. */
  const startAbility = async (device, { bundleName, ability, moduleName, debug = false, params = [] }) => {
    const args = ['shell', 'aa', 'start', '-a', ability, '-b', bundleName];
    if (moduleName) args.push('-m', moduleName);
    if (debug) args.push('-D');
    for (const entry of params) args.push('--ps', entry.key, entry.value);
    const result = await hdc(args, { device, timeoutMs: 60000 });
    return { ok: /start ability successfully/i.test(result.output), output: result.output.trim() };
  };

  /** Force-stop the app process. */
  const forceStop = async (device, bundleName) => {
    const result = await hdc(['shell', 'aa', 'force-stop', bundleName], { device, timeoutMs: 30000 });
    return { ok: /success/i.test(result.output), output: result.output.trim() };
  };

  /** Read the app PID ('' when not running). */
  const pidOf = async (device, bundleName) => {
    const result = await hdc(['shell', 'pidof', bundleName], { device, timeoutMs: 15000 });
    const match = result.output.match(/\b(\d+)\b/);
    return match ? Number(match[1]) : null;
  };

  /** Debug-gerelateerde aa commands. */
  const appDebug = async (device, bundleName, action) => {
    if (action === 'get') {
      const result = await hdc(['shell', 'aa', 'appdebug', '-g'], { device, timeoutMs: 15000 });
      return { output: result.output.trim() };
    }
    const args = ['shell', 'aa', 'appdebug', '-b', bundleName];
    if (action === 'persist') args.push('-p');
    if (action === 'cancel') args.push('-c');
    const result = await hdc(args, { device, timeoutMs: 30000 });
    return { ok: /success/i.test(result.output), output: result.output.trim() };
  };

  /** Attach/detach the debugger marker for a bundle. */
  const debugAttach = async (device, bundleName, attach) => {
    const result = await hdc(['shell', 'aa', attach ? 'attach' : 'detach', '-b', bundleName], { device, timeoutMs: 30000 });
    return { ok: /success/i.test(result.output), output: result.output.trim() };
  };

  /** List pids hosting a debug transport. */
  const jpid = async (device) => {
    const result = await hdc(['jpid'], { device, timeoutMs: 15000 });
    return result.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => /^\d+$/.test(line))
      .map(Number);
  };

  /** Copy a file from the device. */
  const fileRecv = async (device, remote, local, options = {}) => {
    const result = await hdc(['file', 'recv', remote, local], { device, timeoutMs: options.timeoutMs ?? 60000 });
    return { ok: result.code === 0 && /FileTransfer finish/i.test(result.output), output: result.output.trim() };
  };

  /** Forward a host TCP port to a device node. */
  const fport = async (device, localPort, remote) => {
    const result = await hdc(['fport', `tcp:${localPort}`, remote], { device, timeoutMs: 20000 });
    return { ok: /OK/i.test(result.output), output: result.output.trim() };
  };

  /** List forwards. */
  const fportList = async (device) => {
    const result = await hdc(['fport', 'ls'], { device, timeoutMs: 15000 });
    return result.output.trim();
  };

  /** Remove a forward by its local task string. */
  const fportRemove = async (device, task) => {
    const result = await hdc(['fport', 'rm', task], { device, timeoutMs: 15000 });
    return { ok: result.code === 0, output: result.output.trim() };
  };

  /** Run an arbitrary device shell command. */
  const shell = async (device, command, options = {}) => {
    const args = ['shell', ...(Array.isArray(command) ? command : [command])];
    const result = await hdc(args, { device, timeoutMs: options.timeoutMs ?? 30000, maxBytes: options.maxBytes ?? 256 * 1024 });
    return { output: result.output.trim(), code: result.code };
  };

  /** hdc version string. */
  const version = async () => {
    const result = await hdc(['version']);
    return result.output.trim();
  };

  return {
    path: hdcPath,
    list,
    select,
    info,
    param,
    install,
    uninstall,
    startAbility,
    forceStop,
    pidOf,
    appDebug,
    debugAttach,
    jpid,
    fileRecv,
    fport,
    fportList,
    fportRemove,
    shell,
    version,
  };
}
