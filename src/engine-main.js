// src/engine-main.js: SmartSpectra in the Electron main process.
//
// Uses the official main-process SDK custom-input path:
//   sdk.useCustomInput(FrameTransform.kNone); sdk.start();
//   sdk.sendFrame(buffer, width, height, strideBytes, pixelFormat, timestampUs);
// Frames arrive from src/frame-worker.js over a dedicated MessagePort.
// SDK events are forwarded to the window as 'sr:engine-event' messages.
//
// The API key stays in this process: it is read from .env and passed straight
// to the SDK constructor. It is never sent to the window and never logged.
// Telemetry is disabled here.

'use strict';

const { ipcMain } = require('electron');

// PixelFormat values accepted from the worker: kRGBA (2), kBGRA (3), kNV12 (4).
const ALLOWED_PIXEL_FORMATS = new Set([2, 3, 4]);
const PF_NV12 = 4;
const MAX_DIM = 4096;
const LOG_EVERY = 30;

function createEngine({ sdkModule, isTrustedSender, getApiKey, logger = console }) {
    const { SmartSpectraSDK, FrameTransform } = sdkModule;
    let win = null;
    let sdk = null;
    let port = null;
    let framesSent = 0;
    let framesRejected = 0;

    const fromOurWindow = (event) =>
        win && !win.isDestroyed() && event.sender === win.webContents && isTrustedSender(event.senderFrame);

    function emit(msg) {
        if (win && !win.isDestroyed()) win.webContents.send('sr:engine-event', msg);
    }

    async function teardown() {
        const old = sdk;
        sdk = null;
        if (!old) return;
        try { await old.stopAsync(); } catch { /* already stopped */ }
        try { await old.destroy(); } catch { /* already destroyed */ }
    }

    function closePort() {
        if (port) {
            try { port.close(); } catch { /* already closed */ }
            port = null;
        }
    }

    function onFrame(data) {
        if (!data || data.kind !== 'frame') return;
        try {
            if (!sdk) return;   // no session running: frame is simply not used
            const width = data.width | 0;
            const height = data.height | 0;
            const stride = data.stride | 0;
            const pixelFormat = data.pixelFormat | 0;
            const buf = data.buffer;
            const expected = pixelFormat === PF_NV12 ? (stride * height * 3) / 2 : stride * height;
            if (width <= 0 || height <= 0 || width > MAX_DIM || height > MAX_DIM ||
                !ALLOWED_PIXEL_FORMATS.has(pixelFormat) || !buf || typeof buf.byteLength !== 'number' ||
                buf.byteLength < expected) {
                framesRejected++;
                return;
            }
            sdk.sendFrame(Buffer.from(buf, 0, expected), width, height, stride, pixelFormat, data.timestampUs);
            framesSent++;
        } catch (e) {
            framesRejected++;
            if (framesRejected === 1 || framesRejected % LOG_EVERY === 0) {
                logger.warn(`[screen-rhythm] SmartSpectra rejected a frame (${framesRejected} total): ${e && e.message}`);
            }
        } finally {
            // Let the worker know this frame is done so it can send the next.
            if (port) {
                try { port.postMessage({ kind: 'ack', seq: data.seq }); } catch { /* port closed */ }
            }
        }
    }

    // The window hands us one end of a MessageChannel for frames.
    ipcMain.on('sr:frame-port', (event) => {
        if (!fromOurWindow(event)) return;
        const p = event.ports && event.ports[0];
        if (!p) return;
        closePort();
        port = p;
        port.on('message', (ev) => onFrame(ev.data));
        port.start();
    });

    ipcMain.handle('sr:engine-start', async (event, opts) => {
        if (!fromOurWindow(event)) return { ok: false, reason: 'untrusted' };
        const apiKey = getApiKey();
        if (!apiKey) return { ok: false, reason: 'no-key' };
        await teardown();

        const requested = Array.isArray(opts && opts.requestedMetrics)
            ? opts.requestedMetrics.filter((n) => Number.isInteger(n) && n >= 0 && n < 64).slice(0, 16)
            : undefined;

        const s = new SmartSpectraSDK({
            apiKey,
            requestedMetrics: requested,
            enableTelemetry: false,
            enableAccumulatedOutput: false,
        });
        s.on('processingStatus', (status) => emit({ kind: 'processingStatus', status }));
        s.on('validationStatus', (code, ts, hint) => emit({ kind: 'validationStatus', code, timestampUs: ts, hint }));
        s.on('metrics', (buf, ts) => emit({ kind: 'metrics', buffer: new Uint8Array(buf), timestampUs: ts }));
        s.on('error', (code, message, retryable) => emit({ kind: 'error', code, message, retryable }));
        s.on('frameSentThrough', (sent, ts) => emit({ kind: 'frameSentThrough', sent, timestampUs: ts }));

        try {
            s.useCustomInput(FrameTransform.kNone);
            s.start();
        } catch (e) {
            try { await s.destroy(); } catch { /* ignore */ }
            return {
                ok: false,
                code: typeof e.code === 'number' ? e.code : 0,
                message: (e && e.message) || String(e),
                retryable: !!(e && e.retryable),
            };
        }
        sdk = s;
        framesSent = 0;
        framesRejected = 0;
        return { ok: true };
    });

    ipcMain.handle('sr:engine-stop', async (event) => {
        if (!fromOurWindow(event)) return { ok: false };
        const sent = framesSent;
        const rejected = framesRejected;
        await teardown();
        return { ok: true, framesSent: sent, framesRejected: rejected };
    });

    return {
        attachWindow(w) {
            win = w;
            w.on('closed', () => {
                if (win !== w) return;
                win = null;
                closePort();
                teardown();
            });
            // A reload creates a new page: drop the old session and frame port.
            w.webContents.on('did-start-navigation', (e, _url, isInPlace, isMainFrame) => {
                const main = e && typeof e.isMainFrame === 'boolean' ? e.isMainFrame : isMainFrame;
                const sameDoc = e && typeof e.isSameDocument === 'boolean' ? e.isSameDocument : isInPlace;
                if (main && !sameDoc) { closePort(); teardown(); }
            });
        },
        shutdown: teardown,
    };
}

module.exports = { createEngine };
