// Relay for Windows — the dictation edition. Hold Ctrl + Win, talk, let go: your words land where
// you're typing, cleaned up the way Relay always does. Everything runs on this PC: the speech
// engine is whisper.cpp, nothing is sent anywhere.
//
//   hold.ts     when a hold starts, ends, or turns out to be a shortcut
//   recorder    a hidden window with the mic (only open while you hold)
//   whisper.ts  the speech engine, kept warm
//   support.ts  Relay's cleanup (the Mac's very code), the log, settings
//   paste.ts    the words into the app you're in, your clipboard put back
//   hud         the black pill at the top of the screen

import { app, BrowserWindow, clipboard, ClipboardItem, ipcMain, Menu, nativeImage, screen, session, shell, Tray } from 'electron';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { uIOhook, UiohookKey } from 'uiohook-napi';
import { Hold, type HoldKey } from './hold.js';
import type { HudState } from './hud.js';
import { download, MODELS, present, type ModelId } from './models.js';
import { pasteText } from './paste.js';
import { clean, Log, SettingsFile } from './support.js';
import { hasSpeech, SAMPLE_RATE, wavFromSamples } from './wav.js';
import { SpeechEngine } from './whisper.js';

const isWin = process.platform === 'win32';
const smoke = process.argv.includes('--smoke');
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

app.setName('Relay');
if (!smoke && !app.requestSingleInstanceLock()) app.exit(0);

let log: Log;
let settings: SettingsFile;
let engine: SpeechEngine;
let hud: BrowserWindow;
let recorder: BrowserWindow;
let tray: Tray | undefined;
let engineNote = 'Starting the speech engine…';
let downloading: number | undefined;

// --- where things are -----------------------------------------------------------------------

function engineFiles(): { exe: string; cwd: string } {
  const own = process.env.RELAY_ENGINE;
  if (own) return { exe: own, cwd: path.dirname(own) };
  if (app.isPackaged) {
    const dir = path.join(process.resourcesPath, 'engine');
    return { exe: path.join(dir, isWin ? 'whisper-server.exe' : 'whisper-server'), cwd: dir };
  }
  // Developing on a Mac: the Mac app's build of the same server.
  const mac = path.join(__dirname, '../../mac/Vendor/whisper-build/bin/whisper-server');
  return { exe: mac, cwd: path.dirname(mac) };
}

function modelFile(id: ModelId): string {
  if (id === 'fast') {
    if (process.env.RELAY_MODEL) return process.env.RELAY_MODEL;
    return app.isPackaged
      ? path.join(process.resourcesPath, 'models', MODELS.fast.file)
      : path.join(__dirname, '..', 'models', MODELS.fast.file);
  }
  return path.join(app.getPath('userData'), 'models', MODELS[id].file);
}

// --- the HUD ----------------------------------------------------------------------------------

const HUD = { width: 480, height: 90 };
let hideTimer: NodeJS.Timeout | undefined;

function makeWindows(): void {
  const webPreferences = {
    preload: path.join(__dirname, 'preload.cjs'),
    contextIsolation: true,
    sandbox: true,
    backgroundThrottling: false,
    offscreen: smoke, // smoke runs draw the HUD without putting it on your screen
  };
  hud = new BrowserWindow({
    ...HUD,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false, // it must never take focus from the app you're typing in
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    backgroundColor: '#00000000',
    webPreferences,
  });
  hud.setAlwaysOnTop(true, 'screen-saver');
  hud.setIgnoreMouseEvents(true);
  void hud.loadFile(path.join(__dirname, 'hud.html'));

  recorder = new BrowserWindow({ show: false, width: 120, height: 60, skipTaskbar: true, webPreferences: { ...webPreferences, offscreen: false } });
  void recorder.loadFile(path.join(__dirname, 'recorder.html'));
}

function showHud(state: HudState, hideAfterMs?: number): void {
  clearTimeout(hideTimer);
  if (state.kind === 'hidden') {
    hud.webContents.send('hud:state', state);
    hideTimer = setTimeout(() => hud.hide(), 260);
    return;
  }
  if (!hud.isVisible() && !smoke) {
    // the top of whichever screen your pointer is on; Windows' taskbar is usually at the bottom
    const { x, y, width } = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).bounds;
    hud.setBounds({ x: Math.round(x + width / 2 - HUD.width / 2), y, ...HUD });
    hud.showInactive();
  }
  hud.webContents.send('hud:state', state);
  if (hideAfterMs) hideTimer = setTimeout(() => showHud({ kind: 'hidden' }), hideAfterMs);
}

