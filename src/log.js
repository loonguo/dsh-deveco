/**
 * Live hilog capture.
 *
 * `hdc hilog` streams until killed, so each capture runs as a tracked session
 * with a bounded ring buffer; `read` hands back only lines the caller has not
 * seen yet. The raw line is preserved in `raw` because hilog's column layout is
 * the only place some fields (domain, tag) survive.
 *
 * @module @local/dsh-deveco/log
 */

import { randomUUID } from 'node:crypto';

import { startStream } from './exec.js';

const HILOG_LINE = /^(?<date>\d{2}-\d{2})\s+(?<time>\d{2}:\d{2}:\d{2}\.\d{3})\s+(?<pid>\d+)\s+(?<tid>\d+)\s+(?<level>[VDIWEF])\s+(?<domain>[0-9A-Za-z]{4,8})\/(?<tag>[^:]+):\s?(?<message>.*)$/;

/** Parse one hilog line; null when the line is not a formatted record. */
export function parseHilogLine(raw) {
  const match = raw.match(HILOG_LINE);
  if (!match?.groups) return null;
  const levelMap = { V: 'verbose', D: 'debug', I: 'info', W: 'warn', E: 'error', F: 'fatal' };
  return {
    time: `${match.groups.date} ${match.groups.time}`,
    pid: Number(match.groups.pid),
    tid: Number(match.groups.tid),
    level: levelMap[match.groups.level] ?? match.groups.level,
    levelChar: match.groups.level,
    domain: match.groups.domain,
    tag: match.groups.tag,
    message: match.groups.message,
    raw,
  };
}

/**
 * Build the log facade.
 * @param {{ config: Record<string, any>, paths: () => any, device: any }} runtime
 */
export function createLogService(runtime) {
  /** @type {Map<string, { id: string, device: string, buffer: string[], cursor: number, process: any, startedAt: string }>} */
  const sessions = new Map();

  const bufferLimit = () => Math.max(200, Number(runtime.config.logBufferLines ?? 5000));

  /** Start a streaming capture. */
  const start = async (options = {}) => {
    const paths = runtime.paths();
    if (!paths.tools.hdc) throw new Error('hdc was not found; set sdkPath in the dsh-deveco config.');
    const device = options.device ?? runtime.config.device ?? '';
    if (!device) throw new Error('a device key is required to start a log capture.');
    const args = ['-t', device, 'hilog'];
    if (options.tag) args.push('-T', options.tag);
    if (options.level) args.push('-L', options.level);
    if (options.pid) args.push('-P', String(options.pid));
    if (options.domain) args.push('-D', options.domain);

    const id = `log-${randomUUID().slice(0, 8)}`;
    const session = { id, device, buffer: [], cursor: 0, process: null, startedAt: new Date().toISOString(), keyword: options.keyword ?? '' };
    const stream = startStream(paths.tools.hdc, args, {
      maxLines: bufferLimit(),
      buffer: true,
      onLine: (line) => {
        if (session.keyword !== '' && !line.toLowerCase().includes(session.keyword.toLowerCase())) return;
        session.buffer.push(line);
        if (session.buffer.length > bufferLimit()) session.buffer.splice(0, session.buffer.length - bufferLimit());
      },
    });
    session.process = stream;
    sessions.set(id, session);
    return {
      id,
      device,
      tag: options.tag ?? '',
      level: options.level ?? '',
      pid: options.pid ?? null,
      startedAt: session.startedAt,
    };
  };

  /** Read new lines since the previous read. */
  const read = (id, limit = 200) => {
    const session = sessions.get(id);
    if (!session) throw new Error(`log session "${id}" does not exist; it was stopped or never started.`);
    const all = session.process.read();
    const slice = all.slice(session.cursor);
    session.cursor = all.length;
    const selected = slice.length > limit ? slice.slice(-limit) : slice;
    const entries = selected.map(parseHilogLine).filter((entry) => entry !== null);
    return {
      id,
      device: session.device,
      newLines: slice.length,
      entries,
      text: selected.join('\n'),
      total: all.length,
      running: !session.process.closed,
    };
  };

  /** Stop and forget one session. */
  const stop = (id) => {
    const session = sessions.get(id);
    if (!session) return { stopped: false };
    const lines = session.process.read();
    session.process.stop();
    sessions.delete(id);
    return { stopped: true, lines: lines.length };
  };

  /** List active sessions. */
  const list = () =>
    [...sessions.values()].map((session) => ({
      id: session.id,
      device: session.device,
      startedAt: session.startedAt,
      lines: session.process.read().length,
      running: !session.process.closed,
    }));

  /** Read crash records from the device fault log. */
  const crashes = async (deviceService, device, limit = 3) => {
    const listing = await deviceService.shell(device, 'ls -t /data/log/faultlog/faultlogger 2>/dev/null');
    const files = listing.output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !/^ls:|not found|Permission denied/i.test(line))
      .slice(0, limit);
    if (files.length === 0) {
      return { files: [], records: [], note: 'No readable crash records under /data/log/faultlog/faultlogger on this device.' };
    }
    const records = [];
    for (const file of files) {
      const content = await deviceService.shell(device, `cat /data/log/faultlog/faultlogger/${file}`);
      records.push({ file, text: content.output.slice(0, 6000) });
    }
    return { files, records, note: '' };
  };

  /** Stop every session (plugin unload). */
  const dispose = () => {
    for (const session of sessions.values()) {
      try {
        session.process.stop();
      } catch {
        /* best effort */
      }
    }
    sessions.clear();
  };

  return { start, read, stop, list, crashes, dispose };
}
