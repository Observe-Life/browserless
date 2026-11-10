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
 * A free-of-auth WebSocket relay that lets LAN devices open a browser-shell
 * UI (tab strip + URL bar + live screencast) against the *currently active*
 * browser instance. It is an observer: when sessions exist it attaches to the
 * newest one via the /devtools/browser/<GUID> reconnection endpoint (never
 * spawning a browser); only when no session is running does it spawn its own
 * instance through /chromium, whose lifecycle then follows the shell (last
 * client out + grace period closes the connection, which reclaims the
 * browser). It never touches session timers, killURLs or upstream state.
 *
 * Security posture: the channel is unauthenticated by design (LAN trust
 * boundary), so the downstream (browserbound) message set is strictly
 * whitelisted — anything that can execute JavaScript (Runtime.evaluate,
 * Page.*Script*, Debugger.*, etc.) is rejected before it reaches the wire.
 * Upstream events are relayed verbatim (screencast frames, target infos).
 */

const BROWSER_METHODS = new Set<string>([
  'Target.getTargets',
  'Target.setDiscoverTargets',
  'Target.createTarget',
  'Target.closeTarget',
  'Target.attachToTarget',
  'Target.detachFromTarget',
  'Target.getTargetInfo',
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

// How long a live relay lingers after its last shell disconnects. For spawned
// instances this is the window to hit refresh without losing your tabs; after
// it elapses the upstream connection closes and browserless reclaims the
// browser. Attached (agent-owned) instances are unaffected either way.
const GRACE_MS = 30_000;

interface ShellMessage {
  t: 'send' | 'ping';
  id?: string;
  s?: string;
  m?: { id?: number; method: string; params?: object };
}

interface UpstreamEntry {
  key: string;
  ws: WebSocket;
  spawned: boolean;
  clients: Set<WebSocket>;
  graceTimer: NodeJS.Timeout | null;
  seq: number;
  replies: Map<number, { client: WebSocket; replyId?: string; s?: string }>;
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
    req: Request,
    socket: Duplex,
    head: Buffer,
    logger: Logger,
  ): Promise<void> {
    const wss = new WebSocketServer({ noServer: true });
    const client: WebSocket = await new Promise((resolve) =>
      wss.handleUpgrade(req, socket, head, (ws) => resolve(ws)),
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

    entry.clients.add(client);
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }

    client.send(
      JSON.stringify({
        t: 'up',
        spawned: entry.spawned,
        key: entry.key,
      }),
    );

    const dropClient = () => {
      entry.clients.delete(client);
      if (entry.clients.size === 0 && !entry.graceTimer) {
        entry.graceTimer = setTimeout(() => {
          entry.graceTimer = null;
          if (entry.clients.size === 0) {
            logger.warn(`[live-nav] releasing upstream ${entry.key}`);
            teardown(entry);
          }
        }, GRACE_MS);
        entry.graceTimer.unref?.();
      }
    };

    client.on('close', dropClient);
    client.on('error', dropClient);

    client.on('message', (data: unknown) => {
      let msg: ShellMessage;
      try {
        msg = JSON.parse(String(data)) as ShellMessage;
      } catch {
        return;
      }
      if (msg.t === 'ping') {
        return client.send(JSON.stringify({ t: 'pong' }));
      }
      if (msg.t !== 'send' || !msg.m || typeof msg.m.method !== 'string') {
        return;
      }
      const { method } = msg.m;
      const isPage = typeof msg.s === 'string' && msg.s.length > 0;
      const allowed = isPage
        ? PAGE_METHODS.has(method)
        : BROWSER_METHODS.has(method);
      if (!allowed) {
        return client.send(
          JSON.stringify({
            t: 'error',
            message: `Method not allowed on live-nav channel: ${method}`,
          }),
        );
      }
      const seq = ++entry.seq;
      entry.replies.set(seq, {
        client,
        replyId: msg.id,
        s: isPage ? msg.s : undefined,
      });
      const payload: Record<string, unknown> = {
        id: seq,
        method,
        params: msg.m.params ?? {},
      };
      if (isPage) {
        payload.sessionId = msg.s;
      }
      if (entry.ws.readyState === WebSocket.OPEN) {
        entry.ws.send(JSON.stringify(payload));
      }
    });
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
        logger.warn(`[live-nav] reusing attached upstream ${key}`);
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
    graceTimer: null,
    seq: 0,
    replies: new Map(),
  };

  ws.on('open', () => {
    logger.warn(`[live-nav] upstream open: ${key}`);
    for (const c of entry.clients) {
      c.send(JSON.stringify({ t: 'up', spawned, key }));
    }
  });

  ws.on('message', (data: unknown) => {
    let parsed: {
      id?: number;
      method?: string;
      params?: object;
      sessionId?: string;
    };
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    if (parsed.id !== undefined && entry.replies.has(parsed.id)) {
      const { client, replyId, s } = entry.replies.get(parsed.id)!;
      entry.replies.delete(parsed.id);
      if (client.readyState === WebSocket.OPEN) {
        client.send(
          JSON.stringify({
            t: 'r',
            id: replyId,
            s,
            m: { id: parsed.id, result: (parsed as any).result, error: (parsed as any).error },
          }),
        );
      }
      return;
    }
    if (parsed.method) {
      const frame = JSON.stringify({
        t: 'e',
        s: parsed.sessionId,
        m: { method: parsed.method, params: parsed.params ?? {} },
      });
      for (const c of entry.clients) {
        if (c.readyState === WebSocket.OPEN) {
          c.send(frame);
        }
      }
    }
  });

  ws.on('close', () => {
    logger.warn(`[live-nav] upstream closed: ${key}`);
    for (const c of entry.clients) {
      if (c.readyState === WebSocket.OPEN) {
        c.send(JSON.stringify({ t: 'upClosed' }));
        c.close(1012, 'upstream-closed');
      }
    }
    upstreams.delete(key);
    entry.replies.clear();
    if (entry.graceTimer) {
      clearTimeout(entry.graceTimer);
      entry.graceTimer = null;
    }
  });

  ws.on('error', (err) => logger.error(`[live-nav] upstream error: ${err}`));

  return entry;
}

function teardown(entry: UpstreamEntry) {
  if (entry.ws.readyState === WebSocket.OPEN) {
    entry.ws.close(1000, 'shell-empty');
  } else {
    entry.ws.terminate();
  }
}
