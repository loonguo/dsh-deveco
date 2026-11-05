/**
 * Toolchain discovery for DevEco Studio and the HarmonyOS SDK.
 *
 * Everything here is synchronous and cached: discovery runs on the first tool
 * call (and again after a config change), never on module import, so a profile
 * without DevEco installed still loads the plugin.
 *
 * @module @local/dsh-deveco/paths
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Candidate install roots, most specific first. */
const DEVECO_ROOTS = [
  process.env.DEVECO_STUDIO_HOME,
  process.env.DEVECOSTUDIO_HOME,
  'D:\\Software\\DevEco Studio',
  'C:\\Program Files\\Huawei\\DevEco Studio',
  'C:\\Program Files\\Huawei\\DevEco Studio 6.1',
  'C:\\Program Files\\Huawei\\DevEco Studio 6.0',
  'C:\\Program Files\\Huawei\\DevEco Studio 5.0',
];

/** Candidate command-line-tools roots. */
const CLI_ROOTS = [
  process.env.OHOS_CLI_TOOLS,
  process.env.OHOS_COMMAND_LINE_TOOLS,
  'D:\\HarmonyOS\\command-line-tools',
  'C:\\HarmonyOS\\command-line-tools',
  'D:\\Huawei\\command-line-tools',
];

/** Resolve a directory that may itself be the executable file. */
function asDir(candidate, marker) {
  if (!candidate) return null;
  const resolved = path.resolve(candidate);
  if (existsSync(resolved) && statSync(resolved).isFile()) return path.dirname(resolved);
  if (existsSync(path.join(resolved, marker))) return resolved;
  return null;
}

/** First existing path from a list. */
function firstFile(candidates) {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return path.normalize(candidate);
  }
  return null;
}

/** Read a small text file, returning '' when unreadable. */
export function readText(file) {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/** Read JSON, returning null when unreadable or malformed. */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Expand `%VAR%` and `$VAR` references in a configured path. */
export function expandPath(value) {
  if (typeof value !== 'string' || value.length === 0) return '';
  return value.replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? '').replace(/^~/, process.env.USERPROFILE ?? '');
}

/** Locate DevEco Studio from the configured path or common roots. */
function findDeveco(config) {
  const configured = asDir(expandPath(config.devecoPath ?? ''), 'bin');
  const candidates = [configured, ...DEVECO_ROOTS.map((root) => asDir(root, 'bin'))];
  // Versioned installs under the two vendor roots, newest first.
  for (const root of ['C:\\Program Files\\Huawei', 'D:\\Software']) {
    if (!existsSync(root)) continue;
    try {
      const dirs = readdirSync(root)
        .filter((name) => /^DevEco Studio/i.test(name))
        .sort()
        .reverse();
      for (const name of dirs) candidates.push(asDir(path.join(root, name), 'bin'));
    } catch {
      /* unreadable root is not fatal */
    }
  }
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const exe = path.join(candidate, 'bin', 'devecostudio64.exe');
    if (existsSync(exe)) return { path: candidate, exe };
  }
  return null;
}

/** Locate the HarmonyOS command-line tools. */
function findCommandLineTools(config) {
  const configured = asDir(expandPath(config.commandLineTools ?? ''), 'bin');
  const candidates = [configured, ...CLI_ROOTS.map((root) => asDir(root, 'bin'))];
  for (const candidate of candidates) {
    if (candidate === null) continue;
    const hvigor = path.join(candidate, 'bin', 'hvigorw.bat');
    if (existsSync(hvigor)) return candidate;
  }
  return null;
}

/** Locate the SDK root (the directory containing `default/openharmony`). */
function findSdk(config, devecoPath, cltPath) {
  const configured = expandPath(config.sdkPath ?? '');
  const candidates = [
    configured ? path.resolve(configured) : null,
    expandPath(process.env.DEVECO_SDK_HOME ?? '') || null,
    devecoPath ? path.join(devecoPath, 'sdk') : null,
    cltPath ? path.join(cltPath, 'sdk') : null,
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Huawei', 'Sdk') : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    if (existsSync(path.join(candidate, 'default', 'openharmony', 'ets'))) return path.normalize(candidate);
    if (existsSync(path.join(candidate, 'openharmony', 'ets'))) return path.normalize(candidate);
  }
  return null;
}

