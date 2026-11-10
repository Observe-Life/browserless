import {
  APITags,
  HTTPRoute,
  Methods,
  Request,
  contentTypes,
  writeResponse,
} from '@browserless.io/browserless';
import { ServerResponse } from 'http';

/**
 * [LIVE-NAV PATCH] Live browser shell page (LAN, unauthenticated).
 *
 * Serves a single self-contained HTML page: a native-browser-like shell
 * (tab strip + URL bar + "+" button + live screencast canvas) that connects
 * to the /live WebSocket relay. Read-only by default; "control" toggles
 * input forwarding. See src/routes/management/ws/live.ts for the relay and
 * its whitelist.
 */

const PAGE_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/>
<title>Live 浏览器</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; }
  body {
    font: 14px/1.4 -apple-system, 'PingFang SC', 'Segoe UI', 'Microsoft YaHei', sans-serif;
    background: #202124; color: #e8eaed;
    display: flex; flex-direction: column; overflow: hidden;
    -webkit-user-select: none; user-select: none;
  }
  #tabs {
    display: flex; align-items: flex-end; gap: 2px;
    background: #292a2d; padding: 6px 8px 0; overflow-x: auto; flex: none;
    scrollbar-width: thin;
  }
  #tabs::-webkit-scrollbar { height: 0; }
  .tab {
    display: flex; align-items: center; gap: 6px;
    max-width: 220px; min-width: 110px; height: 34px;
    padding: 0 8px 0 12px; border-radius: 8px 8px 0 0;
    background: transparent; color: #9aa0a6; cursor: pointer;
    flex: 0 0 auto; border: none; font: inherit;
  }
  .tab.active { background: #202124; color: #e8eaed; }
  .tab .t { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; text-align: left; }
  .tab .x {
    flex: none; width: 18px; height: 18px; border-radius: 50%;
    display: none; align-items: center; justify-content: center;
    color: #9aa0a6; font-size: 13px; line-height: 1;
  }
  .tab.active .x, .tab:hover .x { display: flex; }
  .tab .x:hover { background: #3c4043; }
  #newTab {
    flex: none; width: 30px; height: 30px; margin: 0 2px 2px;
    border: none; border-radius: 50%; background: transparent; color: #9aa0a6;
    font-size: 18px; cursor: pointer;
  }
  #newTab:hover { background: #3c4043; }
  #bar {
    display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
    background: #202124; padding: 8px 10px; flex: none;
    border-bottom: 1px solid #3c4043;
  }
  #url {
    flex: 1 1 220px; min-width: 160px; height: 34px;
    background: #292a2d; border: 1px solid #3c4043; border-radius: 17px;
    color: #e8eaed; padding: 0 14px; font: inherit; outline: none;
  }
  #url:focus { border-color: #8ab4f8; }
  #mode {
    height: 34px; padding: 0 14px; border-radius: 17px; border: 1px solid #3c4043;
    background: #292a2d; color: #9aa0a6; font: inherit; cursor: pointer;
  }
  #mode.control { background: #1a73e8; border-color: #1a73e8; color: #fff; }
  #state {
    font-size: 12px; color: #9aa0a6; padding: 0 4px; flex: none;
  }
  #stage { position: relative; flex: 1; background: #0e0e0f; overflow: hidden; }
  #view {
    position: absolute; inset: 0; width: 100%; height: 100%;
    touch-action: none;
  }
  #blank, #msg {
    position: absolute; inset: 0; display: flex;
    align-items: center; justify-content: center;
  }
  #blank { background: #fff; }
  #msg {
    background: #0e0e0f; color: #9aa0a6; font-size: 14px;
    flex-direction: column; gap: 10px; z-index: 5;
  }
  #msg.hidden, #blank.hidden { display: none; }
  #badge {
    position: absolute; top: 10px; right: 10px; z-index: 6;
    font-size: 12px; padding: 4px 10px; border-radius: 12px;
    background: rgba(0,0,0,.55); color: #e8eaed;
  }
  #badge.control { background: rgba(26,115,232,.85); color: #fff; }
