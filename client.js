/**
 * Client half of @local/dsh-deveco: a movable floating DevEco control panel.
 *
 * It contributes two slot entries from this one module:
 *  - `conversation.session.header.utilities` gets an invisible bridge that records
 *    the Session id of the page's open conversation (the root-scoped overlay has
 *    no session prop of its own).
 *  - `shell.overlay` gets the visible card: device and project state, plus
 *    build / run / stop / open-in-IDE actions.
 *
 * It talks to the package's own Host half over two loopback HTTP routes:
 *   GET  /dsh-deveco/state?sessionId=…
 *   POST /dsh-deveco/control { action: build|run|stop|open, sessionId }
 *
 * No JSX/TypeScript here: the browser loads this file as-is and provides React.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-deveco',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'dsh-deveco';
    const POSITION_KEY = 'dsh-deveco:float-position';
    const PANEL_WIDTH = 296;
    const EDGE = 8;

    const DICTIONARIES = {
      en: {
        groupLabel: 'DevEco Studio controls',
        build: 'Build HAP',
        run: 'Run app',
        stop: 'Stop app',
        ide: 'Open in DevEco Studio',
        idle: 'App not running',
        appIdle: 'App not running',
        appRunning: 'App running',
        ideOpen: 'IDE open',
        ideClosed: 'IDE closed',
        connecting: 'Connecting…',
        running: 'Running',
        building: 'Building…',
        installing: 'Installing…',
        launching: 'Launching…',
        noDevice: 'No device',
        noProject: 'No project',
        selectProject: 'Select project',
        failed: 'DevEco control failed',
        ready: 'Ready',
        moveHint: 'Drag to move · double-click to reset position',
      },
      zh: {
        groupLabel: 'DevEco Studio 控制',
        build: '构建 HAP',
        run: '运行应用',
        stop: '停止应用',
        ide: '在 DevEco Studio 中打开',
        idle: '应用未运行',
        appIdle: '应用未运行',
        appRunning: '应用运行中',
        ideOpen: 'IDE 已打开',
        ideClosed: 'IDE 未打开',
        connecting: '连接中…',
        running: '运行中',
        building: '构建中…',
        installing: '安装中…',
        launching: '启动中…',
        noDevice: '无设备',
        noProject: '无工程',
        selectProject: '选择项目',
        failed: 'DevEco 控制失败',
        ready: '就绪',
        moveHint: '拖动移动 · 双击复位位置',
      },
    };

    const FALLBACK = DICTIONARIES.en;
    let activeSessionId = null;
    /** Panel instances that follow the conversation currently shown. */
    const sessionWatchers = new Set();

    /** Publish the open conversation and wake the panel immediately. */
    function publishSession(sessionId) {
      if (sessionId === activeSessionId) return;
      activeSessionId = sessionId;
      for (const watcher of [...sessionWatchers]) {
        try {
          watcher(sessionId);
        } catch {
          /* a watcher must not break the bridge */
        }
      }
    }

    function watchSession(watcher) {
      sessionWatchers.add(watcher);
      return () => sessionWatchers.delete(watcher);
    }

    function readStoredPosition() {
      try {
        const raw = window.localStorage.getItem(POSITION_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && Number.isFinite(parsed.left) && Number.isFinite(parsed.top)) return { left: parsed.left, top: parsed.top };
      } catch {
        /* storage can be unavailable; fall through to the default */
      }
      return null;
    }

    function storePosition(position) {
      try {
        window.localStorage.setItem(POSITION_KEY, JSON.stringify(position));
      } catch {
        /* position just won't persist */
      }
    }

    function viewport() {
      if (typeof window === 'undefined') return { width: 1280, height: 800 };
      return { width: Number.isFinite(window.innerWidth) ? window.innerWidth : 1280, height: Number.isFinite(window.innerHeight) ? window.innerHeight : 800 };
    }

    function clampPosition(position) {
      const { width, height } = viewport();
      return {
        left: Math.min(Math.max(position.left, EDGE), Math.max(EDGE, width - PANEL_WIDTH - EDGE)),
        top: Math.min(Math.max(position.top, EDGE), Math.max(EDGE, height - 140 - EDGE)),
      };
    }

    function defaultPosition() {
      const { width } = viewport();
      return clampPosition({ left: width - PANEL_WIDTH - 24, top: 72 });
    }

    function createTranslator(ctx) {
      const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined;
      try {
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          for (const [localeId, dict] of Object.entries(DICTIONARIES)) locale.register(NS, localeId, dict);
          return locale.bind(NS);
        }
      } catch {
        /* fall through to English */
      }
      return (key) => FALLBACK[key] ?? key;
    }

    /**
     * The desktop page is `file://`; DSH plugin routes live on the Host process,
     * not in the Electron IPC bridge the page's relative fetches reach. The Host
     * therefore starts its own loopback carrier and the panel probes its ports.
     * A browser deployment (page served over HTTP) still answers the original
     * relative paths, kept as the last fallback.
     */
    const TOOLBAR_PORTS = [5731, 5732, 5733, 5734, 5735, 5736, 5737, 5738, 5739, 5740];
    let toolbarOrigin = null;

    async function discoverToolbar() {
      if (toolbarOrigin !== null) return toolbarOrigin;
      for (const port of TOOLBAR_PORTS) {
        const origin = `http://127.0.0.1:${port}`;
        try {
          const response = await fetch(`${origin}/ping`, {
            cache: 'no-store',
            signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(700) : undefined,
          });
          if (response.ok) {
            const body = await response.json().catch(() => ({}));
            if (body && body.app === 'dsh-deveco') {
              toolbarOrigin = origin;
              return origin;
            }
          }
        } catch {
          /* port not hosting the toolbar; try the next one */
        }
      }
      return null;
    }

    async function requestToolbar(pathname, init) {
      const origin = await discoverToolbar();
      if (origin !== null) {
        try {
          return await fetch(`${origin}${pathname}`, init);
        } catch (error) {
          toolbarOrigin = null;
          throw new Error(`DevEco Host unreachable on ${origin}: ${(error && error.message) || error}`);
        }
      }
      // Browser deployment: the DSH web server serves the same paths.
      try {
        return await fetch(`/dsh-deveco${pathname}`, init);
      } catch (error) {
        throw new Error(`DevEco Host is not reachable (no toolbar listener on ports ${TOOLBAR_PORTS[0]}-${TOOLBAR_PORTS.at(-1)}): restart DSH to activate the plugin`);
      }
    }

    async function readState(sessionId) {
      const query = typeof sessionId === 'string' && sessionId.length > 0 ? `?sessionId=${encodeURIComponent(sessionId)}` : '';
      const response = await requestToolbar(`/state${query}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
      const body = await response.json().catch(() => ({}));
      if (response.status === 404) throw new Error('DevEco Host plugin is not loaded yet — restart DSH to activate it');
      if (!response.ok || body.ok !== true) throw new Error(body.error || `state request failed (HTTP ${response.status})`);
      return body.state;
    }

    async function sendControl(request) {
      const response = await requestToolbar('/control', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok !== true) throw new Error(body.error || `control request failed (HTTP ${response.status})`);
      return body.state;
    }

    function IconBuild() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M9.4 1.6 14.4 6.6 12.7 8.3 10.6 6.2 6.1 10.7 7.8 12.4 6.1 14.1 1.1 9.1 2.8 7.4 4.5 9.1 9 4.6 7.7 3.3z',
          fill: 'currentColor',
        }),
      );
    }

    function IconPlay() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false }, h('path', { d: 'M4 2.6v10.8L13 8 4 2.6z', fill: 'currentColor' }));
    }

    /** Circular arrow shown once the app is running (the action still runs it again). */
    function IconRestart() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false },
        h('path', {
          d: 'M8 2.4a5.6 5.6 0 1 1-5.3 3.7l1.5.6A4 4 0 1 0 8 4V6L4.6 3.4 8 .8v1.6z',
          fill: 'currentColor',
        }),
      );
    }

    function IconStop() {
      return h('svg', { viewBox: '0 0 16 16', width: 12, height: 12, 'aria-hidden': true, focusable: false }, h('rect', { x: 3.2, y: 3.2, width: 9.6, height: 9.6, rx: 1.6, fill: 'currentColor' }));
    }

    function IconIde() {
      return h(
        'svg',
        { viewBox: '0 0 16 16', width: 13, height: 13, 'aria-hidden': true, focusable: false },
        h('path', { d: 'M5.6 3.2 1 8l4.6 4.8 1.2-1.2L3.6 8l3.2-3.6zm4.8 0-1.2 1.2L12.4 8l-3.2 3.6 1.2 1.2L15 8z', fill: 'currentColor' }),
      );
    }

    function IconGrip() {
      return h(
        'svg',
        { viewBox: '0 0 10 16', width: 10, height: 16, 'aria-hidden': true, focusable: false },
        ...[4.5, 8, 11.5].flatMap((y) => [3, 7].map((x) => h('circle', { key: `${x}-${y}`, cx: x, cy: y, r: 1.1, fill: 'currentColor' }))),
      );
    }

    /** Invisible entry in the Session header: records which conversation is open. */
    function SessionBridge(props) {
      const sessionId = props && props.sessionId;
      React.useEffect(() => {
        publishSession(typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : null);
      }, [sessionId]);
      return null;
    }

    function DevEcoFloat() {
      const translate = DevEcoFloat.translate;
      const [position, setPosition] = React.useState(() => clampPosition(readStoredPosition() || defaultPosition()));
      const [state, setState] = React.useState(null);
      const [error, setError] = React.useState('');
      const [pending, setPending] = React.useState('');

      React.useEffect(() => {
        let cancelled = false;
        let timer = null;
        let inFlight = false;
        let wake = false;
        let visible = false;

        const schedule = () => {
          if (cancelled) return;
          timer = setTimeout(tick, visible ? 1500 : 3000);
        };

        const tick = async () => {
          if (cancelled) return;
          if (inFlight) {
            wake = true;
            return;
          }
          inFlight = true;
          try {
            const next = await readState(activeSessionId);
            if (!cancelled) {
              visible = Boolean(next && next.project);
              setState(next);
              setError('');
            }
          } catch (failure) {
            if (!cancelled) setError(String((failure && failure.message) || failure));
          } finally {
            inFlight = false;
          }
          if (cancelled) return;
          if (wake) {
            wake = false;
            tick();
            return;
          }
          schedule();
        };

        // Switching conversations must not wait for the next poll tick.
        const unwatch = watchSession(() => {
          if (timer !== null) {
            clearTimeout(timer);
            timer = null;
          }
          if (inFlight) {
            wake = true;
            return;
          }
          tick();
        });

        tick();
        return () => {
          cancelled = true;
          unwatch();
          if (timer !== null) clearTimeout(timer);
        };
      }, []);

      React.useEffect(() => {
        const onResize = () => setPosition((current) => clampPosition(current));
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
      }, []);

      const startDrag = (event) => {
        if (event.button !== undefined && event.button !== 0) return;
        const target = event.target;
        if (target && typeof target.closest === 'function' && target.closest('button,select')) return;
        event.preventDefault();
        const originX = event.clientX;
        const originY = event.clientY;
        const base = position;
        let latest = base;
        const onMove = (moveEvent) => {
          latest = clampPosition({ left: base.left + (moveEvent.clientX - originX), top: base.top + (moveEvent.clientY - originY) });
          setPosition(latest);
        };
        const onUp = () => {
          window.removeEventListener('pointermove', onMove);
          window.removeEventListener('pointerup', onUp);
          storePosition(latest);
          document.body.style.userSelect = '';
          document.body.style.cursor = '';
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'grabbing';
      };

      const resetPosition = () => {
        const next = defaultPosition();
        setPosition(next);
        storePosition(next);
      };

      const actSelect = async (directory) => {
        setPending('select');
        try {
          const next = await sendControl({ action: 'select', project: directory, sessionId: activeSessionId || undefined });
          setState(next);
          setError('');
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setPending('');
        }
      };

      const act = async (action) => {
        setPending(action);
        try {
          const next = await sendControl({ action, sessionId: activeSessionId || undefined });
          setState(next);
          setError('');
        } catch (failure) {
          setError(String((failure && failure.message) || failure));
        } finally {
          setPending('');
        }
      };

      // The panel belongs to a HarmonyOS workspace: without a project there is
      // nothing to build or run, so it renders nothing at all.
      if (state === null || state === undefined || !state.project) return null;

      const busy = Boolean(state && state.busy) || pending !== '';
      const running = Boolean(state && state.running);
      const device = state && state.device;
      const project = state && state.project;
      const projects = state && Array.isArray(state.projects) ? state.projects : [];
      const deviceText = device ? (device.model || device.key) : translate('noDevice');
      const apiText = device && device.api ? `API ${device.api}` : '';
      const projectText = project ? project.name : translate('noProject');
      const detail = state && state.message && state.message !== '' ? state.message : translate('ready');
      const tooltip = error
        ? `${translate('failed')}: ${error}`
        : `${projectText}${project && project.dir ? ` (${project.dir})` : ''} · ${deviceText}${state && state.port ? ` · port ${state.port}` : ''}\n${detail}\n${translate('moveHint')}`;
      const dotColor = error
        ? 'var(--dsw-alias-state-error-primary)'
        : busy
          ? 'var(--dsw-alias-state-warn-primary)'
          : running
            ? 'var(--dsw-alias-state-success-primary)'
            : 'var(--dsw-alias-state-idle-primary)';

      const buttonStyle = (accent, disabled) => ({
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '26px',
        height: '26px',
        padding: 0,
        border: '1px solid var(--dsw-alias-border-l1)',
        borderRadius: '7px',
        background: 'var(--dsw-alias-bg-layer-1)',
        color: accent,
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.45 : 1,
        lineHeight: 1,
        boxSizing: 'border-box',
        flex: 'none',
      });

      const labelStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        minWidth: 0,
        flex: '1 1 auto',
        fontSize: '11px',
        lineHeight: 1.2,
        color: 'var(--dsw-alias-label-secondary)',
        overflow: 'hidden',
        whiteSpace: 'nowrap',
        textOverflow: 'ellipsis',
      };

      return h(
        'div',
        {
          role: 'group',
          'aria-label': translate('groupLabel'),
          title: tooltip,
          style: {
            position: 'fixed',
            left: `${position.left}px`,
            top: `${position.top}px`,
            zIndex: 60,
            display: 'flex',
            flexDirection: 'column',
            gap: '6px',
            width: `${PANEL_WIDTH}px`,
            boxSizing: 'border-box',
            padding: '7px 9px',
            borderRadius: '11px',
            border: '1px solid var(--dsw-alias-border-l1)',
            background: 'var(--dsw-alias-bg-overlay)',
            color: 'var(--dsw-alias-label-primary)',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.18)',
            pointerEvents: 'auto',
            cursor: 'grab',
            userSelect: 'none',
            font: 'inherit',
          },
          onPointerDown: startDrag,
          onDoubleClick: resetPosition,
        },
        h(
          'div',
          { key: 'head', style: { display: 'flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
          h('span', { key: 'grip', style: { display: 'inline-flex', width: '10px', color: 'var(--dsw-alias-label-secondary)', flex: 'none' }, 'aria-hidden': true }, h(IconGrip)),
          h('span', {
            key: 'dot',
            style: {
              width: '7px',
              height: '7px',
              borderRadius: '50%',
              background: dotColor,
              flex: 'none',
              animation: busy ? 'dsh-deveco-pulse 1.2s ease-in-out infinite' : undefined,
            },
            'aria-hidden': true,
          }),
          projects.length > 1
            ? h(
                'select',
                {
                  key: 'project',
                  value: project ? project.dir : '',
                  title: translate('selectProject'),
                  'aria-label': translate('selectProject'),
                  onChange: (event) => actSelect(event.target.value),
                  style: {
                    flex: '1 1 auto',
                    minWidth: 0,
                    maxWidth: '100%',
                    padding: '1px 2px',
                    border: '1px solid var(--dsw-alias-border-l1)',
                    borderRadius: '6px',
                    background: 'var(--dsw-alias-bg-layer-1)',
                    color: 'var(--dsw-alias-label-primary)',
                    font: 'inherit',
                    fontSize: '11px',
                    fontWeight: 600,
                    cursor: 'pointer',
                  },
                },
                projects.map((entry) => h('option', { key: entry.dir, value: entry.dir }, entry.name)),
              )
            : h(
                'span',
                {
                  key: 'project',
                  style: { ...labelStyle, color: 'var(--dsw-alias-label-primary)', fontWeight: 600 },
                },
                projectText,
              ),
          h(
            'span',
            { key: 'device', style: { ...labelStyle, flex: '0 0 auto', fontSize: '10px', color: 'var(--dsw-alias-label-tertiary)' } },
            [deviceText, apiText].filter((part) => part !== '').join(' · '),
          ),
        ),
        h(
          'div',
          { key: 'actions', style: { display: 'flex', alignItems: 'center', gap: '6px' } },
          h(
            'button',
            {
              key: 'build',
              type: 'button',
              title: translate('build'),
              'aria-label': translate('build'),
              disabled: busy || project === null,
              onClick: () => act('build'),
              style: buttonStyle('var(--dsw-alias-brand-primary)', busy || project === null),
            },
            h(IconBuild),
          ),
          h(
            'button',
            {
              key: 'run',
              type: 'button',
              title: translate('run'),
              'aria-label': translate('run'),
              disabled: busy || project === null,
              onClick: () => act('run'),
              style: buttonStyle('var(--dsw-alias-state-success-primary)', busy || project === null),
            },
            running ? h(IconRestart) : h(IconPlay),
          ),
          h(
            'button',
            {
              key: 'stop',
              type: 'button',
              title: translate('stop'),
              'aria-label': translate('stop'),
              disabled: busy || !running,
              onClick: () => act('stop'),
              style: buttonStyle('var(--dsw-alias-state-error-primary)', busy || !running),
            },
            h(IconStop),
          ),
          h(
            'button',
            {
              key: 'ide',
              type: 'button',
              title: translate('ide'),
              'aria-label': translate('ide'),
              disabled: busy || project === null,
              onClick: () => act('open'),
              style: buttonStyle('var(--dsw-alias-label-secondary)', busy || project === null),
            },
            h(IconIde),
          ),
          h(
            'span',
            {
              key: 'message',
              style: {
                ...labelStyle,
                justifyContent: 'flex-end',
                textAlign: 'right',
                color: error ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-tertiary)',
              },
            },
            error || detail,
          ),
        ),
        h('style', { key: 'kf' }, '@keyframes dsh-deveco-pulse{0%,100%{opacity:.35}50%{opacity:1}}'),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const translate = createTranslator(ctx);
        DevEcoFloat.translate = translate;

        ctx.slots.inject('shell.overlay', () =>
          ctx.slots.register({ name: 'shell.overlay', id: 'deveco-float', order: 51, label: 'DevEco Studio' }, DevEcoFloat),
        );

        ctx.slots.inject('conversation.session.header.utilities', () =>
          ctx.slots.register(
            { name: 'conversation.session.header.utilities', id: 'deveco-session-bridge', order: 0, label: 'DevEco Studio' },
            SessionBridge,
          ),
        );
      },
    };
  },
});
