import {
  APITags,
  WebSocketRoute,
  Logger,
  Request,
} from '@browserless.io/browserless';
import { Duplex } from 'stream';
import WebSocket, { WebSocketServer } from 'ws';

/**
 * [LIVE-NAV PATCH] Live browser shell relay.
 *
 * Two-tier architecture (evidence-driven, see docs/aegis plans):
 *  - ONE shared browser-level upstream (ws://127.0.0.1:<port>/chromium when
 *    no session exists — shell owns that instance's lifecycle; or
 *    /devtools/browser/<GUID> to attach an agent's session as observer).
 *    Carries Target.* tab management: discovery, createTarget, closeTarget,
 *    and target lifecycle events for the tab strip.
 *  - PER-CLIENT page-level watcher (/devtools/page/<targetId>) for the tab
 *    the client is watching: screencast frames, input, navigation. Chrome
 *    headless REJECTS Page.startScreencast on flatten-attached sessions
 *    ("Not attached to an active page"), so page-level connections are the
 *    only working screencast path (same as the official debugger UI).
 *
 * Security: the channel is unauthenticated (LAN trust boundary), so every
 * downstream method is whitelisted. Anything that can execute JS
 * (Runtime.evaluate, Page.addScriptToEvaluateOnNewDocument, Debugger.*) is
 * rejected before reaching the wire.
 */

const BROWSER_METHODS = new Set<string>([
  'Target.setDiscoverTargets',
  'Target.getTargets',
  'Target.getTargetInfo',
  'Target.createTarget',
  'Target.closeTarget',
]);

const PAGE_METHODS = new Set<string>([
  'Page.enable',
  'Page.disable',
  'Page.navigate',
  'Page.startScreencast',
  'Page.stopScreencast',
  'Page.screencastFrameAck',
  'Page.captureScreenshot',
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.insertText',
  'Input.dispatchTouchEvent',
  'Emulation.setDeviceMetricsOverride',
  'Emulation.clearDeviceMetricsOverride',
  'Emulation.setPageScaleFactor',
  'Runtime.enable',
  'Log.enable',
  'Network.enable',
]);

// Live relay model (user decision 2026-11-10): the spawned browser is a
// PERSISTENT service — it outlives shell disconnections entirely. The relay
// keeps exactly one upstream per key and reconnects it automatically if the
// transport drops (tabs are lost on such a respawn, which only happens when
// the browserless service itself restarts or the process is reclaimed).
// Reclaim happens ONLY when the user stops the container.

interface Watcher {
  ws: WebSocket;
  targetId: string;
}

interface ClientState {
  ws: WebSocket;
  watcher: Watcher | null;
  watcherSeq: number;
  watcherReplies: Map<number, string>;
}

interface UpstreamEntry {
  key: string;
  ws: WebSocket;
  spawned: boolean;
  clients: Set<ClientState>;
  seq: number;
  retryCount?: number;
  replies: Map<number, { client: ClientState; replyId?: string }>;
  sendQueue: string[];
}
const upstreams = new Map<string, UpstreamEntry>();

export default class LiveNavWebSocketRoute extends WebSocketRoute {
  name = 'LiveNavWebSocketRoute';
  auth = false;
  browser = null;
  concurrency = false;
  description = `LAN browser-shell relay: attaches to the active browser session (or spawns one when idle) and relays a whitelisted CDP subset for live screencast, tab management and input.`;
  path = ['/live'];
  tags = [APITags.management];