// --- the mic ----------------------------------------------------------------------------------

let audioWaiter: ((samples: Float32Array | null) => void) | undefined;
let micProblem: string | undefined;

function samplesFrom(data: unknown): Float32Array | null {
  if (data instanceof ArrayBuffer) return new Float32Array(data);
  if (ArrayBuffer.isView(data)) return new Float32Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
  return null;
}

function wireRecorder(): void {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => done(permission === 'media'));
  session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media');
  ipcMain.on('rec:audio', (_e, data) => {
    audioWaiter?.(samplesFrom(data));
    audioWaiter = undefined;
  });
  ipcMain.on('rec:level', (_e, level: number) => hud.webContents.send('hud:level', level));
  ipcMain.on('rec:error', (_e, message: string) => {
    micProblem = message;
    log.line(`mic: ${message}`);
  });
}

function startRecording(): void {
  micProblem = undefined;
  recorder.webContents.send('rec:start');
}

function stopRecording(keep: boolean): Promise<Float32Array | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      audioWaiter = undefined;
      resolve(null);
    }, 4000);
    audioWaiter = (samples) => {
      clearTimeout(timer);
      resolve(samples);
    };
    recorder.webContents.send('rec:stop', keep);
  });
}

function micHelp(problem: string): string {
  if (/NotAllowed|Permission/i.test(problem)) return 'Windows blocked the mic — Settings › Privacy › Microphone';
  if (/NotFound|DevicesNotFound/i.test(problem)) return 'No microphone found';
  return 'The mic didn’t start — see the log';
}

// --- dictation --------------------------------------------------------------------------------

let busy = false;
let tooLong: NodeJS.Timeout | undefined;

const hold = new Hold((e) => {
  if (e.type === 'arm') {
    if (busy) {
      hold.abandon();
      showHud({ kind: 'says', text: 'Still writing the last one…' }, 1400);
      return;
    }
    // Windows opens the Start menu when Win comes up untouched; a key pressed meanwhile keeps
    // it shut. F24 is that key: no keyboard has one, and nothing listens for it.
    if (isWin) uIOhook.keyTap(UiohookKey.F24);
    startRecording();
    showHud({ kind: 'listening' });
    tooLong = setTimeout(() => {
      hold.abandon();
      void finish();
    }, 5 * 60_000);
  } else if (e.type === 'cancel') {
    clearTimeout(tooLong);
    void stopRecording(false);
    showHud({ kind: 'hidden' });
  } else {
    clearTimeout(tooLong);
    void finish();
  }
});

async function finish(): Promise<void> {
  busy = true;
  try {
    await sleep(120); // the last syllable is still in the air as the keys come up
    const samples = await stopRecording(true);
    if (!samples) {
      showHud({ kind: 'says', text: micProblem ? micHelp(micProblem) : 'The mic didn’t answer', warn: true }, 4500);
      return;
    }
    if (!hasSpeech(samples)) {
      showHud({ kind: 'says', text: 'Didn’t catch that — hold Ctrl + Win and talk' }, 2000);
      return;
    }
    showHud({ kind: 'thinking' });
    const started = Date.now();
    const text = clean(await engine.transcribe(wavFromSamples(samples), settings.value.script));
    // lengths and timings only — never what you said
    log.line(`dictation: ${(samples.length / SAMPLE_RATE).toFixed(1)} s → ${text.length} characters in ${Date.now() - started} ms`);
    if (!text) {
      showHud({ kind: 'says', text: 'Didn’t catch that — hold Ctrl + Win and talk' }, 2000);
      return;
    }
    const how = await pasteText(text, {
      clipboard: clipboard as never,
      item: (record) => new ClipboardItem(record as ConstructorParameters<typeof ClipboardItem>[0]) as never,
      pressPaste: () => uIOhook.keyTap(UiohookKey.V, [isWin ? UiohookKey.Ctrl : UiohookKey.Meta]),
      keysReleased: async (timeoutMs) => {
        for (let waited = 0; waited < timeoutMs; waited += 25) {
          if (hold.released) return true;
          await sleep(25);
        }
        return hold.released;
      },
      wait: sleep,
    });
    showHud(how === 'pasted' ? { kind: 'done' } : { kind: 'says', text: 'Copied — press Ctrl + V' }, how === 'pasted' ? 900 : 2800);
  } catch (err) {
    log.line(`dictation failed: ${(err as Error).stack ?? err}`);
    showHud({ kind: 'says', text: `Couldn’t write that — ${(err as Error).message}`, warn: true }, 4500);
  } finally {
    busy = false;
  }
}

