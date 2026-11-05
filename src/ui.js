/**
 * On-device UI observation and input: screenshots through snapshot_display,
 * layout dumps and taps through uitest, all over hdc.
 *
 * @module @local/dsh-deveco/ui
 */

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/** Parse a uitest bounds string "[0,0][1280,2832]" into a rectangle. */
export function parseBounds(value) {
  const match = /\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/.exec(String(value ?? ''));
  if (!match) return null;
  const [, left, top, right, bottom] = match.map(Number);
  return {
    left,
    top,
    right,
    bottom,
    width: Math.max(0, right - left),
    height: Math.max(0, bottom - top),
    centerX: Math.round((left + right) / 2),
    centerY: Math.round((top + bottom) / 2),
  };
}

/**
 * Flatten a uitest layout tree into the nodes an agent can act on: visible
 * nodes that carry text, an id, or a click action.
 *
 * @param {any} root
 * @returns {{ screen: { width: number, height: number }, nodes: Array<Record<string, unknown>>, count: number }}
 */
export function flattenLayout(root) {
  const nodes = [];
  let screen = { width: 0, height: 0 };
  const rootBounds = parseBounds(root?.attributes?.bounds);
  if (rootBounds) screen = { width: rootBounds.right, height: rootBounds.bottom };
  let visited = 0;

  const walk = (node, depth) => {
    if (!node || visited > 3000) return;
    visited += 1;
    const attributes = node.attributes ?? {};
    if (depth <= 1 && screen.width === 0) {
      const bounds = parseBounds(attributes.bounds);
      if (bounds && bounds.right > screen.width) screen = { width: bounds.right, height: bounds.bottom };
    }
    const visible = attributes.visible !== 'false';
    const text = String(attributes.text ?? '').trim();
    const description = String(attributes.description ?? '').trim();
    const id = String(attributes.id ?? '').trim();
    const clickable = attributes.clickable === 'true';
    const bounds = parseBounds(attributes.bounds);
    if (visible && bounds && bounds.width > 0 && bounds.height > 0 && (text !== '' || clickable || (id !== '' && depth > 2))) {
      nodes.push({
        text: text.length > 0 ? text : description,
        id,
        type: String(attributes.type ?? ''),
        clickable,
        scrollable: attributes.scrollable === 'true',
        bounds: { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height },
        center: { x: bounds.centerX, y: bounds.centerY },
        depth,
      });
    }
    for (const child of Array.isArray(node.children) ? node.children : []) walk(child, depth + 1);
  };
  walk(root, 0);
  return { screen, nodes: nodes.slice(0, 200), count: nodes.length };
}

/**
 * Build the UI facade.
 * @param {{ paths: () => any, device: any, config: Record<string, any> }} runtime
 */
export function createUiService(runtime) {
  const remoteTmp = (suffix) => `/data/local/tmp/dsh-deveco-${randomUUID().slice(0, 8)}.${suffix}`;

  /** Capture the device screen to a local JPEG. */
  const screenshot = async (device, directory) => {
    const remote = remoteTmp('jpeg');
    const captured = await runtime.device.shell(device, `snapshot_display -f ${remote}`, { timeoutMs: 60000 });
    const sizeMatch = captured.output.match(/width:\s*(\d+),\s*height:\s*(\d+)/i);
    const local = path.join(directory, `screen-${new Date().toISOString().replace(/[:.]/g, '-')}.jpeg`);
    const received = await runtime.device.fileRecv(device, remote, local, { timeoutMs: 60000 });
    if (!received.ok || !existsSync(local)) {
      throw new Error(`screen capture failed: ${captured.output.slice(0, 400)} ${received.output.slice(0, 400)}`.trim());
    }
    return {
      file: local,
      mediaType: 'image/jpeg',
      bytes: statSync(local).size,
      width: sizeMatch ? Number(sizeMatch[1]) : 0,
      height: sizeMatch ? Number(sizeMatch[2]) : 0,
      device: device.key,
    };
  };

  /** Dump and parse the current view hierarchy. */
  const layout = async (device) => {
    const remote = remoteTmp('json');
    const dumped = await runtime.device.shell(device, `uitest dumpLayout -p ${remote}`, { timeoutMs: 60000 });
    const local = path.join(runtime.layoutDir(), `layout-${randomUUID().slice(0, 8)}.json`);
    const received = await runtime.device.fileRecv(device, remote, local, { timeoutMs: 60000 });
    if (!received.ok) throw new Error(`layout dump failed: ${dumped.output.slice(0, 300)} ${received.output.slice(0, 300)}`.trim());
    let root;
    try {
      root = JSON.parse(readFileSync(local, 'utf8'));
    } catch (error) {
      throw new Error(`the layout dump was not readable JSON: ${error.message}`);
    }
    const flat = flattenLayout(root);
    return { file: local, ...flat };
  };

  /** Tap at screen coordinates. */
  const tap = async (device, x, y) => {
    const result = await runtime.device.shell(device, `uitest uiInput click ${Math.round(x)} ${Math.round(y)}`, { timeoutMs: 30000 });
    return { ok: result.code === 0, output: result.output };
  };

  /** Swipe between two screen points. */
  const swipe = async (device, fromX, fromY, toX, toY, velocity) => {
    const args = ['uitest', 'uiInput', 'swipe', fromX, fromY, toX, toY];
    if (Number.isFinite(velocity)) args.push(String(velocity));
    const result = await runtime.device.shell(device, args.join(' '), { timeoutMs: 30000 });
    return { ok: result.code === 0, output: result.output };
  };

  /** Type text into the focused field, or at a coordinate. */
  const inputText = async (device, text, point) => {
    const escaped = text.replace(/"/g, '\\"');
    const command =
      point === undefined || point === null
        ? `uitest uiInput text "${escaped}"`
        : `uitest uiInput inputText ${Math.round(point.x)} ${Math.round(point.y)} "${escaped}"`;
    const result = await runtime.device.shell(device, command, { timeoutMs: 30000 });
    return { ok: result.code === 0, output: result.output };
  };

  /** Press a named key (Back/Home/Power) or a numeric key code. */
  const key = async (device, name) => {
    const result = await runtime.device.shell(device, `uitest uiInput keyEvent ${name}`, { timeoutMs: 30000 });
    return { ok: result.code === 0, output: result.output };
  };

  return { screenshot, layout, tap, swipe, inputText, key };
}
