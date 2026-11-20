// src/frame-worker.js: camera frame pump for SmartSpectra (runs in a Web Worker).
//
// Why this exists: the SDK's renderer helper converts every camera frame on
// the page's main thread (draw into a CPU canvas -> getImageData -> RGBA
// copies). With real webcam frames on Windows that capped delivery at ~21 fps.
// This worker instead:
//   1. reads frames with MediaStreamTrackProcessor (off the UI thread),
//   2. copies each frame in its NATIVE format with VideoFrame.copyTo()
//      (NV12 on most Windows webcams: no colour conversion, 460 KB at 640x480),
//   3. posts it straight to the Electron main process over a MessagePort,
//      where the official SmartSpectra API is used:
//      sdk.useCustomInput() + sdk.sendFrame(buf, w, h, stride, pixelFormat, tsUs).
//
// Frames are never stored. At most MAX_IN_FLIGHT frames wait for the main
// process; extra frames are skipped and COUNTED (reported, never hidden).

'use strict';

// SmartSpectra PixelFormat values (from @smartspectra/node-sdk index.d.ts).
const PF = { kRGBA: 2, kBGRA: 3, kNV12: 4 };
const MAX_IN_FLIGHT = 3;

let port = null;
let reader = null;
let active = false;
let inFlight = 0;
let seq = 0;
let statsTimer = null;
let stats = null;
let ts = null;            // timestamp anchor (see nextTimestampUs)
let fallbackCanvas = null;
let externalBusy = false;

function resetStats() {
    stats = { read: 0, sent: 0, skipped: 0, copyMsTotal: 0, format: '', errors: 0, lastError: '' };
}

// VideoFrame.timestamp is microseconds on the frame's media clock. Anchor it
// to the Unix epoch once, and keep it strictly increasing (the SDK requires
// monotonic timestamps; it measures frame rate from them). Same approach as
// the SDK's own renderer helper (js/renderer/timestamp.js).
function nextTimestampUs(rawUs) {
    const raw = Number(rawUs) || 0;
    if (ts === null) ts = { offset: Date.now() * 1000 - raw, last: 0 };
    let t = Math.round(raw + ts.offset);
    if (t <= ts.last) t = ts.last + 1;
    ts.last = t;
    return t;
}

// Copy a VideoFrame into a tightly packed buffer SmartSpectra accepts.
async function copyFrame(vf) {
    const w = vf.visibleRect ? vf.visibleRect.width : vf.codedWidth;
    const h = vf.visibleRect ? vf.visibleRect.height : vf.codedHeight;
    const fmt = vf.format;
    const even = w % 2 === 0 && h % 2 === 0;

    if (fmt === 'NV12' && even) {
        const buf = new Uint8Array(w * h * 3 / 2);
        await vf.copyTo(buf, { layout: [{ offset: 0, stride: w }, { offset: w * h, stride: w }] });
        return { buf, w, h, stride: w, pixelFormat: PF.kNV12, fmt };
    }
    if (fmt === 'I420' && even) {
        // I420 (separate U and V planes) -> NV12 (interleaved UV). Cheap.
        const ySize = w * h;
        const cw = w / 2, ch = h / 2;
        const tmp = new Uint8Array(ySize * 3 / 2);
        await vf.copyTo(tmp, { layout: [
            { offset: 0, stride: w },
            { offset: ySize, stride: cw },
            { offset: ySize + cw * ch, stride: cw },
        ] });
        const buf = new Uint8Array(ySize * 3 / 2);
        buf.set(tmp.subarray(0, ySize), 0);
        const u = ySize, v = ySize + cw * ch;
        for (let i = 0, o = ySize; i < cw * ch; i++, o += 2) {
            buf[o] = tmp[u + i];
            buf[o + 1] = tmp[v + i];
        }
        return { buf, w, h, stride: w, pixelFormat: PF.kNV12, fmt };
    }
    if (fmt === 'RGBA' || fmt === 'RGBX' || fmt === 'BGRA' || fmt === 'BGRX') {
        const buf = new Uint8Array(w * h * 4);
        await vf.copyTo(buf, { layout: [{ offset: 0, stride: w * 4 }] });
        const pixelFormat = fmt.startsWith('RGB') ? PF.kRGBA : PF.kBGRA;
        return { buf, w, h, stride: w * 4, pixelFormat, fmt };
    }
    // Anything else (or odd sizes): let the browser convert to RGBA.
    try {
        const buf = new Uint8Array(w * h * 4);
        await vf.copyTo(buf, { format: 'RGBA', layout: [{ offset: 0, stride: w * 4 }] });
        return { buf, w, h, stride: w * 4, pixelFormat: PF.kRGBA, fmt: `${fmt}->RGBA` };
    } catch {
        // Last resort: draw on a worker-side canvas (still off the UI thread).
        if (!fallbackCanvas || fallbackCanvas.width !== w || fallbackCanvas.height !== h) {
            fallbackCanvas = new OffscreenCanvas(w, h);
        }
        const ctx = fallbackCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(vf, 0, 0, w, h);
        const data = ctx.getImageData(0, 0, w, h).data;
        return { buf: new Uint8Array(data.buffer), w, h, stride: w * 4, pixelFormat: PF.kRGBA, fmt: `${fmt}->canvas` };
    }
}

