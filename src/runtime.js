/**
 * The runtime that the tools, the toolbar and the IDE handoff all share.
 *
 * One place owns discovery, project/ability resolution, the build → install →
 * launch pipeline, the live UI state and the teardown of every child process.
 * Tools and toolbar actions call these methods, so the two callers cannot drift
 * apart.
 *
 * @module @local/dsh-deveco/runtime
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { buildProject, hvigorVersion } from './build.js';
import { createDebugService } from './debug.js';
import { createDeviceService } from './device.js';
import { createEmulatorService } from './emulator.js';
import { discover, listWorkspaceProjects, resolveProjectDir } from './paths.js';
import { describeProject, findArtifacts, readBundleName, readModules } from './project.js';
import { run } from './exec.js';
import { createIdeService } from './ide.js';
import { createLogService } from './log.js';
import { createUiService } from './ui.js';

/** Config defaults, documented in cordis.patch.yml. */
export const DEFAULTS = {
  devecoPath: '',
  sdkPath: '',
  commandLineTools: '',
  projectRoot: '',
  device: '',
  javaPath: '',
  nodePath: '',
  buildTimeoutMs: 600000,
  defaultTimeoutMs: 60000,
  logBufferLines: 5000,
  autoBuildOnRun: true,
  emulatorName: '',
  autoStartEmulator: true,
  emulatorBootTimeoutMs: 240000,
};

/** Merge a row config over the defaults. */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null) config[key] = value;
    }
  }
  for (const key of ['buildTimeoutMs', 'defaultTimeoutMs', 'logBufferLines', 'emulatorBootTimeoutMs']) {
    const value = Number(config[key]);
    config[key] = Number.isFinite(value) && value > 0 ? value : DEFAULTS[key];
  }
  return config;
}

/**
 * Create the runtime bound to one plugin activation.
 * @param {Record<string, unknown>} rawConfig
 * @param {{ resolveSessionDirectory?: (sessionId: string) => string|undefined }} [hooks]
 */
