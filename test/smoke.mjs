import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

import { createRuntime } from '../src/runtime.js';
import { parseTargets } from '../src/device.js';
import { parseBuildOutput } from '../src/build.js';
import { flattenLayout, parseBounds } from '../src/ui.js';
import { parseJson5 } from '../src/project.js';
import { parseHilogLine } from '../src/log.js';
import { createToolDefinitions } from '../src/tools.js';

const runtime = createRuntime({ devecoPath: 'D:\\Software\\DevEco Studio' });
const paths = runtime.paths();
assert.ok(paths.deveco, 'DevEco Studio should be discovered');
assert.ok(paths.sdkRoot, 'SDK should be discovered');
assert.ok(paths.tools.hdc, 'hdc should be discovered');
assert.ok(paths.tools.hvigorw, 'hvigorw should be discovered');

const targets = parseTargets('127.0.0.1:5555\tTCP\tConnected\tlocalhost\thdc\nCOM1\tUART\tReady\tunknown\thdc\n');
assert.equal(targets.length, 2);
assert.equal(targets[0].usable, true);
assert.equal(targets[1].usable, false);

const parsed = parseBuildOutput(
  [
    '> hvigor ERROR: Failed :entry:default@CompileArkTS...',
    'ERROR: 10605001 ArkTS Compiler Error',
    'Error Message: Cannot find name "foo".',
    'D:/proj/entry/src/main/ets/pages/Index.ets:12:9 - error TS2304: Cannot find name \'x\'.',
    'WARN: Will skip sign \'hos_hap\'. No signingConfigs profile is configured in current project.',
    '> hvigor BUILD FAILED in 3 s',
  ].join('\n'),
  'D:/proj',
);
assert.ok(parsed.diagnostics.length >= 2, 'diagnostics are parsed');
assert.ok(parsed.diagnostics.some((entry) => entry.file === 'entry/src/main/ets/pages/Index.ets' && entry.line === 12));
assert.ok(parsed.diagnostics.some((entry) => entry.code === 'SIGNING'));
assert.equal(parsed.successful, false);

const bounds = parseBounds('[10,20][110,220]');
assert.deepEqual({ x: bounds.centerX, y: bounds.centerY }, { x: 60, y: 120 });
const flat = flattenLayout({
  attributes: { bounds: '[0,0][1280,2832]' },
  children: [{ attributes: { bounds: '[0,0][200,100]', text: 'Tap me', clickable: 'true', type: 'Button', visible: 'true', id: 'tap' }, children: [] }],
});
assert.equal(flat.screen.width, 1280);
assert.equal(flat.nodes.length, 1);
assert.equal(flat.nodes[0].text, 'Tap me');

const json5 = parseJson5(`{
  // comment
  app: {
    'bundleName': "com.example.app",
    "products": [ { "name": "default", }, ],
  },
}`);
assert.equal(json5.app.bundleName, 'com.example.app');
assert.equal(json5.app.products[0].name, 'default');

const line = parseHilogLine('11-05 13:18:15.722   559   563 W C02515/DISP: [SetLayerMaskInfo:495] hello');
assert.equal(line.level, 'warn');
assert.equal(line.tag, 'DISP');

const tools = createToolDefinitions({ runtime, ctx: { get: () => undefined } });
assert.equal(tools.length, 10);
assert.deepEqual(tools.map((tool) => tool.name).sort(), [
  'deveco_build',
  'deveco_debug',
  'deveco_device',
  'deveco_install',
  'deveco_log',
  'deveco_open',
  'deveco_project_init',
  'deveco_run',
  'deveco_status',
  'deveco_ui',
]);
for (const tool of tools) {
  assert.equal(tool.parameters.type, 'object');
  assert.ok(tool.description.length > 40, `${tool.name} has a description`);
}

// The profile loader parses package.json as strict JSON and resolves locale and
// icon resources through `exports`; a UTF-8 BOM here marks the bundle unusable.
const manifestBytes = readFileSync(new URL('../package.json', import.meta.url));
assert.notDeepEqual([...manifestBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'package.json must not start with a BOM');
const manifest = JSON.parse(manifestBytes.toString('utf8'));
assert.equal(manifest.dsh.bundle.patch, './cordis.patch.yml');
assert.equal(manifest.exports['./locale/*.json'], './locale/*.json');
for (const file of ['locale/en.json', 'locale/zh.json', 'icon.svg', 'client.js', 'index.js']) {
  assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), `${file} exists`);
}
for (const subpath of ['./icon', './client', '.']) {
  assert.ok(manifest.exports[subpath], `package.json exports ${subpath}`);
}
JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8'));
JSON.parse(readFileSync(new URL('../locale/zh.json', import.meta.url), 'utf8'));

console.log(JSON.stringify({ discovered: { deveco: paths.deveco.path, sdk: paths.sdkRoot, hdc: paths.tools.hdc, hvigorw: paths.tools.hvigorw }, tools: tools.length }, null, 2));
console.log('smoke: ok');
