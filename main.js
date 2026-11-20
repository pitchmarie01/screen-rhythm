// main.js — Screen Rhythm (Electron main process)
//
// Responsibilities:
//   1. Load PRESAGE_API_KEY from .env (never logged, never sent to the window).
//   2. Create the app window with our preload bridge (dist/preload.bundle.js).
//   3. Run SmartSpectra here in the main process with the official custom-input
//      API (useCustomInput + sendFrame); see src/engine-main.js. Camera frames
//      come from a Web Worker in the window (src/frame-worker.js).
//   4. Grant camera-only access, and only to our own local page.

'use strict';

const path = require('path');
const { pathToFileURL } = require('url');
const { app, BrowserWindow, session, ipcMain, shell, Notification } = require('electron');

let mainWindow = null;

// Windows needs an app identity for notifications to appear.
if (process.platform === 'win32') app.setAppUserModelId('com.screenrhythm.app');

// Load .env from the project folder. `quiet: true` stops dotenv printing its
// startup banner. The key value itself is never printed by this app.
require('dotenv').config({ path: path.join(__dirname, '.env'), quiet: true });

const fs = require('fs');

// Load the official SmartSpectra SDK. If its native engine cannot load (for
// example, a missing Windows system component), keep the app running and
// explain the problem in the UI instead of crashing.
let sdkModule = null;
let engineError = null;
try {
    sdkModule = require('@smartspectra/node-sdk');
} catch (err) {
    engineError = describeEngineError(err);
    console.error(`[screen-rhythm] SmartSpectra engine failed to load: ${err && err.message}`);
}

function describeEngineError(err) {
    const msg = (err && err.message) || String(err);
    if (process.platform === 'win32') {
        const sys32 = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
        if (!fs.existsSync(path.join(sys32, 'vcruntime140_threads.dll'))) {
            return {
                reason: 'vcredist',
                detail: 'VCRUNTIME140_THREADS.dll is missing (Microsoft Visual C++ Redistributable is out of date).',
            };
        }
    }
    return { reason: 'other', detail: msg };
}

const INDEX_FILE = path.join(__dirname, 'index.html');
const INDEX_URL = pathToFileURL(INDEX_FILE).href;
const DIAGNOSTICS = process.env.SMARTSPECTRA_DIAGNOSTICS === '1';

// Only our own bundled page may use the engine or the camera.
function isTrustedSender(frame) {
    if (!frame || typeof frame.url !== 'string') return false;
    return frame.url.split('#')[0].split('?')[0] === INDEX_URL;
}

const { createEngine } = require('./src/engine-main');
const engine = sdkModule ? createEngine({
    sdkModule,
    isTrustedSender,
    getApiKey: () => (process.env.PRESAGE_API_KEY || '').trim(),
}) : null;

function createWindow() {
    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 980,
        minHeight: 680,
        title: 'Screen Rhythm',
        backgroundColor: '#0a0f1e',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
            // Screen Rhythm's preload bridge, bundled by esbuild.
            preload: path.join(__dirname, 'dist', 'preload.bundle.js'),
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            // Screen Rhythm keeps measuring while you work in other windows.
            // Without this, Chromium throttles a background/covered window,
            // which can starve the camera frame pump.
            backgroundThrottling: false,
        },
    });

    // SmartSpectra session + frame port for this window (auto-teardown on close).
    if (engine) engine.attachWindow(win);

    // This app only ever shows its own local page. Block popups and navigation
    // so the window can never be steered to remote content.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (event) => event.preventDefault());

    win.once('ready-to-show', () => win.show());
    win.loadFile(INDEX_FILE);
    mainWindow = win;
    win.on('closed', () => { if (mainWindow === win) mainWindow = null; });
    win.on('focus', () => { try { win.flashFrame(false); } catch { /* ignore */ } });

    if (DIAGNOSTICS) win.webContents.openDevTools({ mode: 'detach' });
}

// --- Screen Rhythm IPC -------------------------------------------------------

// Lets the UI know whether the SmartSpectra engine loaded.
ipcMain.handle('screen-rhythm:get-engine-status', (event) => {
    if (!isTrustedSender(event.senderFrame)) return { ok: false, reason: 'other', detail: '' };
    return engineError ? { ok: false, ...engineError } : { ok: true };
});

// Opens Windows camera privacy settings (only this exact, fixed URI).
// Gentle break reminder when Screen Rhythm is behind other windows: flash the
// taskbar button and show one silent Windows notification. Nothing is sent
// anywhere; the notification is local to this computer.
ipcMain.handle('screen-rhythm:notify-break', (event, payload) => {
    if (!isTrustedSender(event.senderFrame)) return false;
    const win = mainWindow;
    if (!win || win.isDestroyed() || win.isFocused()) return false;
    const clip = (s, n) => (typeof s === 'string' ? s.slice(0, n) : '');
    const title = clip(payload && payload.title, 80) || 'Time for a little screen break?';
    const body = clip(payload && payload.body, 200);
    try { win.flashFrame(true); } catch { /* ignore */ }
    if (Notification.isSupported()) {
        const n = new Notification({ title, body, silent: true });
        n.on('click', () => {
            if (win.isDestroyed()) return;
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
        });
        n.show();
    }
    return true;
});

ipcMain.handle('screen-rhythm:open-camera-settings', async (event) => {
    if (!isTrustedSender(event.senderFrame)) return false;
    if (process.platform !== 'win32') return false;
    await shell.openExternal('ms-settings:privacy-webcam');
    return true;
});

// --- App lifecycle -------------------------------------------------------------

app.whenReady().then(() => {
    // Grant ONLY the camera (video, no microphone) and ONLY to our own page.
    session.defaultSession.setPermissionRequestHandler((wc, permission, callback, details) => {
        const url = ((details && details.requestingUrl) || (wc && wc.getURL()) || '').split('#')[0];
        const mediaTypes = (details && details.mediaTypes) || [];
        const cameraOnly = mediaTypes.length === 1 && mediaTypes[0] === 'video';
        callback(permission === 'media' && cameraOnly && url === INDEX_URL);
    });

    createWindow();

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});
