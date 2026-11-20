// src/preload.js: Screen Rhythm preload script
//
// Bundled by esbuild into dist/preload.bundle.js (sandboxed preloads can only
// load 'electron' and a few built-ins).
//
// Exposes `window.screenRhythm`:
//   - engine control (start/stop SmartSpectra in the main process)
//   - engine events (status, validation, metrics, errors, frameSentThrough)
//   - a frame MessagePort for the camera worker (delivered via window.postMessage,
//     because MessagePorts cannot cross contextBridge directly)
// The API key is NOT exposed: it stays in the main process.

'use strict';

const { contextBridge, ipcRenderer } = require('electron');

let engineListener = null;
ipcRenderer.on('sr:engine-event', (_event, msg) => {
    if (engineListener) engineListener(msg);
});

contextBridge.exposeInMainWorld('screenRhythm', {
    /** Start SmartSpectra (main process). Resolves { ok, ... }. */
    engineStart: (options) => ipcRenderer.invoke('sr:engine-start', options),
    /** Stop SmartSpectra and release the session. */
    engineStop: () => ipcRenderer.invoke('sr:engine-stop'),
    /** Register the single listener for SmartSpectra events. */
    onEngineEvent: (callback) => { engineListener = typeof callback === 'function' ? callback : null; },
    /**
     * Create a frame channel: one end goes to the main process, the other is
     * posted to this page as window message { type: 'sr-frame-port' }.
     */
    openFramePort: () => {
        const channel = new MessageChannel();
        ipcRenderer.postMessage('sr:frame-port', null, [channel.port2]);
        window.postMessage({ type: 'sr-frame-port' }, '*', [channel.port1]);
    },
    /** Returns { ok } or { ok: false, reason, detail } for the SmartSpectra engine. */
    getEngineStatus: () => ipcRenderer.invoke('screen-rhythm:get-engine-status'),
    /** Flashes the taskbar + shows one silent notification if the window isn't focused. */
    notifyBreak: (payload) => ipcRenderer.invoke('screen-rhythm:notify-break', payload),
    /** Opens Windows Settings → Privacy & security → Camera. */
    openCameraSettings: () => ipcRenderer.invoke('screen-rhythm:open-camera-settings'),
    platform: process.platform,
});
