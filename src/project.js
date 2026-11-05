/**
 * HarmonyOS project model: a tolerant JSON5 reader, the metadata the tools
 * report, HAP artifact discovery, and the template scaffolding used by
 * `deveco_project_init`.
 *
 * @module @local/dsh-deveco/project
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Parse the JSON5 dialect DevEco writes: comments, trailing commas, unquoted
 * keys, single-quoted strings. Implemented as a scanner so string contents are
 * never rewritten, then delegated to JSON.parse.
 *
 * @param {string} source
 * @returns {any}
 */
export function parseJson5(source) {
  let out = '';
  let index = 0;
  const length = source.length;
  let quote = null;
  let lastMeaningful = '';

  const emit = (character) => {
    out += character;
    if (!/\s/.test(character)) lastMeaningful = character;
  };

  while (index < length) {
    const character = source[index];
    if (quote !== null) {
      if (character === '\\') {
        out += character + (source[index + 1] ?? '');
        index += 2;
        continue;
      }
      if (character === quote) {
        out += quote === "'" ? '"' : character;
        quote = null;
        index += 1;
        continue;
      }
    }
    if (character === '"' || character === "'") {
      quote = character;
      out += character === "'" ? '"' : character;
      index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '/') {
      while (index < length && source[index] !== '\n') index += 1;
      continue;
    }
    if (character === '/' && source[index + 1] === '*') {
      index += 2;
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) index += 1;
      index += 2;
      continue;
    }
    if (character === ',') {
      // Drop a trailing comma: the next meaningful character closes the node.
      let probe = index + 1;
      while (probe < length) {
        const next = source[probe];
        if (/\s/.test(next)) {
          probe += 1;
          continue;
        }
        if (next === '/' && source[probe + 1] === '/') {
          while (probe < length && source[probe] !== '\n') probe += 1;
          continue;
        }
        if (next === '/' && source[probe + 1] === '*') {
          probe += 2;
          while (probe < length && !(source[probe] === '*' && source[probe + 1] === '/')) probe += 1;
          probe += 2;
          continue;
        }
        break;
      }
      const closing = source[probe];
      if (closing === '}' || closing === ']') {
        index += 1;
        continue;
      }
      emit(',');
      index += 1;
      continue;
    }
    if (/[A-Za-z_$]/.test(character) && (lastMeaningful === '{' || lastMeaningful === ',')) {
      // Unquoted object key: read the identifier and quote it.
      let end = index;
      while (end < length && /[A-Za-z0-9_$]/.test(source[end])) end += 1;
      let probe = end;
      while (probe < length && /\s/.test(source[probe])) probe += 1;
      if (source[probe] === ':') {
        out += `"${source.slice(index, end)}"`;
        index = end;
        continue;
      }
    }
    if (character === "'") {
      // Already handled above; kept for clarity.
      index += 1;
      continue;
    }
    emit(character);
    index += 1;
  }
  return JSON.parse(out);
}