</style>
</head>
<body>
  <div id="tabs"></div>
  <div id="bar">
    <input id="url" type="text" placeholder="输入网址打开网页" autocomplete="off" spellcheck="false"/>
    <button id="mode" title="切换只读/接管">只读</button>
    <span id="state">连接中…</span>
  </div>
  <div id="stage">
    <div id="blank" class="hidden"></div>
    <canvas id="view"></canvas>
    <div id="msg"><span id="msgText">正在连接浏览器…</span></div>
    <div id="badge" class="hidden">只读</div>
  </div>
<script>
(function () {
  var ws = null, wsTimer = null;
  var targets = {};            // targetId -> {targetId,title,url,type,attached}
  var watchTarget = null;      // targetId whose page-level channel is open
  var selected = null;
  var control = false;
  var spawned = null;          // null | true | false
  var seq = 1, pending = {};   // cmdId -> fn(reply)
  var scale = 1, offX = 0, offY = 0;
  var haveFrame = false;

  var elTabs = document.getElementById('tabs');
  var elUrl = document.getElementById('url');
  var elMode = document.getElementById('mode');
  var elState = document.getElementById('state');
  var elCanvas = document.getElementById('view');
  var elMsg = document.getElementById('msg');
  var elMsgText = document.getElementById('msgText');
  var elBlank = document.getElementById('blank');
  var elBadge = document.getElementById('badge');
  var ctx = elCanvas.getContext('2d');

  function setState(t) { elState.textContent = t; }
  function setMsg(t) {
    elMsgText.textContent = t;
    elMsg.classList.toggle('hidden', !t);
  }
  function send(method, params) {
    if (!ws || ws.readyState !== 1) return null;
    var id = 'c' + (seq++);
    var msg = { t: 'send', id: id, m: { method: method, params: params || {} } };
    try { ws.send(JSON.stringify(msg)); } catch (e) {}
    return id;
  }

  function connect() {
    clearTimeout(wsTimer);
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    setState('连接中…');
    try { ws = new WebSocket(proto + location.host + '/live'); }
    catch (e) { wsTimer = setTimeout(connect, 2000); return; }
    ws.onopen = function () { setMsg(''); ensure(); };
    ws.onclose = function () {
      targets = {}; watchTarget = null; haveFrame = false;
      setMsg('与浏览器的连接已断开，正在重连…');
      setState('已断开');
      wsTimer = setTimeout(connect, 2000);
    };
    ws.onmessage = function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (d.t === 'up') {
        spawned = d.spawned;
        setState(spawned ? '已连接（独立实例）' : '已连接（旁观智能体实例）');
      } else if (d.t === 'watching') {
        watchTarget = d.targetId;
        startCast();
      } else if (d.t === 'watchClosed') {
        if (watchTarget === d.targetId) { watchTarget = null; haveFrame = false; setMsg('该标签页已关闭'); }
      } else if (d.t === 'upClosed') {
        targets = {}; watchTarget = null; haveFrame = false; selected = null; renderTabs(); setMsg('浏览器会话已结束，正在重连…');
      } else if (d.t === 'error') {
        setMsg(String(d.message || '命令被拒绝'));
      } else if (d.t === 'r') {
        var cb = d.id && pending[d.id];
        if (cb) { delete pending[d.id]; cb(d); }
      } else if (d.t === 'e') {
        onEvent(d);
      }
    };
  }

  function ensure() {
    // Initial state via pull (Target.getTargets), never via event replay —
    // setDiscoverTargets is a no-op on an already-discovering upstream.
    send('Target.setDiscoverTargets', { discover: true });
    var id = send('Target.getTargets');
    if (id) pending[id] = function (d) {
      var infos = (d.result && d.result.targetInfos) || (d.result && d.result.targetIds ? d.result.targetIds.map(function (t) { return { targetId: t, type: 'unknown' }; }) : []);
      infos.forEach(function (info) {
        if (info.type === 'page' || info.type === 'unknown') {
          if (!targets[info.targetId]) targets[info.targetId] = { targetId: info.targetId, type: info.type, url: info.url || '', title: info.title || '' };
        }
      });
      renderTabs(); pickDefault(); syncUi();
      if (selected) watch(selected);
    };
  }

  function onEvent(d) {
    var m = d.m || {};
    // Page-level watcher responses carry the client's own ids verbatim.
    if (m.id !== undefined && pending[m.id]) {
      var cb = pending[m.id];
      delete pending[m.id];
      cb({ result: m.result, error: m.error });
      return;
    }
    var method = m.method || '';
    if (method.indexOf('Target.') === 0) {
      if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged' || method === 'Target.targetDestroyed') {
        var info = m.params.targetInfo;
        if (method === 'Target.targetDestroyed') {
          delete targets[info.targetId];
          if (selected === info.targetId) { selected = null; haveFrame = false; }
        } else if (info.type === 'page') {
          targets[info.targetId] = info;
        }
        if (selected && !targets[selected]) selected = null;
        renderTabs();
        if (!selected) pickDefault();
        if (selected && watchTarget !== selected) watch(selected);
        syncUi();
      }
      return;
    }
    if (method === 'Page.screencastFrame') {
      drawFrame(m.params);
      send('Page.screencastFrameAck', { sessionId: m.params.metadata.frameId });
      return;
    }
    if (method === 'Page.frameNavigated') {
      if (m.params.frame && !m.params.frame.parentId && document.activeElement !== elUrl) {
        elUrl.value = m.params.frame.url || '';
      }
      return;
    }
  }

  function pageTargets() {
    return Object.keys(targets)
      .map(function (k) { return targets[k]; })
      .filter(function (t) { return t.type === 'page'; });
  }

  function pickDefault() {
    var list = pageTargets();
    if (list.length === 0) { selected = null; return; }
    var url = list.map(function (t) { return t.url || ''; });
    var i = url.findIndex(function (u) { return u !== 'about:blank' && u !== ''; });
    selected = (i >= 0 ? list[i] : list[0]).targetId;
  }

  function watch(tid) {
    if (!tid || watchTarget === tid) return;
    watchTarget = tid;
    haveFrame = false;
    ws.send(JSON.stringify({ t: 'watch', targetId: tid }));
  }

  function startCast() {
    send('Page.enable', {});
    send('Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1400, maxHeight: 1400, everyNthFrame: 1 });
  }

  function select(tid) {
    selected = tid;
    haveFrame = false;
    renderTabs(); syncUi(); watch(tid);
  }

  function renderTabs() {
    elTabs.textContent = '';
    pageTargets().forEach(function (t) {
      var b = document.createElement('button');
      b.className = 'tab' + (t.targetId === selected ? ' active' : '');
      var s = document.createElement('span');
      s.className = 't';
      s.textContent = t.title || t.url || '新标签页';
      b.appendChild(s);
      var x = document.createElement('span');
      x.className = 'x'; x.textContent = '×';
      x.onclick = function (e) { e.stopPropagation(); send('Target.closeTarget', { targetId: t.targetId }); };
      b.appendChild(x);
      b.onclick = function () { select(t.targetId); };
      elTabs.appendChild(b);
    });
    var plus = document.createElement('button');
    plus.id = 'newTab'; plus.textContent = '+'; plus.title = '新建空白标签页';
    plus.onclick = function () {
      var id = send('Target.createTarget', { url: 'about:blank' });
      if (id) pending[id] = function (d) {
        if (d.result && d.result.targetId) select(d.result.targetId);
      };
    };
    elTabs.appendChild(plus);
  }

  function syncUi() {
    var t = targets[selected];
    elBlank.classList.toggle('hidden', !!t);
    if (t && document.activeElement !== elUrl) elUrl.value = t.url === 'about:blank' ? '' : (t.url || '');
    elBadge.classList.toggle('hidden', !t);
    elBadge.textContent = control ? '已接管' : '只读';
    elBadge.className = control ? 'control' : '';
    if (t) setMsg('');
    else setMsg(pageTargets().length === 0 ? '暂无标签页——点上方 + 新建，或等智能体打开网页' : '');
  }

  function drawFrame(p) {
    var meta = p.metadata || {};
    var img = new Image();
    img.onload = function () {
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      var w = elCanvas.clientWidth * dpr, h = elCanvas.clientHeight * dpr;
      if (elCanvas.width !== w || elCanvas.height !== h) { elCanvas.width = w; elCanvas.height = h; }
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, w, h);
      scale = Math.min(w / img.width, h / img.height);
      offX = (w - img.width * scale) / 2; offY = (h - img.height * scale) / 2;
      ctx.drawImage(img, offX, offY, img.width * scale, img.height * scale);
      haveFrame = true;
    };
    img.src = 'data:image/jpeg;base64,' + p.data;
  }

  function toDev(e) {
    var r = elCanvas.getBoundingClientRect();
    var x = (e.clientX - r.left) * (elCanvas.width / r.width);
    var y = (e.clientY - r.top) * (elCanvas.height / r.height);
    return { x: (x - offX) / scale, y: (y - offY) / scale };
  }

  function input(method, params) {
    if (!control) return;
    if (!watchTarget) { setMsg('没有正在观看的标签页'); return; }
    send(method, params);
  }

  elCanvas.addEventListener('mousedown', function (e) {
    var p = toDev(e);
    input('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
  });
  elCanvas.addEventListener('mouseup', function (e) {
    var p = toDev(e);
    input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
  });
  elCanvas.addEventListener('mousemove', function (e) {
    if (!control) return;
    var p = toDev(e);
    send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: e.buttons || 0 });
  });
  elCanvas.addEventListener('wheel', function (e) {
    var p = toDev(e);
    input('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY });
    e.preventDefault();
  }, { passive: false });

  var touchStart = null;
  elCanvas.addEventListener('touchstart', function (e) {
    var t = e.touches[0]; touchStart = { x: t.clientX, y: t.clientY, moved: false };
    var p = toDev(t);
    input('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 1 });
    e.preventDefault();
  }, { passive: false });
  elCanvas.addEventListener('touchmove', function (e) {
    if (!touchStart) return;
    var t = e.touches[0];
    if (Math.abs(t.clientX - touchStart.x) + Math.abs(t.clientY - touchStart.y) > 10) touchStart.moved = true;
    var p = toDev(t);
    send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, buttons: 1 });
    e.preventDefault();
  }, { passive: false });
  elCanvas.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    var p = toDev(t);
    input('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button: 'left', clickCount: 1, buttons: 0 });
    touchStart = null;
    e.preventDefault();
  }, { passive: false });

  var KEYMAP = { Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 };
  document.addEventListener('keydown', function (e) {
    if (!control || document.activeElement === elUrl) return;
    if (!watchTarget) return;
    var printable = e.key.length === 1;
    var params = { type: 'keyDown', key: e.key, code: e.code };
    if (KEYMAP[e.key]) params.windowsVirtualKeyCode = params.nativeVirtualKeyCode = KEYMAP[e.key];
    if (printable) { params.text = e.key; params.unmodifiedText = e.key; }
    if (e.ctrlKey) params.modifiers = 2;
    if (e.metaKey) params.modifiers = 4;
    send('Input.dispatchKeyEvent', params);
    if (KEYMAP[e.key] || e.key === 'Enter' || e.key === 'Backspace') e.preventDefault();
  });
  document.addEventListener('keyup', function (e) {
    if (!control || document.activeElement === elUrl) return;
    if (!watchTarget) return;
    var params = { type: 'keyUp', key: e.key, code: e.code };
    if (KEYMAP[e.key]) params.windowsVirtualKeyCode = params.nativeVirtualKeyCode = KEYMAP[e.key];
    send('Input.dispatchKeyEvent', params);
  });

  elMode.onclick = function () {
    control = !control;
    elMode.textContent = control ? '接管中' : '只读';
    elMode.className = control ? 'control' : '';
    syncUi();
  };
  elUrl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    var v = elUrl.value.trim();
    if (!v) return;
    if (!/^[a-z][a-z0-9+.-]*:\\/\\//i.test(v)) v = 'http://' + v;
    if (!watchTarget) { setMsg('没有选中标签页——先点 + 新建一个'); return; }
    send('Page.navigate', { url: v });
    elUrl.blur();
  });

  window.addEventListener('resize', function () {});

  connect();
})();
</script>
</body>
</html>`;

export default class LiveNavGetRoute extends HTTPRoute {
  name = 'LiveNavGetRoute';
  accepts = [contentTypes.any];
  auth = false;
  browser = null;
  concurrency = false;
  contentTypes = [contentTypes.html];
  description = `Serves the LAN live browser shell (tab strip, URL bar, live screencast).`;
  method = Methods.get;
  path = ['/nav', '/nav/'];
  tags = [APITags.management];
  async handler(_req: Request, res: ServerResponse): Promise<void> {
    return writeResponse(res, 200, PAGE_HTML, contentTypes.html);
  }
}
