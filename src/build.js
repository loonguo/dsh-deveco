/**
 * hvigor builds: environment injection, output parsing, artifact discovery.
 *
 * The build is the part most likely to fail for environmental reasons, so the
 * failure text matters: diagnostics are extracted into `{severity, file, line,
 * column, code, message}` and the signing warning is reported as a warning of
 * its own instead of being buried in the log tail.
 *
 * @module @local/dsh-deveco/build
 */

import path from 'node:path';

import { run } from './exec.js';
import { findArtifacts } from './project.js';

/** File:line:col style compiler diagnostics. */
const FILE_DIAGNOSTIC = /^(?<file>(?:[A-Za-z]:)?[^\s:][^\s]*\.(?:ets|ts|js|json5?|c|cpp|h))\s*:\s*(?<line>\d+)\s*:\s*(?<column>\d+)\s*[-:]\s*(?<severity>error|warning)\s*[: ]?\s*(?<code>[A-Z]{1,6}\d{3,})?\s*:?\s*(?<message>.*)$/i;
/** `ERROR: 00308002 Operation Error` style codes. */
const CODED_ERROR = /^\s*(?:>\s*)?(?:hvigor\s+)?(?<severity>ERROR|WARN(?:ING)?)\s*:\s*(?<code>\d{5,})?\s*(?<message>.*)$/;
/** `Error Message: ...` continuation. */
const ERROR_MESSAGE = /^\s*Error Message\s*:\s*(?<message>.+)$/;
/** A line that is only a code and a message. */
const CODE_LINE = /^\s*(?<code>\d{5,})\s+(?<message>.+)$/;

/**
 * Parse combined hvigor output into structured diagnostics.
 *
 * @param {string} output
 * @param {string} [projectDir] used to shorten absolute paths
 * @returns {{ diagnostics: Array<{severity: string, file?: string, line?: number, column?: number, code?: string, message: string}>, errors: number, warnings: number, successful: boolean }}
 */
export function parseBuildOutput(output, projectDir) {
  const diagnostics = [];
  const seen = new Set();
  const push = (diagnostic) => {
    const key = `${diagnostic.severity}|${diagnostic.file ?? ''}|${diagnostic.line ?? ''}|${diagnostic.message}`;
    if (seen.has(key) || diagnostics.length >= 80) return;
    seen.add(key);
    diagnostics.push(diagnostic);
  };
  const shorten = (file) => {
    if (!projectDir) return file;
    const relative = path.relative(projectDir, file);
    return relative.startsWith('..') ? file : relative.replace(/\\/g, '/');
  };

  const lines = output.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const fileMatch = line.match(FILE_DIAGNOSTIC);
    if (fileMatch?.groups) {
      push({
        severity: fileMatch.groups.severity.toLowerCase().startsWith('warn') ? 'warning' : 'error',
        file: shorten(fileMatch.groups.file),
        line: Number(fileMatch.groups.line),
        column: Number(fileMatch.groups.column),
        ...(fileMatch.groups.code ? { code: fileMatch.groups.code } : {}),
        message: fileMatch.groups.message.trim(),
      });
      continue;
    }
    const coded = line.match(CODED_ERROR);
    if (coded?.groups) {
      const severity = coded.groups.severity.toLowerCase().startsWith('warn') ? 'warning' : 'error';
      const message = `${coded.groups.message ?? ''}`.trim();
      if (message === '' || /^BUILD (FAILED|SUCCESSFUL)/i.test(message)) continue;
      const next = lines[index + 1] ?? '';
      const detail = next.match(ERROR_MESSAGE)?.groups?.message ?? '';
      push({
        severity,
        ...(coded.groups.code ? { code: coded.groups.code } : {}),
        message: detail !== '' ? `${message}: ${detail.trim()}` : message,
      });
      continue;
    }
    const codeLine = line.match(CODE_LINE);
    if (codeLine?.groups) {
      push({ severity: 'error', code: codeLine.groups.code, message: codeLine.groups.message.trim() });
    }
  }

  if (/No signingConfigs profile is configured/i.test(output)) {
    push({
      severity: 'warning',
      code: 'SIGNING',
      message: 'No signingConfigs profile is configured; the HAP is unsigned. Emulators accept unsigned HAPs, physical devices do not — enable automatic signing in DevEco Studio for a real device.',
    });
  }
  if (/spawn java ENOENT|java: command not found/i.test(output)) {
    push({
      severity: 'error',
      code: 'JAVA',
      message: 'java is required to package/sign the HAP; the plugin normally injects DevEco Studio\'s bundled JBR. Set javaPath in the config when DevEco is installed elsewhere.',
    });
  }

  const errors = diagnostics.filter((entry) => entry.severity === 'error').length;
  const warnings = diagnostics.filter((entry) => entry.severity === 'warning').length;
  return { diagnostics, errors, warnings, successful: /BUILD SUCCESSFUL/i.test(output) && errors === 0 };
}