  async handler(
    _req: Request,
    socket: Duplex,
    head: Buffer,
    logger: Logger,
  ): Promise<void> {
    const wss = new WebSocketServer({ noServer: true });
    const client: WebSocket = await new Promise((resolve) =>
      wss.handleUpgrade(_req, socket, head, (ws) => resolve(ws)),
    );

    let entry: UpstreamEntry;
    try {
      entry = await this.ensureUpstream(logger);
    } catch (err) {
      logger.error(`[live-nav] no upstream available: ${err}`);
      client.send(
        JSON.stringify({
          t: 'error',
          message: 'No browser session is available to attach to.',
        }),
      );
      client.close(1013, 'no-upstream');
      return;
    }

    const state: ClientState = {
      ws: client,
      watcher: null,
      watcherSeq: 0,
      watcherReplies: new Map(),
    };
    entry.clients.add(state);

    client.send(
      JSON.stringify({
        t: 'up',
        spawned: entry.spawned,
        key: entry.key,
      }),
    );

    const dropClient = () => {
      entry.clients.delete(state);
      this.closeWatcher(state, logger);
      // Persistent model: no grace timer, no reclaim — the upstream stays
      // connected (and auto-reconnects) regardless of client count.
    };

    client.on('close', dropClient);
    client.on('error', dropClient);

    client.on('message', (data: unknown) => {
      let msg: {
        t?: string;
        id?: string;
        targetId?: string;
        m?: { method: string; params?: object };
      };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        return client.send(JSON.stringify({ t: 'pong' }));
      }
      if (msg.t === 'watch' && typeof msg.targetId === 'string') {
        return this.watch(state, msg.targetId, logger);
      }
      if (msg.t !== 'send' || !msg.m || typeof msg.m.method !== 'string') {
        return;
      }
      const { method } = msg.m;
      if (BROWSER_METHODS.has(method)) {
        const seq = ++entry.seq;
        entry.replies.set(seq, { client: state, replyId: msg.id });
        const payload = {
          id: seq,
          method,
          params: msg.m.params ?? {},
        };
        if (entry.ws.readyState === WebSocket.OPEN) {
          entry.ws.send(JSON.stringify(payload));
        } else {
          entry.sendQueue.push(JSON.stringify(payload));
        }
        return;
      }
      if (PAGE_METHODS.has(method)) {
        if (typeof msg.id !== 'string') {
          return client.send(
            JSON.stringify({ t: 'error', message: 'Page commands require an id.' }),
          );
        }
        if (!state.watcher || state.watcher.ws.readyState !== WebSocket.OPEN) {
          return client.send(
            JSON.stringify({
              t: 'error',
              message: 'No page is being watched — send {"t":"watch","targetId":"..."} first.',
            }),
          );
        }
        // CDP requires integer ids; remap the client's string id here.
        const seq = ++state.watcherSeq;
        state.watcherReplies.set(seq, msg.id);
        return state.watcher.ws.send(
          JSON.stringify({ id: seq, method, params: msg.m.params ?? {} }),
        );
      }
      return client.send(
        JSON.stringify({
          t: 'error',
          message: `Method not allowed on live-nav channel: ${method}`,
        }),
      );
    });
  }

  private watch(
    state: ClientState,
    targetId: string,
    logger: Logger,
  ): void {
    this.closeWatcher(state, logger);
    const config = this.config();
    const token = config.getToken();
    const port = config.getPort();
    const authQuery = token ? `?token=${token}` : '';
    const url = `ws://127.0.0.1:${port}/devtools/page/${targetId}${authQuery}`;
    const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
    const watcher: Watcher = { ws, targetId };
    state.watcher = watcher;
    state.watcherReplies.clear();

    ws.on('open', () => {
      logger.warn(`[live-nav] watcher open for ${targetId}`);
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ t: 'watching', targetId }));
      }
    });
    ws.on('message', (data: unknown) => {
      if (state.ws.readyState !== WebSocket.OPEN) return;
      let parsed: { id?: unknown; method?: string; params?: object };
      try {
        parsed = JSON.parse(String(data));
      } catch {
        return;
      }
      // Remap numeric ids back to the client's original ids; events pass
      // through untouched and belong to this watcher only.
      if (parsed.id !== undefined && state.watcherReplies.has(Number(parsed.id))) {
        const origId = state.watcherReplies.get(Number(parsed.id))!;
        state.watcherReplies.delete(Number(parsed.id));
        return state.ws.send(
          JSON.stringify({ t: 'e', m: { id: origId, result: (parsed as any).result, error: (parsed as any).error } }),
        );
      }
      state.ws.send(JSON.stringify({ t: 'e', m: parsed }));
    });
    ws.on('close', () => {
      if (state.watcher === watcher) state.watcher = null;
      if (state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ t: 'watchClosed', targetId }));
      }
    });
    ws.on('error', (err) =>
      logger.error(`[live-nav] watcher error: ${err}`),
    );
  }

  private closeWatcher(state: ClientState, logger: Logger): void {
    if (!state.watcher) return;
    const w = state.watcher;
    state.watcher = null;
    if (w.ws.readyState === WebSocket.OPEN) w.ws.close(1000, 're-watch');
    else w.ws.terminate();
    logger.warn(`[live-nav] watcher closed for ${w.targetId}`);
  }

  protected async ensureUpstream(logger: Logger): Promise<UpstreamEntry> {
    const config = this.config();
    const token = config.getToken();
    const port = config.getPort();
    const authQuery = token ? `?token=${token}` : '';
    const internal = `ws://127.0.0.1:${port}`;

    const sessions = await this.browserManager().getAllSessions();
    const chromeLike = sessions
      .filter((s) => s.browser.includes('CDP') && s.browserId)
      .sort((a, b) => b.startedOn - a.startedOn);

    if (chromeLike.length > 0) {
      const target = chromeLike[0];
      const key = `${internal}/devtools/browser/${target.browserId}${authQuery}`;
      const existing = upstreams.get(key);
      if (existing && existing.ws.readyState === WebSocket.OPEN) {
        return existing;
      }
      logger.warn(`[live-nav] attaching to session ${target.browserId}`);
      const entry = makeUpstream(key, false, logger);
      upstreams.set(key, entry);
      return entry;
    }

    // No active session: spawn a shell-owned browser. Closing this
    // connection (grace expiry) lets browserless reclaim it.
    const key = `${internal}/chromium${authQuery}`;
    const existing = upstreams.get(key);
    if (existing && existing.ws.readyState === WebSocket.OPEN) {
      return existing;
    }
    logger.warn(`[live-nav] no active sessions, spawning shell instance`);
    const entry = makeUpstream(key, true, logger);
    upstreams.set(key, entry);
    return entry;
  }
}

