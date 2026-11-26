// The two windows' only way to talk to the app: a few named messages, nothing else from Node.

import { contextBridge, ipcRenderer } from 'electron';

const page = new URL(location.href).pathname.split('/').pop();

if (page === 'recorder.html') {
  contextBridge.exposeInMainWorld('relay', {
    onStart: (cb: () => void) => ipcRenderer.on('rec:start', () => cb()),
    onStop: (cb: (keep: boolean) => void) => ipcRenderer.on('rec:stop', (_e, keep: boolean) => cb(keep)),
    level: (value: number) => ipcRenderer.send('rec:level', value),
    audio: (samples: ArrayBuffer | null) => ipcRenderer.send('rec:audio', samples),
    error: (message: string) => ipcRenderer.send('rec:error', message),
  });
} else {
  contextBridge.exposeInMainWorld('relay', {
    onState: (cb: (state: unknown) => void) => ipcRenderer.on('hud:state', (_e, state) => cb(state)),
    onLevel: (cb: (level: number) => void) => ipcRenderer.on('hud:level', (_e, level: number) => cb(level)),
  });
}