export function createRuntime(rawConfig, hooks = {}) {
  const config = normalizeConfig(rawConfig);
  let cachedPaths = null;
  let workspace = process.cwd();
  let lastBuild = null;
  let lastRun = null;
  let busy = null;
  let message = '';
  let lastError = '';
  /** Per-session project choice made in the floating panel. */
  const toolbarSelections = new Map();
  /** @type {Map<string, { at: number, info: any }>} */
  const deviceInfoCache = new Map();

  const paths = () => {
    if (cachedPaths === null) cachedPaths = discover(config);
    return cachedPaths;
  };

  const runtime = {
    config,
    paths,
    refreshPaths() {
      cachedPaths = null;
      return paths();
    },
    attachWorkspace(directory) {
      if (typeof directory === 'string' && directory.length > 0) workspace = directory;
    },
    get workspace() {
      return workspace;
    },
    workDir(sub = '') {
      const base = path.join(workspace, '.dsh-deveco');
      const target = sub === '' ? base : path.join(base, sub);
      mkdirSync(target, { recursive: true });
      return target;
    },
    layoutDir() {
      return runtime.workDir('layout');
    },
    shotsDir() {
      return runtime.workDir('shots');
    },
    sessionDirectory(sessionId) {
      try {
        return hooks.resolveSessionDirectory?.(sessionId);
      } catch {
        return undefined;
      }
    },
  };

  runtime.device = createDeviceService(runtime);
  runtime.emulator = createEmulatorService(runtime);
  runtime.log = createLogService(runtime);
  runtime.ui = createUiService(runtime);
  runtime.debug = createDebugService(runtime);
  runtime.ide = createIdeService(runtime);

  /**
   * The working directory of the session a tool call belongs to, when the host
   * exposes it. Lets tools resolve the project of *their* workspace instead of
   * the process directory.
   */
  runtime.execDirectory = (exec) => {
    try {
      return hooks.resolveAgentDirectory?.(exec?.agent);
    } catch {
      return undefined;
    }
  };

  /**
   * Resolve a project plus the module and ability a launch should use.
   *
   * The workspace decides: the explicit argument, else the session directory
   * (or its nearest project ancestor), else — only when no workspace is known —
   * the configured `projectRoot`. A workspace without a project yields an
   * error, never a project borrowed from somewhere else.
   *
   * @param {string|undefined} explicit
   * @param {string|undefined} sessionId
   * @param {string|undefined} startDir workspace directory when no session id is known
   */
  runtime.resolveProject = (explicit, sessionId, startDir) => {
    const sessionDir = sessionId === undefined ? undefined : runtime.sessionDirectory(sessionId);
    const base = sessionDir ?? startDir;
    const dir = resolveProjectDir(config, explicit, base);
    if (dir === null) {
      throw new Error(
        base
          ? `no HarmonyOS project in this workspace (${base}). Open a folder that contains AppScope/app.json5, or pass project explicitly.`
          : `no HarmonyOS project was found${explicit ? ` at "${explicit}"` : ''}. Open a HarmonyOS project workspace, or pass project.`,
      );
    }
    const modules = readModules(dir);
    const entry = modules.find((module) => module.type === 'entry') ?? modules[0] ?? null;
    return {
      dir,
      name: path.basename(dir),
      bundleName: readBundleName(dir),
      module: entry,
      moduleName: entry?.name ?? 'entry',
      ability: entry?.mainElement ?? entry?.abilities?.[0]?.name ?? 'EntryAbility',
      modules,
    };
  };

  /** Pick the newest HAP (or an explicit one). */
  runtime.pickArtifact = (projectDir, explicitPath) => {
    if (typeof explicitPath === 'string' && explicitPath.length > 0) {
      return { path: path.resolve(explicitPath), name: path.basename(explicitPath), bytes: 0, mtimeMs: 0 };
    }
    const artifacts = findArtifacts(projectDir, 'hap');
    if (artifacts.length === 0) {
      throw new Error('no .hap was found under entry/build; build the project first (deveco_build).');
    }
    return artifacts[0];
  };

  /** Build the project and remember the outcome for the toolbar. */
  runtime.build = async (options = {}) => {
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId, options.startDir);
    const result = await buildProject(runtime, {
      projectDir: project.dir,
      task: options.task ?? 'assembleHap',
      module: options.module,
      product: options.product ?? 'default',
      mode: options.mode ?? 'debug',
      projectMode: options.projectMode === true,
      timeoutMs: options.timeoutMs,
      signal: options.signal,
    });
    lastBuild = {
      ok: result.ok,
      task: result.task,
      mode: result.mode,
      errors: result.errors,
      warnings: result.warnings,
      durationMs: result.durationMs,
      at: new Date().toISOString(),
      artifacts: result.artifacts.map((artifact) => artifact.path),
      firstDiagnostic: result.diagnostics[0]?.message ?? '',
    };
    message = result.ok ? `Build succeeded in ${(result.durationMs / 1000).toFixed(1)}s` : `Build failed (${result.errors} errors)`;
    return result;
  };

  /** Install one HAP on a device. */
  runtime.install = async (options = {}) => {
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId, options.startDir);
    const device = options.device ?? (await runtime.device.select(options.deviceKey));
    const artifact = runtime.pickArtifact(project.dir, options.hap);
    const result = await runtime.device.install(artifact.path, device, { timeoutMs: options.timeoutMs ?? 180000 });
    return { ...result, device, project, artifact };
  };

  /** Wait helper for the emulator boot loop. */
  const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  /**
   * Start the configured (or default) emulator and wait until hdc reports a
   * usable device. Used by Run when nothing is attached, so pressing the panel
   * button on a cold machine boots the emulator and then launches the app.
   */
  runtime.ensureEmulator = async (options = {}) => {
    const pathsNow = paths();
    if (!pathsNow.tools.emulator) {
      throw new Error('no HarmonyOS device is connected and Emulator.exe was not found; start an emulator or attach a phone with USB debugging.');
    }
    const { instances } = await runtime.emulator.list();
    const wanted = options.emulatorName || config.emulatorName || '';
    let instance = wanted === '' ? null : instances.find((entry) => entry.name === wanted) ?? null;
    if (wanted !== '' && instance === null) {
      throw new Error(`emulator instance "${wanted}" was not found. Instances: ${instances.map((entry) => entry.name).join(', ') || '(none)'}.`);
    }
    if (instance === null) {
      instance = instances.find((entry) => !entry.running && entry.deviceType === 'phone') ?? instances.find((entry) => !entry.running) ?? null;
    }
    if (instance === null) {
      throw new Error(
        instances.length === 0
          ? 'no emulator instance is installed; create one in DevEco Studio → Device Manager, or attach a phone.'
          : `every emulator instance is already running (${instances.map((entry) => entry.name).join(', ')}) but none answered hdc yet; retry once it finishes booting.`,
      );
    }
    message = `Starting emulator ${instance.name}…`;
    const bootTimeoutMs = Number(config.emulatorBootTimeoutMs ?? 240000);
    const started = await runtime.emulator.start(instance.name, { noWindow: options.noWindow === true, timeoutMs: bootTimeoutMs });
    if (!started.running) {
      throw new Error(`emulator ${instance.name} did not start${started.hint ? `: ${started.hint}` : '.'}`);
    }
    message = `Waiting for ${instance.name} to boot…`;
    const deadline = Date.now() + bootTimeoutMs;
    while (Date.now() < deadline) {
      const usable = (await runtime.device.list().catch(() => ({ targets: [] }))).targets.filter((target) => target.usable);
      if (usable.length > 0) {
        try {
          return { device: await runtime.device.select(options.deviceKey), name: instance.name };
        } catch {
          /* several devices appeared at once; retry until one can be selected */
        }
      }
      await wait(2500);
    }
    throw new Error(`emulator ${instance.name} is running but hdc did not report a usable device within ${Math.round(bootTimeoutMs / 1000)}s.`);
  };

  /**
   * Resolve the device for an action: an explicit target, the attached device,
   * or — only when nothing at all is attached — a freshly started emulator.
   */
  runtime.resolveDevice = async (options = {}) => {
    if (options.device) return options.device;
    try {
      return await runtime.device.select(options.deviceKey);
    } catch (error) {
      const noDevice = String(error?.message ?? error).includes('no HarmonyOS device is connected');
      const explicit = typeof options.deviceKey === 'string' && options.deviceKey.length > 0;
      const allowed = options.autoStartEmulator !== false && config.autoStartEmulator !== false;
      if (!noDevice || explicit || !allowed) throw error;
      const started = await runtime.ensureEmulator(options);
      return started.device;
    }
  };

  /** Launch the app (optionally building/installing first). */
  runtime.run = async (options = {}) => {
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId, options.startDir);
    const steps = [];
    let buildResult = null;
    let device;
    try {
      device = options.device ?? (await runtime.device.select(options.deviceKey));
    } catch (error) {
      const noDevice = String(error?.message ?? error).includes('no HarmonyOS device is connected');
      const explicit = typeof options.deviceKey === 'string' && options.deviceKey.length > 0;
      const allowed = options.autoStartEmulator !== false && config.autoStartEmulator !== false;
      if (!noDevice || explicit || !allowed) throw error;
      const started = await runtime.ensureEmulator(options);
      device = started.device;
      steps.push({ step: 'emulator', ok: true, detail: started.name });
    }

    if (options.build === true) {
      message = 'Building…';
      buildResult = await runtime.build({ projectDir: project.dir, mode: options.mode ?? 'debug', module: options.moduleName });
      steps.push({ step: 'build', ok: buildResult.ok, detail: buildResult.ok ? `${buildResult.durationMs} ms` : `${buildResult.errors} errors` });
      if (!buildResult.ok) {
        return { ok: false, stage: 'build', build: buildResult, device, project, steps, diagnostics: buildResult.diagnostics };
      }
    }

    if (options.install !== false) {
      message = 'Installing…';
      const artifact = runtime.pickArtifact(project.dir, options.hap);
      const installed = await runtime.device.install(artifact.path, device, { timeoutMs: 180000 });
      steps.push({ step: 'install', ok: installed.ok, detail: artifact.name });
      if (!installed.ok) {
        return { ok: false, stage: 'install', device, project, steps, artifact, output: installed.output };
      }
    }

    const ability = options.ability ?? project.ability;
    if (options.debug === true) {
      message = 'Starting in debug mode…';
      const debugResult = await runtime.debug.start(device, {
        bundleName: project.bundleName,
        ability,
        moduleName: project.moduleName,
        persist: options.persistDebug === true,
      });
      steps.push({ step: 'debug-start', ok: debugResult.ok, detail: debugResult.pid ?? '' });
      lastRun = { device, project, pid: debugResult.pid ?? null, at: new Date().toISOString(), debug: true };
      return { ...debugResult, device, project, steps, build: buildResult };
    }

    message = 'Launching…';
    const stopped = await runtime.device.forceStop(device, project.bundleName).catch(() => ({ ok: false }));
    steps.push({ step: 'force-stop', ok: stopped.ok, detail: '' });
    const launched = await runtime.device.startAbility(device, {
      bundleName: project.bundleName,
      ability,
      moduleName: project.moduleName,
    });
    steps.push({ step: 'start', ok: launched.ok, detail: ability });
    if (!launched.ok) {
      return { ok: false, stage: 'start', device, project, steps, output: launched.output };
    }
    const pid = await runtime.debug.pollPid(device, project.bundleName, 15);
    lastRun = { device, project, pid, at: new Date().toISOString(), debug: false };
    message = pid === null ? 'Launched (no process yet)' : `Running (pid ${pid})`;
    return {
      ok: pid !== null,
      stage: pid === null ? 'started-no-pid' : 'running',
      device,
      project,
      pid,
      ability,
      steps,
      build: buildResult,
      output: launched.output,
    };
  };

  /** Force-stop the app of the current/last project. */
  runtime.stop = async (options = {}) => {
    const project = options.project ?? lastRun?.project ?? runtime.resolveProject(options.projectDir, options.sessionId, options.startDir);
    const device = options.device ?? lastRun?.device ?? (await runtime.device.select(options.deviceKey));
    const result = await runtime.device.forceStop(device, project.bundleName);
    lastRun = { ...(lastRun ?? {}), pid: null, project, device, at: new Date().toISOString() };
    message = 'Stopped';
    return { ok: result.ok, output: result.output, device, project };
  };

  /** Read a hilog snapshot for one pid (used by run/status). */
  runtime.logSnapshot = async (device, pid, lines = 120) => {
    const hdc = runtime.paths().tools.hdc;
    if (!hdc) return { lines: [], text: '' };
    const args = ['-t', device.key, 'hilog', '-x'];
    if (pid !== null && pid !== undefined) args.push('-P', String(pid));
    args.push('-z', String(lines));
    const result = await run(hdc, args, { timeoutMs: 30000, maxBytes: 512 * 1024 });
    const text = result.output.trim();
    return { lines: text === '' ? [] : text.split(/\r?\n/), text };
  };

  /** Snapshot for the toolbar and deveco_status. */
  runtime.snapshot = async (options = {}) => {
    const pathsNow = paths();
    let device = null;
    let deviceError = '';
    try {
      const target = await runtime.device.select(options.deviceKey);
      // Device details cost four hdc round-trips; the toolbar polls, so keep
      // them for half a minute per target.
      const cached = deviceInfoCache.get(target.key);
      if (cached !== undefined && Date.now() - cached.at < 30000) {
        device = cached.info;
      } else {
        device = await runtime.device.info(target);
        deviceInfoCache.set(target.key, { at: Date.now(), info: device });
      }
    } catch (error) {
      deviceError = String(error?.message ?? error);
    }
    let project = null;
    let projectError = '';
    try {
      project = runtime.resolveProject(options.projectDir, options.sessionId, options.startDir);
    } catch (error) {
      projectError = String(error?.message ?? error);
    }
    const running = project !== null && device !== null ? (await runtime.device.pidOf(device, project.bundleName).catch(() => null)) : null;
    return {
      tools: {
        deveco: pathsNow.deveco?.path ?? '',
        devecoVersion: pathsNow.deveco?.version ?? '',
        sdk: pathsNow.sdkRoot ?? '',
        apiVersion: pathsNow.sdk.apiVersion,
        platformVersion: pathsNow.sdk.platformVersion,
        hdc: pathsNow.tools.hdc ?? '',
        hvigorw: pathsNow.tools.hvigorw ?? '',
        ohpm: pathsNow.tools.ohpm ?? '',
        node: pathsNow.tools.node ?? '',
        java: pathsNow.tools.java ?? '',
        emulator: pathsNow.tools.emulator ?? '',
      },
      issues: pathsNow.issues,
      device,
      deviceError,
      project: project
        ? { dir: project.dir, name: project.name, bundleName: project.bundleName, module: project.moduleName, ability: project.ability }
        : null,
      projectError,
      running,
      lastBuild,
      lastRun,
      busy,
      message,
      error: lastError,
    };
  };

  /** Projects the panel can choose from in this workspace, newest first. */
  runtime.toolbarProjects = (sessionId) => {
    let base;
    try {
      base = sessionId === undefined ? workspace : (runtime.sessionDirectory(sessionId) ?? undefined);
    } catch {
      base = undefined;
    }
    return listWorkspaceProjects(base).map((dir) => ({ name: path.basename(dir), dir, bundleName: readBundleName(dir) }));
  };

  /** The project chosen in the panel for one session ('' when none). */
  runtime.toolbarSelection = (sessionId) => toolbarSelections.get(sessionId ?? '') ?? '';

  /** Choose one of the workspace's projects for the panel's actions. */
  runtime.selectToolbarProject = (sessionId, directory) => {
    const projects = runtime.toolbarProjects(sessionId);
    const wanted = path.resolve(String(directory ?? ''));
    if (!projects.some((entry) => entry.dir === wanted)) {
      throw new Error(`"${wanted}" is not a project of this workspace (${projects.map((entry) => entry.name).join(', ') || 'none'})`);
    }
    toolbarSelections.set(sessionId ?? '', wanted);
    message = `Project ${path.basename(wanted)}`;
    return wanted;
  };

  /** Execute a toolbar action under a single-flight guard. */
  runtime.perform = async (action, options = {}) => {
    if (busy !== null) throw new Error(`another action is running (${busy}); wait for it to finish.`);
    busy = action;
    lastError = '';
    const selection = runtime.toolbarSelection(options.sessionId);
    const effective = selection === '' ? options : { ...options, projectDir: options.projectDir ?? selection };
    try {
      switch (action) {
        case 'build':
          return await runtime.build(effective);
        case 'run':
          return await runtime.run({ build: effective.build ?? false, ...effective });
        case 'stop':
          return await runtime.stop(effective);
        case 'open':
          return await runtime.ide.open({ projectDir: runtime.resolveProject(effective.projectDir, effective.sessionId, effective.startDir).dir });
        default:
          throw new Error(`unknown action "${action}"`);
      }
    } catch (error) {
      lastError = String(error?.message ?? error);
      message = lastError;
      throw error;
    } finally {
      busy = null;
    }
  };

  /** Whether DevEco Studio itself is running (cached: tasklist is a process launch). */
  let ideCache = { at: 0, value: false };
  runtime.ideRunning = async () => {
    if (Date.now() - ideCache.at < 15000) return ideCache.value;
    const value = await runtime.ide.running().catch(() => false);
    ideCache = { at: Date.now(), value };
    return value;
  };

  /** Toolbar state, derived from one snapshot (never throws). */
  runtime.toolbarState = async (sessionId) => {
    let snapshot = null;
    try {
      snapshot = await runtime.snapshot({ sessionId });
    } catch {
      snapshot = null;
    }
    const ideRunning = await runtime.ideRunning();
    let workspace = null;
    try {
      workspace = sessionId === undefined ? null : (runtime.sessionDirectory(sessionId) ?? null);
    } catch {
      workspace = null;
    }
    const selection = runtime.toolbarSelection(sessionId);
    let project = snapshot?.project ? { name: snapshot.project.name, dir: snapshot.project.dir, bundleName: snapshot.project.bundleName } : null;
    let running = snapshot?.running ?? null;
    if (selection !== '') {
      try {
        const chosen = runtime.resolveProject(selection, sessionId);
        project = { name: chosen.name, dir: chosen.dir, bundleName: chosen.bundleName };
        running = snapshot?.device ? await runtime.device.pidOf(snapshot.device, chosen.bundleName).catch(() => null) : null;
      } catch {
        /* a vanished selection falls back to the resolved project */
      }
    }
    let projects = [];
    try {
      projects = runtime.toolbarProjects(sessionId);
    } catch {
      projects = [];
    }
    return {
      ok: true,
      state: {
        busy,
        message,
        error: lastError,
        running: running !== null && running !== undefined,
        pid: running ?? null,
        projects,
        ideRunning,
        port: runtime.toolbarPort ?? 0,
        workspace,
        device: snapshot?.device ? { key: snapshot.device.key, model: snapshot.device.model, api: snapshot.device.api, emulator: snapshot.device.emulator } : null,
        project,
        lastBuild: lastBuild === null ? null : { ok: lastBuild.ok, errors: lastBuild.errors, warnings: lastBuild.warnings, at: lastBuild.at },
      },
    };
  };

  /** Toolchain versions for status output. */
  runtime.versions = async () => {
    const pathsNow = paths();
    const [hdcVersion, hvigor] = await Promise.all([
      pathsNow.tools.hdc ? run(pathsNow.tools.hdc, ['version'], { timeoutMs: 15000 }).then((result) => result.output.trim()) : Promise.resolve(''),
      hvigorVersion(runtime).catch(() => ''),
    ]);
    return { hdc: hdcVersion, hvigor };
  };

  runtime.describeProject = describeProject;

  runtime.dispose = () => {
    runtime.log.dispose();
  };

  return runtime;
}
