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
import { discover, findRecentProject, isProjectRoot, resolveProjectDir } from './paths.js';
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
};

/** Merge a row config over the defaults. */
export function normalizeConfig(raw) {
  const config = { ...DEFAULTS };
  if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw)) {
      if (value !== undefined && value !== null) config[key] = value;
    }
  }
  for (const key of ['buildTimeoutMs', 'defaultTimeoutMs', 'logBufferLines']) {
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
  let lastProjectDir = '';
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
   * Resolve a project plus the module and ability a launch should use.
   * @param {string|undefined} explicit
   * @param {string|undefined} sessionId
   */
  runtime.resolveProject = (explicit, sessionId) => {
    const sessionDir = sessionId === undefined ? undefined : runtime.sessionDirectory(sessionId);
    let dir = resolveProjectDir(config, explicit, sessionDir ?? workspace);
    // A session that does not live inside a HarmonyOS project (this plugin's
    // own repository, a scratch session) still gets the toolbar: fall back to
    // the project this runtime used last, then to the most recently touched
    // project under the usual DevEco project roots.
    if (dir === null && lastProjectDir !== '' && isProjectRoot(lastProjectDir)) dir = lastProjectDir;
    if (dir === null) dir = findRecentProject();
    if (dir === null) {
      throw new Error(
        `no HarmonyOS project was found${explicit ? ` at "${explicit}"` : ''}. Pass project, set projectRoot in the dsh-deveco config, or run from a project directory (AppScope/app.json5).`,
      );
    }
    lastProjectDir = dir;
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
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId);
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
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId);
    const device = options.device ?? (await runtime.device.select(options.deviceKey));
    const artifact = runtime.pickArtifact(project.dir, options.hap);
    const result = await runtime.device.install(artifact.path, device, { timeoutMs: options.timeoutMs ?? 180000 });
    return { ...result, device, project, artifact };
  };

  /** Launch the app (optionally building/installing first). */
  runtime.run = async (options = {}) => {
    const project = options.project ?? runtime.resolveProject(options.projectDir, options.sessionId);
    const device = options.device ?? (await runtime.device.select(options.deviceKey));
    const steps = [];
    let buildResult = null;

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
    const project = options.project ?? lastRun?.project ?? runtime.resolveProject(options.projectDir, options.sessionId);
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
      project = runtime.resolveProject(options.projectDir, options.sessionId);
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

  /** Execute a toolbar action under a single-flight guard. */
  runtime.perform = async (action, options = {}) => {
    if (busy !== null) throw new Error(`another action is running (${busy}); wait for it to finish.`);
    busy = action;
    lastError = '';
    try {
      switch (action) {
        case 'build':
          return await runtime.build(options);
        case 'run':
          return await runtime.run({ build: options.build ?? false, ...options });
        case 'stop':
          return await runtime.stop(options);
        case 'open':
          return await runtime.ide.open({ projectDir: runtime.resolveProject(options.projectDir, options.sessionId).dir });
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

  /** Toolbar state, derived from one snapshot (never throws). */
  runtime.toolbarState = async (sessionId) => {
    let snapshot = null;
    try {
      snapshot = await runtime.snapshot({ sessionId });
    } catch {
      snapshot = null;
    }
    return {
      ok: true,
      state: {
        busy,
        message,
        error: lastError,
        running: snapshot?.running !== null && snapshot?.running !== undefined,
        pid: snapshot?.running ?? null,
        device: snapshot?.device ? { key: snapshot.device.key, model: snapshot.device.model, api: snapshot.device.api, emulator: snapshot.device.emulator } : null,
        project: snapshot?.project ? { name: snapshot.project.name, dir: snapshot.project.dir, bundleName: snapshot.project.bundleName } : null,
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
