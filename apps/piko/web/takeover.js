// The takeover page, in the phone's browser (LINE's own when it is set up as LIFF). It shows Piko's computer
// through noVNC, lets the person tap and type on it, and hands it back. The server (src/takeover-http.ts)
// checks everything; this page only asks.
import RFB from '/takeover/novnc/core/rfb.js';
import KeyTable from '/takeover/novnc/core/input/keysym.js';
import keysyms from '/takeover/novnc/core/input/keysymdef.js';
import { initLogging } from '/takeover/novnc/core/util/logging.js';

// noVNC logs each key it sends at its "info" level. Keep it to errors, so nothing typed ends up in a console.
initLogging('error');

const $ = (id) => document.getElementById(id);
const liffId = document.body.dataset.liffId;
let rfb;
let expiresAt = 0;
let finished = false;

function inLine() {
  return Boolean(liffId && window.liff?.isInClient());
}

function showMessage(title, body) {
  $('controls').hidden = true;
  $('screen').hidden = true;
  $('message').hidden = false;
  $('message-title').textContent = title;
  $('message-body').textContent = body;
}

const forever = () => new Promise(() => {});

/**
 * With LIFF, LINE vouches for who is holding the phone. Without it, the single-use ticket is all there is.
 * LIFF opens the page twice: first at the bare endpoint with our query folded into `liff.state` (and the
 * user's access token attached), then, from init(), at the real address with `?t=`. Nothing may touch the
 * address before init() is done, and the first load must not act at all.
 */
async function lineIdToken() {
  if (!liffId) return undefined;
  await window.liff.init({ liffId });
  if (new URLSearchParams(location.search).has('liff.state')) await forever(); // init() is moving to the real address
  if (!window.liff.isLoggedIn()) {
    window.liff.login({ redirectUri: location.href });
    await forever(); // leaving for LINE Login; it comes back to this address
  }
  return window.liff.getIDToken() ?? undefined;
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    // The second header only matters behind ngrok's free plan, which otherwise answers with a warning page.
    headers: { 'content-type': 'application/json', 'ngrok-skip-browser-warning': '1' },
    body: JSON.stringify(body ?? {}),
  });
  return { ok: res.ok, data: await res.json().catch(() => ({})) };
}

function tick() {
  if (finished) return;
  const minutes = Math.round((expiresAt - Date.now()) / 60_000);
  $('status').textContent = minutes > 0 ? `還有約 ${minutes} 分鐘` : '時間快到了';
  setTimeout(tick, 15_000);
}

function connect() {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  rfb = new RFB($('screen'), `${scheme}://${location.host}/takeover/ws`, { shared: true });
  rfb.scaleViewport = true;
  rfb.resizeSession = false;
  rfb.qualityLevel = 6;
  rfb.compressionLevel = 2;
  rfb.showDotCursor = true;
  rfb.focusOnClick = false; // typing goes through the box below, which brings up the phone's keyboard
  rfb.addEventListener('connect', tick);
  rfb.addEventListener('disconnect', () => {
    if (!finished) showMessage('連線結束了', '時間到了，或連線斷了。回到 LINE 跟 Piko 說一聲就好。');
  });
}

/** One character as an X keysym: Latin-1 maps to itself, everything else to its Unicode keysym. */
function keysymFor(char) {
  return char === '\n' ? KeyTable.XK_Return : keysyms.lookup(char.codePointAt(0));
}

$('typer').addEventListener('submit', (event) => {
  event.preventDefault();
  const input = $('text');
  for (const char of input.value) rfb?.sendKey(keysymFor(char), null);
  input.value = '';
});

$('mask').addEventListener('click', () => {
  const input = $('text');
  input.type = input.type === 'password' ? 'text' : 'password';
  $('mask').textContent = input.type === 'password' ? '🙈' : '👁';
});

for (const button of document.querySelectorAll('[data-key]')) {
  button.addEventListener('click', () => rfb?.sendKey(KeyTable[button.dataset.key], null));
}

// Whole screen, or the real size with drag-to-move (a tap still taps).
$('zoom').addEventListener('click', () => {
  const zoom = rfb.scaleViewport;
  rfb.scaleViewport = !zoom;
  rfb.clipViewport = zoom;
  rfb.dragViewport = zoom;
  $('zoom').textContent = zoom ? '🔍 看全部' : '🔍 放大';
  if (zoom) $('status').textContent = '用手指拖動畫面，點一下就是按下去';
});

$('done').addEventListener('click', async () => {
  $('done').disabled = true;
  finished = true;
  await post('/takeover/done').catch(() => undefined);
  rfb?.disconnect();
  showMessage('完成了 ✅', 'Piko 會接著做，回到 LINE 看結果就好。');
  if (inLine()) setTimeout(() => window.liff.closeWindow(), 1500);
});

$('back').addEventListener('click', (event) => {
  if (!inLine()) return;
  event.preventDefault();
  window.liff.closeWindow();
});

// LINE keeps a snapshot of a closed LIFF page in its recent list; blank the screen whenever the page is hidden.
document.addEventListener('visibilitychange', () => {
  $('screen').style.visibility = document.visibilityState === 'hidden' ? 'hidden' : 'visible';
});
window.addEventListener('pagehide', () => {
  $('screen').style.visibility = 'hidden';
});

async function start() {
  let idToken;
  try {
    idToken = await lineIdToken();
  } catch {
    showMessage('打不開', '請從 LINE 裡 Piko 傳的按鈕打開這個畫面。');
    return;
  }
  // Read only now: with LIFF, the ticket is in the address only after init() has moved the page there.
  const ticket = new URLSearchParams(location.search).get('t') ?? undefined;
  history.replaceState(null, '', '/takeover'); // the ticket leaves the address bar and the history
  // The screen is made to the size of the space it gets here, so a phone gets a phone-shaped screen.
  const area = $('screen').getBoundingClientRect();
  const opened = await post('/takeover/open', { ticket, idToken, width: Math.round(area.width), height: Math.round(area.height) });
  if (!opened.ok) {
    showMessage('打不開', opened.data.error ?? '請回到 LINE 再試一次。');
    return;
  }
  $('reason').textContent = opened.data.reason ?? '';
  expiresAt = opened.data.expiresAt ?? 0;
  connect();
}

start().catch(() => showMessage('打不開', '請回到 LINE 再試一次。'));