function keyOf(code: number): HoldKey | 'ours' {
  if (code === UiohookKey.Ctrl || code === UiohookKey.CtrlRight) return 'ctrl';
  if (code === UiohookKey.Meta || code === UiohookKey.MetaRight) return 'win';
  if (code === UiohookKey.F24) return 'ours'; // the Start-menu guard coming back to us
  return 'other';
}

function startKeyboard(): void {
  uIOhook.on('keydown', (e) => {
    const key = keyOf(e.keycode);
    if (key !== 'ours') hold.down(key, Date.now());
  });
  uIOhook.on('keyup', (e) => {
    const key = keyOf(e.keycode);
    if (key !== 'ours') hold.up(key, Date.now());
  });
  uIOhook.start();
}

// --- the tray ---------------------------------------------------------------------------------

function trayIcon(): Electron.NativeImage {
  const file = path.join(__dirname, 'assets', isWin ? 'tray.ico' : 'tray.png');
  return existsSync(file) ? nativeImage.createFromPath(file) : nativeImage.createEmpty();
}

function refreshTray(): void {
  if (!tray) return;
  const chosen = settings.value.model;
  tray.setToolTip(downloading !== undefined ? `Relay — downloading ${Math.round(downloading * 100)}%` : 'Relay — hold Ctrl + Win and talk');
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Hold Ctrl + Win and talk', enabled: false },
      { label: engineNote, enabled: false },
      { type: 'separator' },
      {
        label: 'Speech',
        submenu: [
          { label: `${MODELS.fast.label} — good for most`, type: 'radio', checked: chosen === 'fast', click: () => void useModel('fast') },
          {
            label: downloading !== undefined ? `${MODELS.accurate.label} — downloading ${Math.round(downloading * 100)}%` : `${MODELS.accurate.label} — slower, 574 MB download`,
            type: 'radio',
            checked: chosen === 'accurate',
            click: () => void useModel('accurate'),
          },
        ],
      },
      {
        label: 'Hindi',
        submenu: [
          { label: 'In English letters — kal milte hain', type: 'radio', checked: settings.value.script === 'latin', click: () => settings.update({ script: 'latin' }) },
          { label: 'In Devanagari — कल मिलते हैं', type: 'radio', checked: settings.value.script === 'devanagari', click: () => settings.update({ script: 'devanagari' }) },
        ],
      },
      {
        label: 'Start with Windows',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
      },
      { label: 'Open the log folder', click: () => void shell.openPath(path.dirname(log.file)) },
      { type: 'separator' },
      { label: 'Quit Relay', click: () => app.quit() },
    ]),
  );
}

async function useModel(id: ModelId): Promise<void> {
  if (downloading !== undefined) return;
  const file = modelFile(id);
  try {
    if (!(await present(file, MODELS[id].bytes))) {
      downloading = 0;
      refreshTray();
      showHud({ kind: 'says', text: `Downloading the ${MODELS[id].label.toLowerCase()} model…` }, 2500);
      let lastShown = 0;
      await download(MODELS[id], file, (f) => {
        downloading = f;
        if (f - lastShown >= 0.05) {
          lastShown = f;
          refreshTray();
        }
      });
    }
    engineNote = 'Switching the speech engine…';
    downloading = undefined;
    refreshTray();
    await engine.start(file);
    settings.update({ model: id });
    engineNote = `Ready — ${MODELS[id].label.toLowerCase()} speech`;
    showHud({ kind: 'says', text: `Now using ${MODELS[id].label.toLowerCase()} speech` }, 2200);
  } catch (err) {
    log.line(`model ${id}: ${(err as Error).message}`);
    showHud({ kind: 'says', text: `Couldn’t switch — ${(err as Error).message}`, warn: true }, 4500);
    await engine.start(modelFile(settings.value.model)).catch(() => undefined);
  } finally {
    downloading = undefined;
    refreshTray();
  }
}

// --- smoke run (developers): the real pipeline on a recording, no keyboard, no screen ---------