/** Read a JSON5 file, returning null when missing or malformed. */
export function readJson5(file) {
  try {
    return parseJson5(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/** Read the application id from AppScope/app.json5. */
export function readBundleName(projectDir) {
  const app = readJson5(path.join(projectDir, 'AppScope', 'app.json5'));
  return typeof app?.app?.bundleName === 'string' ? app.app.bundleName : '';
}

/** Read the module descriptors of a project. */
export function readModules(projectDir) {
  const profile = readJson5(path.join(projectDir, 'build-profile.json5'));
  const modules = [];
  for (const entry of Array.isArray(profile?.modules) ? profile.modules : []) {
    const name = typeof entry?.name === 'string' ? entry.name : '';
    if (name === '') continue;
    const srcPath = typeof entry?.srcPath === 'string' ? entry.srcPath : `./${name}`;
    const moduleDir = path.resolve(projectDir, srcPath);
    const descriptor = readJson5(path.join(moduleDir, 'src', 'main', 'module.json5'))?.module ?? {};
    const abilities = Array.isArray(descriptor.abilities)
      ? descriptor.abilities.map((ability) => ({
          name: String(ability?.name ?? ''),
          srcEntry: String(ability?.srcEntry ?? ''),
          exported: ability?.exported === true,
        }))
      : [];
    modules.push({
      name,
      dir: moduleDir,
      type: typeof descriptor.type === 'string' ? descriptor.type : '',
      mainElement: typeof descriptor.mainElement === 'string' ? descriptor.mainElement : abilities[0]?.name ?? '',
      deviceTypes: Array.isArray(descriptor.deviceTypes) ? descriptor.deviceTypes.map(String) : [],
      abilities,
    });
  }
  if (modules.length === 0) {
    const fallback = path.join(projectDir, 'entry');
    if (existsSync(path.join(fallback, 'src', 'main', 'module.json5'))) {
      const descriptor = readJson5(path.join(fallback, 'src', 'main', 'module.json5'))?.module ?? {};
      modules.push({
        name: 'entry',
        dir: fallback,
        type: typeof descriptor.type === 'string' ? descriptor.type : 'entry',
        mainElement: typeof descriptor.mainElement === 'string' ? descriptor.mainElement : '',
        deviceTypes: Array.isArray(descriptor.deviceTypes) ? descriptor.deviceTypes.map(String) : [],
        abilities: Array.isArray(descriptor.abilities)
          ? descriptor.abilities.map((ability) => ({ name: String(ability?.name ?? ''), srcEntry: '', exported: ability?.exported === true }))
          : [],
      });
    }
  }
  return modules;
}

/** Read the product/signing summary of a project. */
export function readProducts(projectDir) {
  const profile = readJson5(path.join(projectDir, 'build-profile.json5'));
  const app = profile?.app ?? {};
  const products = Array.isArray(app.products) ? app.products : [];
  const signingConfigs = Array.isArray(app.signingConfigs) ? app.signingConfigs : [];
  return {
    products: products.map((product) => ({
      name: String(product?.name ?? ''),
      runtimeOS: String(product?.runtimeOS ?? ''),
      compatibleSdkVersion: String(product?.compatibleSdkVersion ?? product?.compatibleSdkVersion ?? ''),
      targetSdkVersion: String(product?.targetSdkVersion ?? ''),
      signingConfig: String(product?.signingConfig ?? ''),
    })),
    signingConfigs: signingConfigs.map((config) => ({
      name: String(config?.name ?? ''),
      type: String(config?.type ?? ''),
      hasMaterial: Boolean(config?.material && typeof config.material === 'object' && Object.keys(config.material).length > 0),
      keyAlias: String(config?.material?.keyAlias ?? ''),
    })),
    modelVersion: String(profile?.app?.modelVersion ?? ''),
  };
}

/** List HAP/APP artifacts under a project, newest first. */
export function findArtifacts(projectDir, kind = 'hap') {
  const results = [];
  const pattern = kind === 'app' ? /\.app$/i : /\.hap$/i;
  const walk = (directory, depth) => {
    if (depth > 6) return;
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (/^(node_modules|oh_modules|\.git|\.idea|\.preview)$/i.test(entry.name)) continue;
        walk(full, depth + 1);
      } else if (pattern.test(entry.name)) {
        try {
          const info = statSync(full);
          results.push({ path: full, bytes: info.size, mtimeMs: info.mtimeMs, name: entry.name });
        } catch {
          /* vanished between readdir and stat */
        }
      }
    }
  };
  walk(path.join(projectDir, 'entry', 'build'), 0);
  walk(path.join(projectDir, 'build'), 0);
  results.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return results;
}

/** Read a small summary of the project for status output. */
export function describeProject(projectDir) {
  const modules = readModules(projectDir);
  const products = readProducts(projectDir);
  return {
    dir: projectDir,
    name: path.basename(projectDir),
    bundleName: readBundleName(projectDir),
    modules: modules.map((module) => ({
      name: module.name,
      type: module.type,
      mainElement: module.mainElement,
      deviceTypes: module.deviceTypes,
    })),
    products: products.products,
    signingConfigs: products.signingConfigs,
  };
}

/* -------------------------------------------------------------------------- */
/* Scaffolding                                                                */
/* -------------------------------------------------------------------------- */

/** Render `{{key}}` placeholders in a template text file. */
function renderTemplate(text, values) {
  return text.replace(/\{\{([A-Za-z0-9_]+)\}\}/g, (match, key) => (key in values ? String(values[key]) : match));
}

/** Files that must stay byte-identical (images and other binary assets). */
const BINARY_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.so', '.ttf', '.hap', '.p12', '.cer', '.p7b']);

/**
 * Copy a template tree into a project directory, rendering placeholders in
 * text files. Existing files are kept unless `overwrite` is true.
 *
 * @param {string} templateDir
 * @param {string} destination
 * @param {Record<string, string>} values
 * @param {{ overwrite?: boolean }} [options]
 * @returns {{ written: string[], skipped: string[] }}
 */
export function scaffold(templateDir, destination, values, options = {}) {
  const written = [];
  const skipped = [];
  const walk = (source, target) => {
    mkdirSync(target, { recursive: true });
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      const from = path.join(source, entry.name);
      const to = path.join(target, entry.name);
      if (entry.isDirectory()) {
        walk(from, to);
        continue;
      }
      if (existsSync(to) && options.overwrite !== true) {
        skipped.push(to);
        continue;
      }
      if (BINARY_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        cpSync(from, to);
      } else {
        writeFileSync(to, renderTemplate(readFileSync(from, 'utf8'), values));
      }
      written.push(to);
    }
  };
  walk(templateDir, destination);
  return { written, skipped };
}