function makeUpstream(key: string, spawned: boolean, logger: Logger) {
  const ws = new WebSocket(key, { maxPayload: 256 * 1024 * 1024 });
  const entry: UpstreamEntry = {
    key,
    ws,
    spawned,
    clients: new Set(),
    seq: 0,
    replies: new Map(),
    sendQueue: [],
  };
  ws.on('open', () => {
    logger.warn(`[live-nav] upstream open: ${key}`);
    for (const queued of entry.sendQueue) {
      ws.send(queued);
    }
    entry.sendQueue = [];
    for (const c of entry.clients) {
      c.ws.send(JSON.stringify({ t: 'up', spawned, key }));
    }
  });

  ws.on('message', (data: unknown) => {
    let parsed: {
      id?: unknown;
      method?: string;
      params?: object;
      sessionId?: string;
    };
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (parsed.id !== undefined && entry.replies.has(Number(parsed.id))) {
      const { client, replyId } = entry.replies.get(Number(parsed.id))!;
      entry.replies.delete(Number(parsed.id));
      if (client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(
          JSON.stringify({
            t: 'r',
            id: replyId,
            m: { id: parsed.id, result: (parsed as any).result, error: (parsed as any).error },
          }),
        );
      }
      return;
    }
    if (parsed.method) {
      const frame = JSON.stringify({
        t: 'e',
        m: { method: parsed.method, params: parsed.params ?? {} },
      });
      for (const c of entry.clients) {
        if (c.ws.readyState === WebSocket.OPEN) {
          c.ws.send(frame);
        }
      }
    }
  });

  ws.on('close', () => {
    logger.warn(`[live-nav] upstream closed: ${key}`);
    for (const c of entry.clients) {
      if (c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(JSON.stringify({ t: 'upClosed' }));
      }
    }
    upstreams.delete(key);
    entry.replies.clear();
    if (entry.spawned) {
      // Persistent model: the shell browser must survive transport drops and
      // client departures. Respawn after a short backoff (tabs are lost in
      // this path — it only triggers on service restart / process reclaim).
      entry.retryCount = (entry.retryCount || 0) + 1;
      if (entry.retryCount <= 5) {
        const delay = Math.min(2000 * entry.retryCount, 10000);
        setTimeout(() => {
          const fresh = makeUpstream(key, true, logger);
          fresh.retryCount = entry.retryCount;
          upstreams.set(key, fresh);
          // hand surviving clients over to the fresh upstream
          for (const c of entry.clients) fresh.clients.add(c);
          logger.warn(`[live-nav] respawned upstream ${key} (attempt ${entry.retryCount})`);
        }, delay);
      } else {
        logger.error(`[live-nav] giving up respawn after 5 attempts for ${key}`);
      }
    }
  });

  ws.on('error', (err) => logger.error(`[live-nav] upstream error: ${err}`));

  return entry;
}