function readWav(file: string): Float32Array {
  const buf = readFileSync(file);
  let at = 12;
  while (at < buf.length - 8) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const out = new Float32Array(size / 2);
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(at + 8 + i * 2) / 0x8000;
      return out;
    }
    at += 8 + size;
  }
  throw new Error('no audio in that file');
}

async function runSmoke(): Promise<void> {
  const out = process.env.RELAY_SMOKE_OUT ?? path.join(os.tmpdir(), 'relay-smoke');
  mkdirSync(out, { recursive: true });
  const result: Record<string, unknown> = {};
  try {
    const t0 = Date.now();
    await engine.start();
    result.engineMs = Date.now() - t0;
    for (const wav of (process.env.RELAY_SMOKE_WAV ?? '').split(',').filter(Boolean)) {
      const samples = readWav(wav);
      const t1 = Date.now();
      const heard = await engine.transcribe(wavFromSamples(samples), 'latin');
      const devanagari = await engine.transcribe(wavFromSamples(samples), 'devanagari');
      result[path.basename(wav)] = { written: clean(heard), devanagari: clean(devanagari), seconds: samples.length / SAMPLE_RATE, ms: Date.now() - t1 };
    }
    const states: [string, HudState][] = [
      ['listening', { kind: 'listening' }],
      ['thinking', { kind: 'thinking' }],
      ['done', { kind: 'done' }],
      ['ready', { kind: 'says', text: 'Relay is ready — hold Ctrl + Win and talk' }],
      ['warn', { kind: 'says', text: 'Windows blocked the mic — Settings › Privacy › Microphone', warn: true }],
    ];
    for (const [name, state] of states) {
      hud.webContents.send('hud:state', state);
      for (let i = 0; i < 12; i++) {
        if (name === 'listening') hud.webContents.send('hud:level', 0.05 + 0.04 * Math.sin(i));
        await sleep(60);
      }
      writeFileSync(path.join(out, `hud-${name}.png`), (await hud.webContents.capturePage()).toPNG());
    }
    result.hud = out;
  } catch (err) {
    result.error = (err as Error).stack ?? String(err);
  }
  console.log(`RELAY_SMOKE ${JSON.stringify(result)}`);
  engine.stop();
  app.exit(result.error ? 1 : 0);
}

// --- start ------------------------------------------------------------------------------------

app.on('second-instance', () => showHud({ kind: 'says', text: 'Relay is already running — hold Ctrl + Win and talk' }, 3000));
app.on('window-all-closed', () => undefined); // a tray app keeps running with no windows open
app.on('before-quit', () => {
  try {
    uIOhook.stop();
  } catch {
    /* not started */
  }
  engine?.stop();
});

void app.whenReady().then(async () => {
  if (isWin) app.setAppUserModelId('com.relay.windows');
  log = new Log(path.join(app.getPath('userData'), 'logs'));
  settings = new SettingsFile(app.getPath('userData'));
  const cpu = os.cpus();
  log.line(`Relay ${app.getVersion()} · ${os.type()} ${os.release()} · ${cpu[0]?.model ?? 'cpu'} ×${cpu.length} · ${Math.round(os.totalmem() / 1e9)} GB`);
  makeWindows();
  wireRecorder();

  let model = settings.value.model;
  if (!(await present(modelFile(model), MODELS[model].bytes))) model = 'fast';
  engine = new SpeechEngine({ ...engineFiles(), model: modelFile(model), log: (l) => log.line(l) });
  await new Promise<void>((r) => hud.webContents.once('did-finish-load', () => r()));
  if (smoke) return runSmoke();

  tray = new Tray(trayIcon());
  refreshTray();
  engine.start().then(
    () => {
      engineNote = `Ready — ${MODELS[model].label.toLowerCase()} speech`;
      refreshTray();
    },
    (err: Error) => {
      engineNote = `Speech engine: ${err.message}`;
      refreshTray();
      showHud({ kind: 'says', text: `Relay can’t listen yet — ${err.message}`, warn: true }, 8000);
    },
  );
  try {
    startKeyboard();
  } catch (err) {
    log.line(`keyboard: ${(err as Error).stack}`);
    showHud({ kind: 'says', text: 'Relay can’t see the keyboard — see the log', warn: true }, 8000);
  }
  if (!settings.value.welcomed) {
    settings.update({ welcomed: true });
    // A background helper you'd want after a restart; the tray menu turns it off.
    if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    showHud({ kind: 'says', text: 'Relay is ready — hold Ctrl + Win and talk' }, 6000);
  }
});
