/**
 * The ten model-facing `deveco_*` tools.
 *
 * Raw `ctx.tools.register` stores `parameters` verbatim and does not validate
 * arguments, so this module compiles plain JSON Schema by hand, validates the
 * model's arguments before any process starts, and renders a compact text
 * summary (plus an image block for screenshots).
 *
 * @module @local/dsh-deveco/tools
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { run } from './exec.js';
import { scaffold } from './project.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesRoot = path.join(here, '..', 'templates');

/* -------------------------------------------------------------------------- */
/* Schema + validation                                                        */
/* -------------------------------------------------------------------------- */

/** Compile author parameter specs (inline `required: true`) into JSON Schema. */
export function compileParameters(spec) {
  const properties = {};
  const required = [];
  for (const [key, value] of Object.entries(spec ?? {})) {
    if (value !== null && typeof value === 'object' && value.required === true) required.push(key);
    properties[key] = compileValue(value);
  }
  return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) };
}

function compileValue(spec) {
  if (spec === null || typeof spec !== 'object') throw new TypeError('parameter schema nodes must be objects');
  const node = {};
  if (spec.type !== undefined) node.type = spec.type;
  for (const key of ['description', 'default', 'minimum', 'maximum']) {
    if (spec[key] !== undefined) node[key] = spec[key];
  }
  if (spec.enum !== undefined) node.enum = [...spec.enum];
  if (spec.type === 'object') {
    const properties = {};
    const required = [];
    for (const [key, value] of Object.entries(spec.properties ?? {})) {
      if (value !== null && typeof value === 'object' && value.required === true) required.push(key);
      properties[key] = compileValue(value);
    }
    node.properties = properties;
    if (required.length > 0) node.required = required;
    if (typeof spec.additionalProperties === 'boolean') node.additionalProperties = spec.additionalProperties;
  } else if (spec.type === 'array' && spec.items !== undefined) {
    node.items = compileValue(spec.items);
  }
  return node;
}

/** Validate one argument value against a compiled schema node. */
function validateValue(tool, namePath, schema, value) {
  if (value === undefined || value === null) return;
  const expected = schema.type;
  const fail = (wanted) => {
    throw new Error(`${tool}: argument "${namePath}" must be ${wanted}${schema.description ? ` — ${schema.description}` : ''}.`);
  };
  if (expected === 'string' && typeof value !== 'string') fail('a string');
  if (expected === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) fail('a finite number');
  if (expected === 'integer' && (typeof value !== 'number' || !Number.isInteger(value))) fail('an integer');
  if (expected === 'boolean' && typeof value !== 'boolean') fail('a boolean');
  if (expected === 'array') {
    if (!Array.isArray(value)) fail('an array');
    if (Array.isArray(value) && schema.items) value.forEach((entry, index) => validateValue(tool, `${namePath}[${index}]`, schema.items, entry));
  }
  if (expected === 'object' && (typeof value !== 'object' || Array.isArray(value))) fail('an object');
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    throw new Error(`${tool}: argument "${namePath}" must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')} (got ${JSON.stringify(value)}).`);
  }
}

/** Validate all arguments against one compiled object schema. */
export function validateArguments(tool, schema, rawArgs) {
  const args = rawArgs === undefined || rawArgs === null ? {} : rawArgs;
  if (typeof args !== 'object' || Array.isArray(args)) throw new Error(`${tool}: arguments must be an object.`);
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      const description = schema.properties[key]?.description;
      throw new Error(`${tool}: missing required argument "${key}"${description ? ` — ${description}` : ''}.`);
    }
  }
  for (const [key, value] of Object.entries(args)) {
    const property = schema.properties[key];
    if (property !== undefined) validateValue(tool, key, property, value);
  }
  return args;
}

/** Build a registerable tool definition with validation and rendering. */
function defineTool({ name, description, parameters, schema, render, execute, timeoutMs = 120000 }) {
  const compiled = compileParameters(parameters);
  return {
    name,
    description,
    parameters: compiled,
    output: { schema, render: (args, value) => render(args, value) },
    timeoutMs,
    async execute(rawArgs, exec) {
      return execute(validateArguments(name, compiled, rawArgs), exec);
    },
  };
}

const text = (value) => [{ type: 'text', text: value }];

/** Store a captured image through the attachment service when available. */
async function storeImage(ctx, image) {
  try {
    const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined;
    if (!attachments || typeof attachments.saveImage !== 'function') return null;
    const ref = await attachments.saveImage({ data: readFileSync(image.path), mediaType: image.mediaType, name: image.name ?? 'screenshot.png' });
    return { attachmentId: ref.attachmentId, mediaType: ref.mediaType, bytes: ref.bytes, width: ref.width, height: ref.height, name: ref.name };
  } catch {
    return null;
  }
}

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    width: { type: 'integer' },
    height: { type: 'integer' },
    name: { type: 'string' },
  },
  required: ['attachmentId', 'mediaType', 'bytes', 'width', 'height'],
};