async function handleFrame(vf) {
    stats.read++;
    try {
        if (inFlight >= MAX_IN_FLIGHT) {
            stats.skipped++;   // main process is behind: skip rather than queue
            return;
        }
        const t0 = performance.now();
        const frame = await copyFrame(vf);
        stats.copyMsTotal += performance.now() - t0;
        stats.format = frame.fmt;
        if (!active || !port) return;
        inFlight++;
        stats.sent++;
        // Structured clone (not transfer): Electron's MessagePortMain drops
        // messages that transfer ArrayBuffers.
        port.postMessage({
            kind: 'frame',
            seq: ++seq,
            buffer: frame.buf.buffer,
            width: frame.w,
            height: frame.h,
            stride: frame.stride,
            pixelFormat: frame.pixelFormat,
            timestampUs: nextTimestampUs(vf.timestamp),
        });
    } catch (e) {
        stats.errors++;
        stats.lastError = (e && e.message) || String(e);
    } finally {
        vf.close();
    }
}

async function run(track) {
    const processor = new MediaStreamTrackProcessor({ track });
    reader = processor.readable.getReader();
    while (active) {
        let result;
        try {
            result = await reader.read();
        } catch (e) {
            stats.errors++;
            stats.lastError = (e && e.message) || String(e);
            break;
        }
        if (result.done) break;
        if (!active) { result.value.close(); break; }
        await handleFrame(result.value);
    }
    try { track.stop(); } catch { /* already stopped */ }
}

function sendStats() {
    const s = stats;
    self.postMessage({
        type: 'stats',
        readFps: s.read,
        sentFps: s.sent,
        skippedFps: s.skipped,
        avgCopyMs: s.sent ? s.copyMsTotal / s.sent : null,
        format: s.format,
        errors: s.errors,
        lastError: s.lastError,
    });
    resetStats();
}

function stop() {
    active = false;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
    if (reader) { reader.cancel().catch(() => {}); reader = null; }
    inFlight = 0;
    ts = null;
}

self.onmessage = (e) => {
    const msg = e.data || {};
    if (msg.type === 'port') {
        port = msg.port;
        port.onmessage = (ev) => {
            if (ev.data && ev.data.kind === 'ack') inFlight = Math.max(0, inFlight - 1);
        };
        port.start();
    } else if (msg.type === 'start') {
        stop();
        active = true;
        inFlight = 0;
        resetStats();
        statsTimer = setInterval(sendStats, 1000);
        run(msg.track).catch((err) => {
            self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
        });
    } else if (msg.type === 'start-external') {
        // Fallback: frames are read on the page and transferred here.
        stop();
        active = true;
        inFlight = 0;
        externalBusy = false;
        resetStats();
        statsTimer = setInterval(sendStats, 1000);
    } else if (msg.type === 'frame') {
        const vf = msg.frame;
        if (!vf) return;
        if (!active || externalBusy) {
            if (active) { stats.read++; stats.skipped++; }
            vf.close();
            return;
        }
        externalBusy = true;
        handleFrame(vf).finally(() => { externalBusy = false; });
    } else if (msg.type === 'stop') {
        stop();
        self.postMessage({ type: 'stopped' });
    }
};