/** Set an environment variable regardless of the casing Windows preserved. */
function setEnv(env, name, value) {
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === name.toUpperCase()) delete env[key];
  }
  env[name] = value;
}

/** Read an environment variable regardless of casing. */
function getEnv(env, name) {
  for (const [key, value] of Object.entries(env)) {
    if (key.toUpperCase() === name.toUpperCase()) return value ?? '';
  }
  return '';
}

/** Environment overrides for hvigor: Java, SDK and a stable PATH order. */
export function buildEnvironment(paths) {
  const env = { ...process.env };
  const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'Path';
  const originalPath = env[pathKey] ?? process.env[pathKey] ?? '';
  const prefixes = [];
  if (paths.tools.java) prefixes.push(path.dirname(paths.tools.java));
  if (paths.tools.node) prefixes.push(path.dirname(paths.tools.node));
  if (paths.commandLineTools) prefixes.push(path.join(paths.commandLineTools, 'bin'));
  setEnv(env, 'PATH', [...prefixes, originalPath].filter((part) => part !== '').join(';'));
  if (paths.sdkRoot) setEnv(env, 'DEVECO_SDK_HOME', paths.sdkRoot);
  if (paths.tools.java) setEnv(env, 'JAVA_HOME', path.dirname(path.dirname(paths.tools.java)));
  setEnv(env, 'NO_COLOR', '1');
  setEnv(env, 'FORCE_COLOR', '0');
  return env;
}

/**
 * Run one hvigor task in a project.
 *
 * @param {{ paths: () => any, config: Record<string, any> }} runtime
 * @param {{ projectDir: string, task?: string, module?: string, product?: string, mode?: 'debug'|'release', projectMode?: boolean, timeoutMs?: number, signal?: AbortSignal }} options
 */
export async function buildProject(runtime, options) {
  const paths = runtime.paths();
  if (!paths.tools.hvigorw) {
    throw new Error('hvigorw was not found. Install HarmonyOS command-line-tools (bin/hvigorw.bat) or DevEco Studio (tools/hvigor/hvigorw.bat).');
  }
  const task = options.task ?? 'assembleHap';
  const product = options.product ?? 'default';
  const mode = options.mode ?? 'debug';
  const args = [task, '--mode', options.projectMode === true ? 'project' : 'module', '-p', `product=${product}`, '-p', `buildMode=${mode}`, '--no-daemon'];
  if (options.module) args.push('-p', `module=${options.module}`);
  const result = await run(paths.tools.hvigorw, args, {
    cwd: options.projectDir,
    env: buildEnvironment(paths),
    timeoutMs: options.timeoutMs ?? Number(runtime.config.buildTimeoutMs ?? 600000),
    signal: options.signal,
    maxBytes: 8 * 1024 * 1024,
  });
  const parsed = parseBuildOutput(result.output, options.projectDir);
  const artifacts = findArtifacts(options.projectDir, task === 'assembleApp' ? 'app' : 'hap');
  return {
    ok: result.code === 0 && parsed.successful && parsed.errors === 0,
    task,
    product,
    mode,
    module: options.module ?? '',
    code: result.code,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    command: result.command,
    output: result.output,
    diagnostics: parsed.diagnostics,
    errors: parsed.errors,
    warnings: parsed.warnings,
    artifacts,
    spawnError: result.spawnError ? result.spawnError.message : null,
  };
}

/** hvigor version, for status output. */
export async function hvigorVersion(runtime) {
  const paths = runtime.paths();
  if (!paths.tools.hvigorw) return '';
  const result = await run(paths.tools.hvigorw, ['--version'], {
    env: buildEnvironment(paths),
    timeoutMs: 30000,
    maxBytes: 64 * 1024,
  });
  const match = result.output.match(/\d+\.\d+\.\d+[^\s]*/);
  return match ? match[0] : '';
}