function formatDiagnostic(entry) {
  const location = entry.file ? `${entry.file}${entry.line ? `:${entry.line}` : ''}${entry.column ? `:${entry.column}` : ''} ` : '';
  return `${location}${entry.severity}${entry.code ? ` [${entry.code}]` : ''}: ${entry.message}`;
}

/* -------------------------------------------------------------------------- */
/* Tool definitions                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Build every tool bound to one runtime.
 * @param {{ runtime: any, ctx: any }} input
 */
export function createToolDefinitions({ runtime, ctx }) {
  const requireProject = (args) => runtime.resolveProject(args.project, args.sessionId);

  return [
    defineTool({
      name: 'deveco_status',
      description:
        'Report the DevEco Studio toolchain this plugin found (IDE, HarmonyOS SDK, hvigorw, ohpm, hdc, node, java, emulator), the connected device or emulator, the resolved project, whether the app is running, and the last build. Call it first when you need to know what is available.',
      parameters: {
        project: { type: 'string', description: 'Project directory to report on (default: config projectRoot, else the session directory or its nearest project ancestor).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          tools: { type: 'object', additionalProperties: true },
          issues: { type: 'array', items: { type: 'string' } },
          device: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          project: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          running: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          message: { type: 'string' },
          versions: { type: 'object', additionalProperties: true },
          emulators: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      async execute(args) {
        runtime.attachWorkspace(runtime.sessionDirectory(args.sessionId) ?? runtime.workspace);
        const snapshot = await runtime.snapshot({ projectDir: args.project, sessionId: args.sessionId });
        const versions = await runtime.versions().catch(() => ({ hdc: '', hvigor: '' }));
        let emulators = [];
        try {
          emulators = (await runtime.emulator.list()).instances;
        } catch {
          emulators = [];
        }
        return { ...snapshot, versions, emulators, deviceError: undefined, projectError: undefined, error: undefined };
      },
      render: (args, value) => {
        const lines = ['DevEco Studio toolchain'];
        const tools = value.tools ?? {};
        lines.push(`  IDE:        ${tools.deveco || '(not found)'}${tools.devecoVersion ? ` (${tools.devecoVersion})` : ''}`);
        lines.push(`  SDK:        ${tools.sdk || '(not found)'}${value.tools.apiVersion ? `  API ${value.tools.apiVersion}${tools.platformVersion ? ` / ${tools.platformVersion}` : ''}` : ''}`);
        lines.push(`  hvigorw:    ${tools.hvigorw || '(not found)'}${value.versions?.hvigor ? `  ${value.versions.hvigor}` : ''}`);
        lines.push(`  hdc:        ${tools.hdc || '(not found)'}${value.versions?.hdc ? `  ${value.versions.hdc}` : ''}`);
        lines.push(`  node/java:  ${tools.node || '?'}  /  ${tools.java || '?'}`);
        if (value.issues?.length > 0) {
          lines.push('', 'Issues:', ...value.issues.map((issue) => `  - ${issue}`));
        }
        lines.push('');
        if (value.device) {
          const device = value.device;
          lines.push(`Device: ${device.key}${device.emulator ? ' (emulator)' : ''}  ${device.model || ''}  ${device.version || ''}${device.api ? `  API ${device.api}` : ''}`);
        } else {
          lines.push('Device: (none connected)');
        }
        if (value.project) {
          const project = value.project;
          lines.push(`Project: ${project.name}  ${project.dir}`);
          lines.push(`  bundle ${project.bundleName || '?'}  module ${project.module || '?'}  ability ${project.ability || '?'}`);
          lines.push(`  app: ${value.running ? `running (pid ${value.running})` : 'not running'}`);
        } else {
          lines.push('Project: (not found)');
        }
        if (value.lastBuild) lines.push(`Last build: ${value.lastBuild.ok ? 'ok' : 'failed'} ${value.lastBuild.errors} errors / ${value.lastBuild.warnings} warnings`);
        if (value.emulators?.length > 0) {
          lines.push('', 'Emulators:', ...value.emulators.map((emulator) => `  ${emulator.name} ${emulator.deviceType} API ${emulator.api} ${emulator.running ? '[running]' : '[stopped]'}`));
        }
        if (value.message) lines.push('', `Last message: ${value.message}`);
        return text(lines.join('\n'));
      },
    }),

    defineTool({
      name: 'deveco_project_init',
      description:
        'Create a runnable HarmonyOS Stage-model ArkTS project from the bundled API-26 template (AppScope, entry module, EntryAbility, Index page, build-profile, hvigor wrapper config). Use an empty or absent directory. Set overwrite only when you intend to replace an existing scaffold.',
      parameters: {
        directory: { type: 'string', required: true, description: 'Target project directory (created if absent; must be empty unless overwrite is true).' },
        name: { type: 'string', description: 'Project display name; defaults to the directory name.' },
        bundleName: { type: 'string', description: 'Application bundle id, e.g. com.example.demo (default com.example.<name lowercased>).' },
        module: { type: 'string', description: 'Entry module name (default entry).' },
        sdkVersion: { type: 'string', description: 'compatibleSdkVersion/targetSdkVersion, e.g. 26.0.0 (default: the discovered SDK platform version).' },
        deviceTypes: { type: 'array', items: { type: 'string' }, description: 'Device types for module.json5 (default ["phone","tablet"]).' },
        overwrite: { type: 'boolean', description: 'Overwrite existing files instead of refusing (default false).' },
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          directory: { type: 'string' },
          name: { type: 'string' },
          bundleName: { type: 'string' },
          module: { type: 'string' },
          files: { type: 'integer' },
          skipped: { type: 'integer' },
          project: { type: 'object', additionalProperties: true },
          warnings: { type: 'array', items: { type: 'string' } },
          next: { type: 'array', items: { type: 'string' } },
        },
        required: ['directory', 'files'],
      },
      async execute(args) {
        const directory = path.resolve(args.directory);
        if (existsSync(directory) && readdirSync(directory).length > 0 && args.overwrite !== true) {
          throw new Error(`directory "${directory}" is not empty; pass overwrite: true to replace its files.`);
        }
        const paths = runtime.paths();
        const platformVersion = paths.sdk.platformVersion || '26.0.0';
        const sdkVersion = args.sdkVersion || platformVersion;
        const name = args.name || path.basename(directory);
        const module = args.module || 'entry';
        const bundleName = args.bundleName || `com.example.${name.toLowerCase().replace(/[^a-z0-9]/g, '') || 'app'}`;
        const deviceTypes = Array.isArray(args.deviceTypes) && args.deviceTypes.length > 0 ? args.deviceTypes : ['phone', 'tablet'];
        const result = scaffold(path.join(templatesRoot, 'app'), directory, {
          projectName: name,
          appName: name,
          bundleName,
          moduleName: module,
          sdkVersion,
          apiVersion: paths.sdk.apiVersion || sdkVersion,
          deviceTypesJson: JSON.stringify(deviceTypes, null, 2).replace(/\n/g, '\n    '),
          modelVersion: platformVersion,
        }, { overwrite: args.overwrite === true });
        const project = runtime.resolveProject(directory);
        return {
          directory,
          name,
          bundleName,
          module,
          sdkVersion,
          files: result.written.length,
          skipped: result.skipped.length,
          project: { dir: project.dir, bundleName: project.bundleName, module: project.moduleName, ability: project.ability },
          warnings: result.skipped.length > 0 ? [`${result.skipped.length} existing files were kept; pass overwrite to replace them.`] : [],
          next: ['deveco_build to compile the HAP', 'deveco_run to install and launch it', 'deveco_ui action "screenshot" to see the result'],
        };
      },
      render: (args, value) =>
        text(
          [
            `Created HarmonyOS project at ${value.directory}`,
            `  ${value.files} files written${value.skipped > 0 ? `, ${value.skipped} kept` : ''}`,
            `  bundle ${value.bundleName}  module ${value.module}  SDK ${value.sdkVersion}`,
            ...(value.warnings ?? []).map((warning) => `  note: ${warning}`),
            '',
            ...(value.next ?? []).map((step) => `next: ${step}`),
          ].join('\n'),
        ),
    }),

    defineTool({
      name: 'deveco_build',
      description:
        'Build a HarmonyOS project with hvigorw (assembleHap by default, assembleApp for a full app package, clean to remove outputs). Injects the SDK path and DevEco Studio\'s bundled Java, then returns structured diagnostics plus the produced artifact paths.',
      parameters: {
        project: { type: 'string', description: 'Project directory (default: session directory / config projectRoot).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
        task: { type: 'string', enum: ['assembleHap', 'assembleApp', 'clean'], description: 'hvigor task (default assembleHap).' },
        module: { type: 'string', description: 'Module to build (default: the entry module).' },
        product: { type: 'string', description: 'Product name (default default).' },
        mode: { type: 'string', enum: ['debug', 'release'], description: 'Build mode (default debug).' },
        timeoutMs: { type: 'integer', description: 'Build timeout in ms (default config buildTimeoutMs, 600000).' },
      },
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          task: { type: 'string' },
          mode: { type: 'string' },
          durationMs: { type: 'integer' },
          code: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          timedOut: { type: 'boolean' },
          errors: { type: 'integer' },
          warnings: { type: 'integer' },
          diagnostics: { type: 'array', items: { type: 'object', additionalProperties: true } },
          artifacts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          outputTail: { type: 'string' },
        },
        required: ['ok'],
      },
      timeoutMs: 900000,
      async execute(args, exec) {
        const project = requireProject(args);
        runtime.attachWorkspace(project.dir);
        const result = await runtime.build({
          projectDir: project.dir,
          task: args.task ?? 'assembleHap',
          module: args.module ?? project.moduleName,
          product: args.product,
          mode: args.mode,
          timeoutMs: args.timeoutMs,
          signal: exec?.signal,
        });
        return {
          ok: result.ok,
          task: result.task,
          mode: result.mode,
          durationMs: result.durationMs,
          code: result.code,
          timedOut: result.timedOut,
          errors: result.errors,
          warnings: result.warnings,
          diagnostics: result.diagnostics,
          artifacts: result.artifacts,
          outputTail: result.output.slice(-4000),
        };
      },
      render: (args, value) => {
        const lines = [
          `${value.ok ? 'Build succeeded' : 'Build failed'}: ${value.task} (${value.mode}) in ${(value.durationMs / 1000).toFixed(1)}s`,
          `${value.errors} errors, ${value.warnings} warnings${value.timedOut ? ', timed out' : ''}`,
        ];
        if (value.diagnostics?.length > 0) {
          lines.push('', ...value.diagnostics.slice(0, 30).map((entry) => `  ${formatDiagnostic(entry)}`));
        }
        if (value.artifacts?.length > 0) {
          lines.push('', 'Artifacts:', ...value.artifacts.slice(0, 5).map((artifact) => `  ${artifact.path} (${Math.round((artifact.bytes ?? 0) / 1024)} KiB)`));
        }
        if (!value.ok) lines.push('', 'Output tail:', value.outputTail?.slice(-1500) ?? '');
        return text(lines.join('\n'));
      },
    }),

    defineTool({
      name: 'deveco_device',
      description:
        'List attached HarmonyOS devices and local emulator instances, start or stop an emulator, or capture the emulator\'s screen. Device keys are hdc connect keys such as 127.0.0.1:5555.',
      parameters: {
        action: {
          type: 'string',
          required: true,
          enum: ['list', 'info', 'emulator_start', 'emulator_stop', 'emulator_screenshot'],
          description: 'list | info | emulator_start | emulator_stop | emulator_screenshot',
        },
        name: { type: 'string', description: 'Emulator instance name (required for the emulator_* actions).' },
        device: { type: 'string', description: 'Device key for info (default: the only attached device).' },
        noWindow: { type: 'boolean', description: 'Start the emulator without its window (default false).' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          targets: { type: 'array', items: { type: 'object', additionalProperties: true } },
          emulators: { type: 'array', items: { type: 'object', additionalProperties: true } },
          device: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          started: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          screenshot: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          message: { type: 'string' },
        },
        required: ['action'],
      },
      timeoutMs: 300000,
      async execute(args) {
        const paths = runtime.paths();
        if (args.action === 'list' || args.action === 'info') {
          const targets = (await runtime.device.list()).targets;
          let emulators = [];
          try {
            emulators = (await runtime.emulator.list()).instances;
          } catch {
            emulators = [];
          }
          let device = null;
          if (args.action === 'info' || args.device) {
            device = await runtime.device.info(await runtime.device.select(args.device));
          }
          return { action: args.action, targets, emulators, device, message: `${targets.filter((target) => target.usable).length} usable device(s), ${emulators.length} emulator instance(s)` };
        }
        if (!args.name) throw new Error(`deveco_device ${args.action} requires the emulator instance name (see action "list").`);
        if (args.action === 'emulator_start') {
          const started = await runtime.emulator.start(args.name, { noWindow: args.noWindow === true });
          return { action: args.action, started, message: started.running ? `emulator ${args.name} is running` : `emulator ${args.name} did not start: ${started.hint ?? ''}` };
        }
        if (args.action === 'emulator_stop') {
          const stopped = await runtime.emulator.stop(args.name);
          return { action: args.action, started: null, message: stopped.ok ? `emulator ${args.name} stopped` : `stop failed: ${stopped.output}` };
        }
        const file = path.join(runtime.shotsDir(), `emulator-${Date.now()}.png`);
        const screenshot = await runtime.emulator.screenshot(args.name, file);
        const image = screenshot.ok ? await storeImage(ctx, { path: file, mediaType: 'image/png', name: path.basename(file) }) : null;
        return { action: args.action, screenshot: { ...screenshot, image, width: 0, height: 0 }, message: screenshot.ok ? `captured ${file}` : `capture failed: ${screenshot.output}` };
      },
      render: (args, value) => {
        if (value.action === 'list' || value.action === 'info') {
          const lines = ['Attached devices:'];
          if (!value.targets || value.targets.length === 0) lines.push('  (none)');
          for (const target of value.targets ?? []) {
            lines.push(`  ${target.key}  ${target.type}  ${target.state}${target.usable ? '' : '  (unusable)'}`);
          }
          lines.push('', 'Emulator instances:');
          if (!value.emulators || value.emulators.length === 0) lines.push('  (none)');
          for (const emulator of value.emulators ?? []) {
            lines.push(`  ${emulator.name}  ${emulator.deviceType}  API ${emulator.api}  ${emulator.running ? 'running' : 'stopped'}`);
          }
          if (value.device) {
            lines.push('', `Device ${value.device.key}: ${value.device.model} ${value.device.version} API ${value.device.api}${value.device.emulator ? ' (emulator)' : ''}`);
          }
          return text(lines.join('\n'));
        }
        if (value.screenshot?.ok) {
          const blocks = [
            { type: 'text', text: `${value.message}\nfile: ${value.screenshot.file}` },
            ...(value.screenshot.image ? [{ type: 'image', attachment: value.screenshot.image }] : []),
          ];
          return blocks;
        }
        return text(value.message ?? 'done');
      },
    }),

    defineTool({
      name: 'deveco_install',
      description:
        'Install the newest built HAP (or an explicit hap path) on a device, replacing an existing installation, or uninstall a bundle. Reports signature failures with the DevEco Studio signing remedy.',
      parameters: {
        project: { type: 'string', description: 'Project directory (default: session/resolved project).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
        hap: { type: 'string', description: 'Explicit .hap path (default: newest artifact under entry/build).' },
        device: { type: 'string', description: 'Device key (default: the only attached device).' },
        uninstall: { type: 'boolean', description: 'Uninstall the project bundle instead of installing.' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          device: { type: 'object', additionalProperties: true },
          bundleName: { type: 'string' },
          hap: { type: 'string' },
          bytes: { type: 'integer' },
          output: { type: 'string' },
          hint: { type: 'string' },
        },
        required: ['ok'],
      },
      timeoutMs: 300000,
      async execute(args) {
        const project = requireProject(args);
        runtime.attachWorkspace(project.dir);
        const device = await runtime.device.select(args.device);
        if (args.uninstall === true) {
          const result = await runtime.device.uninstall(project.bundleName, device);
          return { ok: result.ok, device, bundleName: project.bundleName, output: result.output };
        }
        const artifact = runtime.pickArtifact(project.dir, args.hap);
        const result = await runtime.device.install(artifact.path, device);
        const needSigning = !result.ok && /signature|sign/i.test(result.output);
        return {
          ok: result.ok,
          device,
          bundleName: project.bundleName,
          hap: artifact.path,
          bytes: artifact.bytes,
          output: result.output,
          hint: needSigning
            ? 'The device rejected the HAP signature. Open the project in DevEco Studio → Project Structure → Signing Configs and enable automatic signing, then rebuild; emulators usually accept unsigned HAPs.'
            : '',
        };
      },
      render: (args, value) =>
        text(
          [
            `${value.ok ? 'Installed' : 'Install failed'} ${value.bundleName} on ${value.device?.key ?? '?'}`,
            value.hap ? `  hap: ${value.hap}` : '',
            value.output ? `  ${value.output}` : '',
            value.hint ? `  hint: ${value.hint}` : '',
          ]
            .filter((line) => line !== '')
            .join('\n'),
        ),
    }),

    defineTool({
      name: 'deveco_run',
      description:
        'Build (optional), install and launch a HarmonyOS app on the selected device, then report the PID and a hilog tail. Use build: true for a one-shot rebuild, debug: true to start paused for a debugger, and captureMs to collect logs for a while after launch.',
      parameters: {
        project: { type: 'string', description: 'Project directory (default: session/resolved project).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
        device: { type: 'string', description: 'Device key (default: the only attached device).' },
        ability: { type: 'string', description: 'Ability to start (default: the module mainElement).' },
        build: { type: 'boolean', description: 'Build before installing (default false).' },
        install: { type: 'boolean', description: 'Install before launching (default true).' },
        debug: { type: 'boolean', description: 'Start in debug-wait mode instead of a normal launch (default false).' },
        captureMs: { type: 'integer', description: 'Wait this long after launch, then attach a hilog tail (default 0).' },
        logLines: { type: 'integer', description: 'Hilog lines to return when captureMs > 0 (default 80).' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean' },
          stage: { type: 'string' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          device: { type: 'object', additionalProperties: true },
          project: { type: 'object', additionalProperties: true },
          steps: { type: 'array', items: { type: 'object', additionalProperties: true } },
          diagnostics: { type: 'array', items: { type: 'object', additionalProperties: true } },
          logs: { type: 'array', items: { type: 'string' } },
          output: { type: 'string' },
          next: { type: 'array', items: { type: 'string' } },
        },
        required: ['ok'],
      },
      timeoutMs: 900000,
      async execute(args, exec) {
        const project = requireProject(args);
        runtime.attachWorkspace(project.dir);
        const device = await runtime.device.select(args.device);
        const result = await runtime.run({
          project,
          device,
          ability: args.ability,
          build: args.build === true,
          install: args.install !== false,
          debug: args.debug === true,
          mode: 'debug',
          signal: exec?.signal,
        });
        let logs = [];
        if (args.captureMs !== undefined && args.captureMs > 0 && result.pid !== null) {
          await new Promise((resolve) => setTimeout(resolve, Math.min(600000, args.captureMs)));
          const snapshot = await runtime.logSnapshot(device, result.pid, args.logLines ?? 80);
          logs = snapshot.lines;
        }
        return { ...result, logs };
      },
      render: (args, value) => {
        const lines = [];
        if (value.ok) {
          lines.push(`Running ${value.project?.bundleName ?? ''} on ${value.device?.key ?? '?'} (pid ${value.pid ?? '?'})`);
        } else {
          lines.push(`Run failed at stage "${value.stage ?? 'unknown'}"`);
        }
        for (const step of value.steps ?? []) lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'} ${step.step}${step.detail ? ` — ${step.detail}` : ''}`);
        if (value.diagnostics?.length > 0) {
          lines.push('', ...value.diagnostics.slice(0, 20).map((entry) => `  ${formatDiagnostic(entry)}`));
        }
        if (value.output) lines.push('', value.output.slice(0, 1500));
        if (value.logs?.length > 0) {
          lines.push('', 'hilog tail:', ...value.logs.slice(-40));
        }
        if (value.next?.length > 0) lines.push('', ...value.next.map((entry) => `next: ${entry}`));
        return text(lines.join('\n'));
      },
    }),

    defineTool({
      name: 'deveco_log',
      description:
        'Read hilog from a device. action "start" opens a live capture session (filters: tag, level, pid, keyword), "read" returns new lines since the previous read, "stop" closes it, "list" shows sessions, and "crash" returns the newest entries from the device fault log.',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'read', 'stop', 'list', 'crash'], description: 'start | read | stop | list | crash' },
        sessionId: { type: 'string', description: 'Log session id (read/stop).' },
        device: { type: 'string', description: 'Device key (default: the only attached device).' },
        tag: { type: 'string', description: 'hilog tag filter (start).' },
        level: { type: 'string', enum: ['D', 'I', 'W', 'E', 'F'], description: 'Minimum log level (start).' },
        pid: { type: 'integer', description: 'Process id filter (start).' },
        keyword: { type: 'string', description: 'Only keep lines containing this text, case-insensitive (start).' },
        lines: { type: 'integer', description: 'Maximum lines to return for read/crash (default 200 / 3 files).' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          session: { oneOf: [{ type: 'object', additionalProperties: true }, { type: 'null' }] },
          sessions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          entries: { type: 'array', items: { type: 'object', additionalProperties: true } },
          text: { type: 'string' },
          records: { type: 'array', items: { type: 'object', additionalProperties: true } },
          note: { type: 'string' },
        },
        required: ['action'],
      },
      timeoutMs: 120000,
      async execute(args) {
        if (args.action === 'list') return { action: 'list', sessions: runtime.log.list() };
        if (args.action === 'stop') {
          if (!args.sessionId) throw new Error('deveco_log action "stop" requires sessionId.');
          return { action: 'stop', note: JSON.stringify(runtime.log.stop(args.sessionId)) };
        }
        if (args.action === 'crash') {
          const device = await runtime.device.select(args.device);
          const result = await runtime.log.crashes(runtime.device, device, args.lines ?? 3);
          return { action: 'crash', ...result };
        }
        if (args.action === 'start') {
          const device = await runtime.device.select(args.device);
          const session = await runtime.log.start({
            device: device.key,
            tag: args.tag,
            level: args.level,
            pid: args.pid,
            keyword: args.keyword,
          });
          return { action: 'start', session };
        }
        if (!args.sessionId) throw new Error('deveco_log action "read" requires sessionId (call action "start" first).');
        const read = runtime.log.read(args.sessionId, args.lines ?? 200);
        return { action: 'read', ...read };
      },
      render: (args, value) => {
        if (value.action === 'list') {
          const sessions = value.sessions ?? [];
          return text(sessions.length === 0 ? 'No log sessions.' : ['Log sessions:', ...sessions.map((session) => `  ${session.id} ${session.device} ${session.lines} lines${session.running ? '' : ' (closed)'}`)].join('\n'));
        }
        if (value.action === 'start') {
          return text(`Log capture started: ${value.session?.id} on ${value.session?.device}${value.session?.tag ? ` tag ${value.session.tag}` : ''}. Read it with deveco_log action "read".`);
        }
        if (value.action === 'crash') {
          const lines = [value.note || 'Fault log records:'];
          for (const record of value.records ?? []) {
            lines.push('', `--- ${record.file} ---`, record.text.slice(0, 4000));
          }
          return text(lines.join('\n'));
        }
        if (value.action === 'stop') return text(value.note ?? 'stopped');
        const entries = value.entries ?? [];
        if (entries.length === 0) return text(`No new log lines (session ${value.id ?? ''}).`);
        const lines = entries.map((entry) => `${entry.time} ${entry.levelChar ?? entry.level} ${entry.pid}/${entry.tid} ${entry.tag}: ${entry.message}`);
        return text([`${entries.length} new lines (session ${value.id ?? ''})`, ...lines].join('\n'));
      },
    }),

    defineTool({
      name: 'deveco_ui',
      description:
        'Observe and drive the app UI on the device: "screenshot" returns the screen as an image, "layout" returns the visible node tree with tap coordinates, and tap/swipe/text/key inject input through uitest.',
      parameters: {
        action: { type: 'string', required: true, enum: ['screenshot', 'layout', 'tap', 'swipe', 'text', 'key'], description: 'screenshot | layout | tap | swipe | text | key' },
        device: { type: 'string', description: 'Device key (default: the only attached device).' },
        x: { type: 'integer', description: 'Tap x, or swipe start x.' },
        y: { type: 'integer', description: 'Tap y, or swipe start y.' },
        toX: { type: 'integer', description: 'Swipe end x.' },
        toY: { type: 'integer', description: 'Swipe end y.' },
        velocity: { type: 'integer', description: 'Swipe velocity 200..40000.' },
        text: { type: 'string', description: 'Text to type.' },
        key: { type: 'string', description: 'Key name: Back | Home | Power | numeric key code.' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          file: { type: 'string' },
          width: { type: 'integer' },
          height: { type: 'integer' },
          bytes: { type: 'integer' },
          image: { oneOf: [IMAGE_SCHEMA, { type: 'null' }] },
          screen: { type: 'object', additionalProperties: true },
          nodes: { type: 'array', items: { type: 'object', additionalProperties: true } },
          count: { type: 'integer' },
          output: { type: 'string' },
        },
        required: ['action'],
      },
      timeoutMs: 180000,
      async execute(args) {
        if (args.action === 'tap' && (!Number.isFinite(args.x) || !Number.isFinite(args.y))) throw new Error('deveco_ui tap requires x and y.');
        if (args.action === 'swipe' && ![args.x, args.y, args.toX, args.toY].every((value) => Number.isFinite(value))) {
          throw new Error('deveco_ui swipe requires x, y, toX and toY.');
        }
        if (args.action === 'text' && typeof args.text !== 'string') throw new Error('deveco_ui text requires text.');
        if (args.action === 'key' && !args.key) throw new Error('deveco_ui key requires key (Back | Home | Power | key code).');
        const device = await runtime.device.select(args.device);
        if (args.action === 'screenshot') {
          const capture = await runtime.ui.screenshot(device, runtime.shotsDir());
          const image = await storeImage(ctx, { path: capture.file, mediaType: capture.mediaType, name: path.basename(capture.file) });
          return { action: 'screenshot', ...capture, image };
        }
        if (args.action === 'layout') {
          const result = await runtime.ui.layout(device);
          return { action: 'layout', ...result };
        }
        if (args.action === 'tap') {
          return { action: 'tap', output: JSON.stringify(await runtime.ui.tap(device, args.x, args.y)) };
        }
        if (args.action === 'swipe') {
          return { action: 'swipe', output: JSON.stringify(await runtime.ui.swipe(device, args.x, args.y, args.toX, args.toY, args.velocity)) };
        }
        if (args.action === 'text') {
          if (typeof args.text !== 'string') throw new Error('deveco_ui text requires text.');
          const point = Number.isFinite(args.x) && Number.isFinite(args.y) ? { x: args.x, y: args.y } : undefined;
          return { action: 'text', output: JSON.stringify(await runtime.ui.inputText(device, args.text, point)) };
        }
        if (!args.key) throw new Error('deveco_ui key requires key (Back | Home | Power | key code).');
        return { action: 'key', output: JSON.stringify(await runtime.ui.key(device, args.key)) };
      },
      render: (args, value) => {
        if (value.action === 'screenshot') {
          const blocks = [{ type: 'text', text: `screen ${value.width}x${value.height} on ${value.device ?? ''}\nfile: ${value.file}` }];
          if (value.image) blocks.push({ type: 'image', attachment: value.image });
          return blocks;
        }
        if (value.action === 'layout') {
          const nodes = (value.nodes ?? []).slice(0, 60);
          const lines = [`layout ${value.screen?.width ?? 0}x${value.screen?.height ?? 0}, ${value.count ?? nodes.length} nodes`];
          for (const node of nodes) {
            const label = node.text !== '' ? `"${node.text}"` : node.id;
            lines.push(`  ${node.type}${node.clickable ? ' [tap]' : ''} ${label} @ ${node.center.x},${node.center.y} (${node.bounds.width}x${node.bounds.height})`);
          }
          return text(lines.join('\n'));
        }
        return text(value.output ?? 'done');
      },
    }),

    defineTool({
      name: 'deveco_debug',
      description:
        'Control the on-device debug lifecycle of the app: "start" launches it paused in debug-wait mode, "attach"/"detach" toggle the debugger marker, "status" reports pid and debug transport state, "cancel" leaves debug mode, "probe" forwards the ArkTS debug transport and reports whether a plain CDP WebSocket endpoint answers, and "open" hands the project to DevEco Studio for breakpoint stepping.',
      parameters: {
        action: { type: 'string', required: true, enum: ['start', 'attach', 'detach', 'status', 'cancel', 'probe', 'open'], description: 'start | attach | detach | status | cancel | probe | open' },
        project: { type: 'string', description: 'Project directory (default: session/resolved project).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
        device: { type: 'string', description: 'Device key (default: the only attached device).' },
        ability: { type: 'string', description: 'Ability to start (default: module mainElement).' },
        persist: { type: 'boolean', description: 'Keep wait-for-debugger across process restarts (aa appdebug -p).' },
        port: { type: 'integer', description: 'First local port used by probe (default 9330).' },
        file: { type: 'string', description: 'File to reveal when action is "open".' },
        line: { type: 'integer', description: 'Line to reveal when action is "open".' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          action: { type: 'string' },
          ok: { type: 'boolean' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          waiting: { type: 'boolean' },
          status: { type: 'object', additionalProperties: true },
          attempts: { type: 'array', items: { type: 'object', additionalProperties: true } },
          compatible: { type: 'boolean' },
          output: { type: 'string' },
          next: { type: 'array', items: { type: 'string' } },
          opened: { type: 'object', additionalProperties: true },
        },
        required: ['action'],
      },
      timeoutMs: 300000,
      async execute(args) {
        const project = requireProject(args);
        runtime.attachWorkspace(project.dir);
        const device = await runtime.device.select(args.device);
        if (args.action === 'start') {
          return { action: 'start', ...(await runtime.debug.start(device, { bundleName: project.bundleName, ability: args.ability ?? project.ability, moduleName: project.moduleName, persist: args.persist === true })) };
        }
        if (args.action === 'attach') return { action: 'attach', ...(await runtime.debug.attach(device, project.bundleName, true)) };
        if (args.action === 'detach') return { action: 'detach', ...(await runtime.debug.attach(device, project.bundleName, false)) };
        if (args.action === 'status') return { action: 'status', status: await runtime.debug.status(device, project.bundleName) };
        if (args.action === 'cancel') return { action: 'cancel', ...(await runtime.debug.cancel(device, project.bundleName)) };
        if (args.action === 'probe') return { action: 'probe', ...(await runtime.debug.probe(device, project.bundleName, args.port ?? 9330)) };
        const opened = await runtime.ide.open({ projectDir: project.dir, file: args.file, line: args.line });
        return { action: 'open', opened };
      },
      render: (args, value) => {
        if (value.action === 'start') {
          const lines = [value.ok ? `Debug-wait started (pid ${value.pid})` : `Debug start failed at stage "${value.stage ?? '?'}"`];
          if (value.output) lines.push(value.output.slice(0, 800));
          for (const entry of value.next ?? []) lines.push(`next: ${entry}`);
          return text(lines.join('\n'));
        }
        if (value.action === 'status') {
          const status = value.status ?? {};
          return text(`debug status: pid ${status.pid ?? '-'}, transport ${status.inDebugTransport ? 'present' : 'absent'}, appdebug ${status.appDebug || '-'}`);
        }
        if (value.action === 'probe') {
          const lines = [value.compatible ? 'CDP endpoint reachable.' : 'CDP endpoint not reachable.'];
          for (const attempt of value.attempts ?? []) lines.push(`  ${attempt.task} : ${attempt.accepted ? 'accepted' : attempt.response ?? 'no response'}`);
          if (value.hint) lines.push('', value.hint);
          return text(lines.join('\n'));
        }
        if (value.action === 'open') {
          return text(`DevEco Studio launched (pid ${value.opened?.pid ?? '?'})${value.opened?.alreadyRunning ? ', forwarded to the running instance' : ''}`);
        }
        return text(value.output ?? `${value.action} ok`);
      },
    }),

    defineTool({
      name: 'deveco_open',
      description:
        'Open the project (or one file at a line) in DevEco Studio itself, for the IDE\'s editor, previewer and breakpoint debugger.',
      parameters: {
        project: { type: 'string', description: 'Project directory (default: session/resolved project).' },
        sessionId: { type: 'string', description: 'Session id used to resolve the session working directory.' },
        file: { type: 'string', description: 'File to reveal after opening the project.' },
        line: { type: 'integer', description: 'Line to reveal (with file).' },
      },
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          launched: { type: 'boolean' },
          pid: { oneOf: [{ type: 'integer' }, { type: 'null' }] },
          alreadyRunning: { type: 'boolean' },
          executable: { type: 'string' },
          arguments: { type: 'array', items: { type: 'string' } },
        },
        required: ['launched'],
      },
      timeoutMs: 60000,
      async execute(args) {
        const project = requireProject(args);
        runtime.attachWorkspace(project.dir);
        return runtime.ide.open({ projectDir: project.dir, file: args.file, line: args.line });
      },
      render: (args, value) =>
        text(
          [
            `DevEco Studio launched${value.pid ? ` (pid ${value.pid})` : ''}${value.alreadyRunning ? '; forwarded to the running instance' : ''}`,
            `  ${value.executable} ${(value.arguments ?? []).join(' ')}`,
          ].join('\n'),
        ),
    }),
  ];
}
