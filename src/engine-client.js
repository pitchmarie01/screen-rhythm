// src/engine-client.js: window-side client for SmartSpectra in the main process.
//
// Replaces the SDK's renderer helper for frame delivery. It:
//   - starts/stops SmartSpectra in the main process (src/engine-main.js),
//   - runs the camera frame pump in a Web Worker (src/frame-worker.js),
//   - re-emits SDK events with the same names/arguments the dashboard used:
//     processingStatus, validationStatus, metrics, error, frameSentThrough,
//     plus 'pipelineStats' (worker frame counts, once per second).
//
// The camera stream is owned by the caller (useMediaStream). The worker gets
// a CLONE of the video track, which it stops when done.

'use strict';

const PROCESSING_STATUS_RUNNING = 3;   // ProcessingStatus.kRunning
const FRAME_PORT_TIMEOUT_MS = 5_000;

function getFramePort(bridge) {
    return new Promise((resolve, reject) => {
        const onMessage = (e) => {
            if (!e.data || e.data.type !== 'sr-frame-port' || !e.ports || !e.ports[0]) return;
            window.removeEventListener('message', onMessage);
            clearTimeout(timer);
            resolve(e.ports[0]);
        };
        const timer = setTimeout(() => {
            window.removeEventListener('message', onMessage);
            reject(new Error('Could not open the frame channel to SmartSpectra.'));
        }, FRAME_PORT_TIMEOUT_MS);
        window.addEventListener('message', onMessage);
        bridge.openFramePort();
    });
}

function engineError(res) {
    const e = new Error((res && res.message) || 'SmartSpectra could not start.');
    if (res && typeof res.code === 'number') e.code = res.code;
    if (res && res.reason) e.reason = res.reason;
    e.retryable = !!(res && res.retryable);
    return e;
}

class EngineClient {
    constructor({ bridge, requestedMetrics, workerUrl = './dist/frame-worker.bundle.js' }) {
        this._bridge = bridge;
        this._requestedMetrics = requestedMetrics;
        this._workerUrl = workerUrl;
        this._listeners = new Map();
        this._stream = null;
        this._worker = null;
        this._mainThreadReader = null;
        this._cameraLocked = false;
        this._destroyed = false;
    }

    on(event, callback) {
        if (!this._listeners.has(event)) this._listeners.set(event, []);
        this._listeners.get(event).push(callback);
        return this;
    }

    _emit(event, ...args) {
        for (const cb of this._listeners.get(event) || []) {
            try { cb(...args); } catch (e) { console.error(`[engine-client] ${event} listener failed:`, e); }
        }
    }

    useMediaStream(stream) {
        this._stream = stream;
        return this;
    }

    _onEngineEvent(msg) {
        if (this._destroyed || !msg) return;
        switch (msg.kind) {
            case 'processingStatus':
                if (msg.status === PROCESSING_STATUS_RUNNING) this._lockCamera();
                this._emit('processingStatus', msg.status);
                break;
            case 'validationStatus':
                this._emit('validationStatus', msg.code, Number(msg.timestampUs), msg.hint);
                break;
            case 'metrics':
                this._emit('metrics', msg.buffer, Number(msg.timestampUs));
                break;
            case 'error':
                this._emit('error', msg.code, msg.message, msg.retryable);
                break;
            case 'frameSentThrough':
                this._emit('frameSentThrough', !!msg.sent, Number(msg.timestampUs));
                break;
            default:
                break;
        }
    }

    async start() {
        if (!this._stream) throw new Error('No camera stream.');
        const track = this._stream.getVideoTracks()[0];
        if (!track) throw new Error('The camera stream has no video track.');

        this._bridge.onEngineEvent((msg) => this._onEngineEvent(msg));

        // 1. Camera worker + its direct frame channel to the main process.
        const port = await getFramePort(this._bridge);
        const worker = new Worker(this._workerUrl);
        this._worker = worker;
        worker.onmessage = (e) => {
            const m = e.data || {};
            if (m.type === 'stats') this._emit('pipelineStats', m);
            else if (m.type === 'error') console.warn('[engine-client] frame worker:', m.message);
        };
        worker.onerror = (e) => console.warn('[engine-client] frame worker error:', e.message);
        worker.postMessage({ type: 'port', port }, [port]);

        // 2. Start SmartSpectra (main process, custom input).
        const res = await this._bridge.engineStart({ requestedMetrics: this._requestedMetrics });
        if (!res || !res.ok) {
            this._stopWorker();
            throw engineError(res);
        }

        // 3. Start the frame pump. Preferred: transfer a track clone to the
        //    worker so frames never touch this page's main thread.
        const clone = track.clone();
        try {
            worker.postMessage({ type: 'start', track: clone }, [clone]);
        } catch (e) {
            // Fallback if this Chromium can't transfer tracks: read frames here
            // and transfer each VideoFrame (zero-copy) to the worker.
            console.warn('[engine-client] track transfer unavailable, using frame transfer:', e && e.message);
            worker.postMessage({ type: 'start-external' });
            this._pumpOnMainThread(clone, worker);
        }
    }

    async _pumpOnMainThread(track, worker) {
        const reader = new MediaStreamTrackProcessor({ track }).readable.getReader();
        this._mainThreadReader = { reader, track };
        for (;;) {
            let r;
            try { r = await reader.read(); } catch { break; }
            if (r.done || this._worker !== worker) { if (r.value) r.value.close(); break; }
            try { worker.postMessage({ type: 'frame', frame: r.value }, [r.value]); } catch { r.value.close(); }
        }
        try { track.stop(); } catch { /* ignore */ }
    }

    // Same best-effort camera lock the SDK's renderer helper applies once
    // processing is Running (stable exposure/white balance/focus).
    _lockCamera() {
        if (this._cameraLocked || !this._stream) return;
        this._cameraLocked = true;
        const track = this._stream.getVideoTracks()[0];
        if (!track || typeof track.applyConstraints !== 'function') return;
        const caps = typeof track.getCapabilities === 'function' ? track.getCapabilities() || {} : {};
        const advanced = [];
        if (Array.isArray(caps.exposureMode) && caps.exposureMode.includes('manual')) advanced.push({ exposureMode: 'manual' });
        if (Array.isArray(caps.whiteBalanceMode) && caps.whiteBalanceMode.includes('manual')) advanced.push({ whiteBalanceMode: 'manual' });
        if (Array.isArray(caps.focusMode) && caps.focusMode.includes('manual')) advanced.push({ focusMode: 'manual' });
        if (advanced.length === 0) return;
        track.applyConstraints({ advanced }).catch((err) => {
            console.warn('[engine-client] camera lock not applied, continuing in auto mode:', err && err.message);
        });
    }

    _stopWorker() {
        const worker = this._worker;
        this._worker = null;
        if (this._mainThreadReader) {
            try { this._mainThreadReader.reader.cancel(); } catch { /* ignore */ }
            try { this._mainThreadReader.track.stop(); } catch { /* ignore */ }
            this._mainThreadReader = null;
        }
        if (worker) {
            try { worker.postMessage({ type: 'stop' }); } catch { /* ignore */ }
            // Give the worker a moment to stop its track clone, then end it.
            setTimeout(() => worker.terminate(), 300);
        }
    }

    async stop() {
        this._stopWorker();
        try {
            return await this._bridge.engineStop();
        } finally {
            this._cameraLocked = false;
        }
    }

    destroy() {
        if (this._destroyed) return;
        this._destroyed = true;
        this._stopWorker();
        this._bridge.onEngineEvent(null);
        this._bridge.engineStop().catch(() => {});
    }
}

module.exports = { EngineClient };