/** Find a tool on PATH (does not spawn anything). */
function fromPath(name) {
  const pathValue = process.env.PATH ?? '';
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of pathValue.split(path.delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = path.join(directory, name + extension.toUpperCase());
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

/** Read the IDE build number and product version. */
function readDevecoVersion(devecoPath) {
  const info = readJson(path.join(devecoPath, 'product-info.json'));
  if (!info) return { version: '', build: '' };
  return { version: String(info.version ?? ''), build: String(info.buildNumber ?? '') };
}

/** Read the SDK API level. */
function readSdkInfo(sdkRoot) {
  if (!sdkRoot) return { apiVersion: '', platformVersion: '', displayName: '' };
  for (const base of [path.join(sdkRoot, 'default', 'openharmony'), path.join(sdkRoot, 'openharmony')]) {
    const ets = readJson(path.join(base, 'ets', 'oh-uni-package.json'));
    if (ets) {
      return {
        apiVersion: String(ets.apiVersion ?? ''),
        platformVersion: String(ets.platformVersion ?? ets.version ?? ''),
        displayName: `HarmonyOS ${ets.platformVersion ?? ets.version ?? ''}`.trim(),
      };
    }
  }
  return { apiVersion: '', platformVersion: '', displayName: '' };
}

/** Find the SDK toolchain directory. */
function toolchainDir(sdkRoot) {
  if (!sdkRoot) return null;
  for (const base of [path.join(sdkRoot, 'default', 'openharmony'), path.join(sdkRoot, 'openharmony')]) {
    if (existsSync(path.join(base, 'toolchains'))) return path.join(base, 'toolchains');
  }
  return null;
}

/**
 * Discover the whole toolchain. Results are cached until `resetPaths()`.
 * @param {Record<string, unknown>} config
 */
export function discover(config = {}) {
  const deveco = findDeveco(config);
  const cltPath = findCommandLineTools(config);
  const sdkRoot = findSdk(config, deveco?.path ?? null, cltPath);
  const toolchain = toolchainDir(sdkRoot);
  const devecoVersion = deveco ? readDevecoVersion(deveco.path) : { version: '', build: '' };
  const sdkInfo = readSdkInfo(sdkRoot);

  const hdcCandidates = [
    toolchain ? path.join(toolchain, 'hdc.exe') : null,
    cltPath ? path.join(cltPath, 'sdk', 'default', 'openharmony', 'toolchains', 'hdc.exe') : null,
    fromPath('hdc'),
  ];
  const hvigorwCandidates = [
    cltPath ? path.join(cltPath, 'bin', 'hvigorw.bat') : null,
    deveco ? path.join(deveco.path, 'tools', 'hvigor', 'hvigorw.bat') : null,
  ];
  const ohpmCandidates = [
    cltPath ? path.join(cltPath, 'bin', 'ohpm.bat') : null,
    deveco ? path.join(deveco.path, 'tools', 'ohpm', 'bin', 'ohpm.bat') : null,
    fromPath('ohpm'),
  ];
  const nodeCandidates = [
    expandPath(config.nodePath ?? '') || null,
    deveco ? path.join(deveco.path, 'tools', 'node', 'node.exe') : null,
    cltPath ? path.join(cltPath, 'tool', 'node', 'node.exe') : null,
    fromPath('node'),
  ];
  const javaCandidates = [
    expandPath(config.javaPath ?? '') || null,
    deveco ? path.join(deveco.path, 'jbr', 'bin', 'java.exe') : null,
    process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', 'java.exe') : null,
    fromPath('java'),
  ];

  const tools = {
    hdc: firstFile(hdcCandidates),
    hvigorw: firstFile(hvigorwCandidates),
    ohpm: firstFile(ohpmCandidates),
    node: firstFile(nodeCandidates),
    java: firstFile(javaCandidates),
    emulator: deveco ? firstFile([path.join(deveco.path, 'tools', 'emulator', 'Emulator.exe')]) : null,
    keytool: deveco ? firstFile([path.join(deveco.path, 'jbr', 'bin', 'keytool.exe')]) : null,
  };

  const signer = toolchain
    ? {
        jar: firstFile([path.join(toolchain, 'lib', 'hap-sign-tool.jar')]),
        keystore: firstFile([path.join(toolchain, 'lib', 'OpenHarmony.p12')]),
        profileDebug: firstFile([path.join(toolchain, 'lib', 'OpenHarmonyProfileDebug.pem')]),
        profileTemplate: firstFile([path.join(toolchain, 'lib', 'UnsgnedDebugProfileTemplate.json')]),
      }
    : { jar: null, keystore: null, profileDebug: null, profileTemplate: null };

  const issues = [];
  if (deveco === null) issues.push('DevEco Studio was not found; set devecoPath in the plugin config.');
  if (sdkRoot === null) issues.push('HarmonyOS SDK was not found; set sdkPath (the directory containing default/openharmony).');
  if (tools.hdc === null) issues.push('hdc was not found; it ships in the SDK toolchains directory.');
  if (tools.hvigorw === null) issues.push('hvigorw was not found; install HarmonyOS command-line-tools or DevEco Studio.');

  return {
    deveco: deveco ? { ...deveco, ...devecoVersion } : null,
    sdkRoot,
    sdk: sdkInfo,
    commandLineTools: cltPath,
    toolchain,
    tools,
    signer,
    issues,
    discoveredAt: new Date().toISOString(),
  };
}

/* -------------------------------------------------------------------------- */
/* Project resolution                                                         */
/* -------------------------------------------------------------------------- */

/** Whether a directory looks like a HarmonyOS application project. */
export function isProjectRoot(directory) {
  return existsSync(path.join(directory, 'AppScope', 'app.json5')) || existsSync(path.join(directory, 'build-profile.json5'));
}

/**
 * Resolve a project directory: explicit argument, configured default, the
 * session working directory, or the nearest ancestor of `startDir`.
 *
 * @param {{ projectRoot?: string }} config
 * @param {string|undefined} explicit
 * @param {string|undefined} startDir
 */
export function resolveProjectDir(config, explicit, startDir) {
  const tryDir = (candidate) => {
    if (typeof candidate !== 'string' || candidate.length === 0) return null;
    const resolved = path.resolve(expandPath(candidate));
    if (isProjectRoot(resolved)) return resolved;
    return null;
  };
  const direct = tryDir(explicit) ?? tryDir(config.projectRoot ?? '');
  if (direct) return direct;
  let current = path.resolve(startDir ?? config.projectRoot ?? process.cwd());
  for (let depth = 0; depth < 8; depth += 1) {
    if (isProjectRoot(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}
