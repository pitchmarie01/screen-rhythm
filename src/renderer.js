// src/renderer.js — Screen Rhythm dashboard (runs in the app window)
//
// Bundled by esbuild into dist/renderer.bundle.js.
//
// SmartSpectra runs in the Electron main process using the official
// custom-input API (src/engine-main.js). Camera frames are pumped by a Web
// Worker (src/frame-worker.js) via src/engine-client.js, so frame handling
// never runs on this page's UI thread. Metrics are decoded here with
// decodeMetrics from '@smartspectra/node-sdk/messages'.

'use strict';

const {
    ProcessingStatus,
    ValidationCode,
    SmartSpectraErrorCode,
    MetricType,
} = require('@smartspectra/node-sdk/renderer');
const { decodeMetrics } = require('@smartspectra/node-sdk/messages');
const { BlinkTracker } = require('./blink-tracker');
const { BlinkTimeline } = require('./blink-timeline');
const { BreakReminder } = require('./break-reminder');
const { EngineClient } = require('./engine-client');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

// Request ONLY blink detection from the Face Analysis bundle
// (faceMetrics = FACE_LANDMARKS, BLINKING, TALKING, EXPRESSIONS).
const REQUESTED_METRICS = [MetricType.BLINKING];

// SDK telemetry defaults to ON (session summaries + device readiness reports;
// no video frames or measured values). Screen Rhythm opts out for privacy:
// enableTelemetry: false is set where the SDK is created (src/engine-main.js).

// If the session is running but no face-analysis sample arrives within this
// time, tell the user (most often: face not visible or poor lighting).
const FACE_DATA_GRACE_MS = 10_000;

const CONSENT_STORAGE_KEY = 'screenRhythm.cameraConsent.v1';

// Camera capture. The SDK default is 1280x720 @ 30 fps. Every frame is read
// back on the CPU and copied to the main process, so 640x480 moves ~3x less
// data per frame and leaves more headroom to keep 30 fps.
const CAMERA_TARGET = { width: 640, height: 480, fps: 30 };
// Presage guidance: don't let the camera drop below ~25 fps; target 30.
const MIN_USABLE_FPS = 25;
// Seconds of consecutive low measurements before showing a tip.
const LOW_FPS_TIP_AFTER_S = 3;

// Blink activity.
// Average blinks/minute is shown only after this much valid face data.
const MIN_RATE_COVERAGE_US = 60_000_000;
// No valid blink reading for this long = "no face data right now".
const BLINK_STALE_AFTER_MS = 2_000;
// How long the "Blink detected" indicator stays lit.
const BLINK_FLASH_MS = 380;

// Break reminders (interval chosen by the user; stored on this computer only).
const BREAK_INTERVAL_KEY = 'screenRhythm.breakIntervalMin.v1';
const BREAK_INTERVAL_CHOICES = [20, 30, 45, 1];
const DEFAULT_BREAK_INTERVAL_MIN = 20;
const WELCOME_BACK_MS = 4_000;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);
const els = {
    statusPill:      $('status-pill'),
    statusText:      $('status-text'),
    errorBanner:     $('error-banner'),
    errorTitle:      $('error-title'),
    errorMessage:    $('error-message'),
    errorDetail:     $('error-detail'),
    btnOpenSettings: $('btn-open-settings'),
    btnDismissError: $('btn-dismiss-error'),
    liveBadge:       $('live-badge'),
    previewWrap:     $('preview-wrap'),
    preview:         $('preview'),
    placeholderTitle: $('placeholder-title'),
    placeholderSub:  $('placeholder-sub'),
    hint:            $('hint'),
    timer:           $('timer'),
    timerCaption:    $('timer-caption'),
    btnStart:        $('btn-start'),
    btnStop:         $('btn-stop'),
    stepCamera:      $('step-camera'),
    stepCameraSub:   $('step-camera-sub'),
    stepSdk:         $('step-sdk'),
    stepSdkSub:      $('step-sdk-sub'),
    stepFace:        $('step-face'),
    stepFaceSub:     $('step-face-sub'),
    blinkCard:       $('blink-card'),
    blinkLive:       $('blink-live'),
    blinkLiveText:   $('blink-live-text'),
    blinkTotal:      $('blink-total'),
    blinkRate:       $('blink-rate'),
    blinkLast:       $('blink-last'),
    blinkCovered:    $('blink-covered'),
    blinkQuality:    $('blink-quality'),
    blinkCanvas:     $('blink-canvas'),
    timelineEmpty:   $('timeline-empty'),
    timelineEmptyTitle: $('timeline-empty-title'),
    timelineEmptySub: $('timeline-empty-sub'),
    breakRow:        $('break-row'),
    breakNextText:   $('break-next-text'),
    breakInterval:   $('break-interval'),
    reminder:        $('reminder'),
    reminderEyebrow: $('reminder-eyebrow'),
    reminderTitle:   $('reminder-title'),
    reminderText:    $('reminder-text'),
    reminderCountdown: $('reminder-countdown'),
    reminderRing:    $('reminder-ring'),
    reminderCount:   $('reminder-count'),
    btnBreakTake:    $('btn-break-take'),
    btnBreakLater:   $('btn-break-later'),
    btnBreakBack:    $('btn-break-back'),
    diag:            $('camera-diag'),
    diagRes:         $('diag-res'),
    diagReported:    $('diag-reported'),
    diagMeasured:    $('diag-measured'),
    diagSdkInput:    $('diag-sdk-input'),
    diagSdkProcessed: $('diag-sdk-processed'),
    diagRequested:   $('diag-requested'),
    diagNote:        $('diag-note'),
    diagPipeline:    $('diag-pipeline'),
    consentDialog:   $('consent-dialog'),
    btnConsentOk:    $('btn-consent-ok'),
    btnConsentCancel: $('btn-consent-cancel'),
};

const bridge = window.screenRhythm;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let sdk = null;
let phase = 'idle';            // idle | starting | running | stopping
let timerStartMs = null;
let timerInterval = null;
let faceSamples = 0;
let faceWatchdog = null;
let lastValidationCode = null;
let cameraStream = null;       // host-owned MediaStream (we must stop it ourselves)
let fpsMonitor = null;
let lastMeasuredFps = null;
let lowFpsSeconds = 0;
let fpsMeasurementAvailable = false;

// Blink tracking (real SmartSpectra readings only).
const blinkTracker = new BlinkTracker();
const blinkTimeline = new BlinkTimeline(els.blinkCanvas, blinkTracker);
let lastReadingPerf = null;     // performance.now() of the latest valid reading
let lastBlinkPerf = null;       // performance.now() of the latest counted blink
let blinkUiTimer = null;
let blinkFlashTimer = null;
let latestValidation = null;   // { code, text, tone } most recent SDK validation status

const STATUS_NAMES = Object.fromEntries(
    Object.entries(ProcessingStatus).map(([k, v]) => [v, k.replace(/^k/, '')]));

// ---------------------------------------------------------------------------
// Small UI helpers
// ---------------------------------------------------------------------------

function setPill(tone, text) {
    els.statusPill.dataset.tone = tone;
    els.statusText.textContent = text;
}

function setStep(stepEl, subEl, state, text) {
    stepEl.dataset.state = state;
    subEl.textContent = text;
}

function setControls({ canStart, canStop }) {
    els.btnStart.disabled = !canStart;
    els.btnStop.disabled = !canStop;
}

function setPreview(state, title, sub) {
    els.previewWrap.dataset.state = state;          // off | starting | on
    if (title) els.placeholderTitle.textContent = title;
    if (sub) els.placeholderSub.textContent = sub;
    els.liveBadge.hidden = state !== 'on';
}

function showHint(text, tone) {
    els.hint.textContent = text;
    els.hint.dataset.tone = tone;
    els.hint.hidden = false;
}

function hideHint() {
    els.hint.hidden = true;
    lastValidationCode = null;
    latestValidation = null;
}

function showError({ title, message, detail = '', cameraSettings = false }) {
    els.errorTitle.textContent = title;
    els.errorMessage.textContent = message;
    els.errorDetail.textContent = detail;
    els.errorDetail.hidden = !detail;
    els.btnOpenSettings.hidden = !(cameraSettings && bridge && bridge.platform === 'win32');
    els.errorBanner.hidden = false;
    if (phase === 'idle') setPill('error', 'Needs attention');
}

function hideError() {
    els.errorBanner.hidden = true;
}

function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

// ---------------------------------------------------------------------------
// Camera: acquire a lighter stream and hand it to the SDK (useMediaStream)
// ---------------------------------------------------------------------------

function cameraError(err) {
    // Same shape as the SDK's own camera errors, so describeStartError()
    // can explain permission / busy / missing-camera problems.
    const name = (err && err.name) || 'Error';
    const e = new Error(`Failed to acquire camera (${name}): ${(err && err.message) || err}`);
    e.cause = err;
    return e;
}

// First asks for 640x480 with a minimum of 25 fps. If the camera cannot
// promise that (OverconstrainedError), retries with 30 fps as a preference
// only. Permission, busy or missing-camera errors stop immediately.
async function acquireCamera() {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') {
        throw cameraError({ name: 'NotFoundError', message: 'Camera API is not available.' });
    }
    const base = {
        width:  { ideal: CAMERA_TARGET.width },
        height: { ideal: CAMERA_TARGET.height },
        facingMode: 'user',
    };
    const attempts = [
        { mode: `${CAMERA_TARGET.width}×${CAMERA_TARGET.height} · ${CAMERA_TARGET.fps} fps (min ${MIN_USABLE_FPS})`,
          video: { ...base, frameRate: { ideal: CAMERA_TARGET.fps, min: MIN_USABLE_FPS } } },
        { mode: `${CAMERA_TARGET.width}×${CAMERA_TARGET.height} · ${CAMERA_TARGET.fps} fps (preferred)`,
          video: { ...base, frameRate: { ideal: CAMERA_TARGET.fps } } },
    ];
    let lastErr = null;
    for (const attempt of attempts) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ video: attempt.video, audio: false });
            return { stream, mode: attempt.mode, minFpsGuaranteed: attempt === attempts[0] };
        } catch (err) {
            lastErr = err;
            const name = err && err.name;
            if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
                console.warn(`[screen-rhythm] camera could not satisfy "${attempt.mode}", relaxing frame-rate request`);
                continue;
            }
            break;
        }
    }
    throw cameraError(lastErr);
}

function releaseCamera() {
    if (!cameraStream) return;
    for (const track of cameraStream.getTracks()) {
        try { track.stop(); } catch { /* already stopped */ }
    }
    cameraStream = null;
}

// ---------------------------------------------------------------------------
// Camera diagnostics (actual numbers only, never assumed)
// ---------------------------------------------------------------------------

function fmtFps(n) {
    return `${(Math.round(n * 10) / 10).toFixed(1)} fps`;
}

// Two possible tips under the diagnostics: one about SmartSpectra's
// processing rate (takes priority) and one about the camera itself.
let sdkNote = '';
let cameraNote = '';

function renderDiagNote() {
    const text = sdkNote || cameraNote;
    els.diagNote.textContent = text;
    els.diagNote.hidden = !text;
}

function setCameraNote(text) {
    cameraNote = text || '';
    renderDiagNote();
}

function fpsTone(fps) {
    return fps >= 27 ? 'ok' : fps >= MIN_USABLE_FPS ? 'warn' : 'low';
}

function resetDiagnostics() {
    els.diag.dataset.state = 'idle';
    els.diagRes.textContent = '—';
    els.diagReported.textContent = '—';
    els.diagMeasured.textContent = '—';
    els.diagMeasured.dataset.tone = '';
    els.diagSdkInput.textContent = '—';
    els.diagSdkInput.dataset.tone = '';
    els.diagSdkProcessed.textContent = '—';
    els.diagSdkProcessed.dataset.tone = '';
    els.diagRequested.textContent = `${CAMERA_TARGET.width}×${CAMERA_TARGET.height} · ${CAMERA_TARGET.fps} fps`;
    sdkNote = '';
    cameraNote = '';
    renderDiagNote();
    lastMeasuredFps = null;
    lowFpsSeconds = 0;
    fpsMeasurementAvailable = false;
    resetSdkThroughput();
    lastPipeline = null;
    els.diagPipeline.textContent = '';
    els.diagPipeline.hidden = true;
}

// ---------------------------------------------------------------------------
// SmartSpectra throughput: what the SDK actually processes
// ---------------------------------------------------------------------------
//
// The SDK measures frame rate from the timestamps of the frames it processes
// (docs/device-readiness.md). Its processing graph has a flow limiter that
// skips a frame while the previous one is still being analysed, and reports
// each decision through the official 'frameSentThrough' event
// (sent = true: processed, false: skipped). Counting those events gives:
//   SDK input     = frames that reached SmartSpectra per second
//   SDK processed = frames SmartSpectra analysed per second

const SDK_NOT_REPORTED_AFTER_MS = 5_000;

let sdkCounts = { total: 0, sent: 0 };
let sdkTicker = null;
let sdkTickPerf = 0;
let sdkMonitorStartPerf = 0;
let sdkEventsSeen = false;
let lastSdkInputFps = null;
let lastSdkProcessedFps = null;
let sdkLowSeconds = 0;

function resetSdkThroughput() {
    stopSdkThroughputMonitor();
    sdkCounts = { total: 0, sent: 0 };
    sdkEventsSeen = false;
    lastSdkInputFps = null;
    lastSdkProcessedFps = null;
    sdkLowSeconds = 0;
}

// Camera worker counts, once per second: frames read from the camera, frames
// handed to SmartSpectra, frames skipped because the main process was busy.
let lastPipeline = null;

function onPipelineStats(s) {
    lastPipeline = s;
    const parts = [`camera ${s.readFps}/s`, `sent ${s.sentFps}/s`];
    if (s.skippedFps) parts.push(`skipped ${s.skippedFps}/s`);
    if (s.format) parts.push(s.format);
    if (typeof s.avgCopyMs === 'number') parts.push(`copy ${s.avgCopyMs.toFixed(1)} ms`);
    if (s.errors) parts.push(`${s.errors} errors`);
    els.diagPipeline.textContent = `Frame pipeline: ${parts.join(' · ')}`;
    els.diagPipeline.hidden = false;
    if (s.errors && s.lastError) console.warn('[screen-rhythm] frame worker error:', s.lastError);
}

function onFrameSentThrough(sent) {
    sdkEventsSeen = true;
    sdkCounts.total++;
    if (sent === true) sdkCounts.sent++;
}

function startSdkThroughputMonitor() {
    stopSdkThroughputMonitor();
    sdkCounts = { total: 0, sent: 0 };
    sdkTickPerf = performance.now();
    sdkMonitorStartPerf = sdkTickPerf;
    els.diagSdkInput.textContent = 'Measuring…';
    els.diagSdkProcessed.textContent = 'Measuring…';
    sdkTicker = setInterval(sdkThroughputTick, 1000);
}

function stopSdkThroughputMonitor() {
    if (sdkTicker) clearInterval(sdkTicker);
    sdkTicker = null;
}

function sdkThroughputTick() {
    const now = performance.now();
    const elapsedS = (now - sdkTickPerf) / 1000;
    sdkTickPerf = now;
    if (!sdkEventsSeen) {
        if (now - sdkMonitorStartPerf > SDK_NOT_REPORTED_AFTER_MS) {
            els.diagSdkInput.textContent = 'Not reported';
            els.diagSdkProcessed.textContent = 'Not reported';
        }
        return;
    }
    const inputFps = sdkCounts.total / elapsedS;
    const processedFps = sdkCounts.sent / elapsedS;
    sdkCounts = { total: 0, sent: 0 };
    onSdkThroughput(inputFps, processedFps);
}

function onSdkThroughput(inputFps, processedFps) {
    lastSdkInputFps = inputFps;
    lastSdkProcessedFps = processedFps;
    els.diagSdkInput.textContent = fmtFps(inputFps);
    els.diagSdkInput.dataset.tone = fpsTone(inputFps);
    els.diagSdkProcessed.textContent = fmtFps(processedFps);
    els.diagSdkProcessed.dataset.tone = fpsTone(processedFps);

    if (processedFps < MIN_USABLE_FPS) {
        sdkLowSeconds += 1;
        if (sdkLowSeconds >= LOW_FPS_TIP_AFTER_S) {
            sdkNote = inputFps >= MIN_USABLE_FPS
                ? `SmartSpectra is analysing about ${fmtFps(processedFps)} of the ${fmtFps(inputFps)} it receives, ` +
                  `and it needs about ${MIN_USABLE_FPS}. Your computer's processor is the limit: plug in your laptop, ` +
                  'set Windows Power mode to "Best performance", and close heavy apps.'
                : `SmartSpectra is receiving only about ${fmtFps(inputFps)} and needs about ${MIN_USABLE_FPS}. ` +
                  'Try more light on your face, closing other apps that use the camera, or plugging in your laptop.';
            renderDiagNote();
        }
    } else {
        sdkLowSeconds = 0;
        if (sdkNote) { sdkNote = ''; renderDiagNote(); }
    }
    if (latestValidation && latestValidation.code === ValidationCode.kFrameRateTooLow) {
        renderHint();
    }
}

function showCameraSettings(stream, mode) {
    const track = stream.getVideoTracks()[0];
    const s = (track && track.getSettings) ? track.getSettings() : {};
    els.diag.dataset.state = 'live';
    els.diagRequested.textContent = mode;
    els.diagRes.textContent = s.width && s.height ? `${s.width}×${s.height}` : 'Not reported';
    els.diagReported.textContent = typeof s.frameRate === 'number' ? fmtFps(s.frameRate) : 'Not reported';
    els.diagMeasured.textContent = 'Measuring…';
    console.log(`[screen-rhythm] camera settings: ${s.width}x${s.height} @ ${s.frameRate} fps (requested ${mode})`);
    if (typeof s.frameRate === 'number' && s.frameRate < MIN_USABLE_FPS) {
        setCameraNote(`Your camera reports ${fmtFps(s.frameRate)}, below the ~${MIN_USABLE_FPS} fps SmartSpectra needs. ` +
                      'More light on your face usually helps.');
    }
}

// Preview frame rate: shows what the camera delivers to the screen. It does
// NOT represent what SmartSpectra processes (see SDK processed).
function onMeasuredFps(fps) {
    lastMeasuredFps = fps;
    els.diagMeasured.textContent = fmtFps(fps);
    els.diagMeasured.dataset.tone = fpsTone(fps);
    if (fps < MIN_USABLE_FPS) {
        lowFpsSeconds += 1;
        if (lowFpsSeconds >= LOW_FPS_TIP_AFTER_S) {
            setCameraNote(`The camera is delivering about ${fmtFps(fps)}. SmartSpectra needs about ${MIN_USABLE_FPS} fps or more. ` +
                          'Try more light on your face, closing other apps that use the camera, or plugging in your laptop.');
        }
    } else {
        lowFpsSeconds = 0;
        setCameraNote('');
    }
}

// Counts frames actually presented by the preview <video>, once per second.
function startFpsMonitor(video) {
    stopFpsMonitor();
    if (typeof video.requestVideoFrameCallback !== 'function') {
        fpsMeasurementAvailable = false;
        els.diagMeasured.textContent = 'Unavailable';
        return;
    }
    fpsMeasurementAvailable = true;
    let active = true;
    let handle = 0;
    let windowStart = null;
    let framesAtStart = 0;
    const onFrame = (now, meta) => {
        if (!active) return;
        if (windowStart === null || document.visibilityState !== 'visible') {
            windowStart = now;
            framesAtStart = meta.presentedFrames;
        } else if (now - windowStart >= 1000) {
            onMeasuredFps(((meta.presentedFrames - framesAtStart) * 1000) / (now - windowStart));
            windowStart = now;
            framesAtStart = meta.presentedFrames;
        }
        handle = video.requestVideoFrameCallback(onFrame);
    };
    handle = video.requestVideoFrameCallback(onFrame);
    fpsMonitor = {
        stop() {
            active = false;
            try { video.cancelVideoFrameCallback(handle); } catch { /* ignore */ }
        },
    };
}

function stopFpsMonitor() {
    if (fpsMonitor) fpsMonitor.stop();
    fpsMonitor = null;
}

document.addEventListener('visibilitychange', () => {
    // The preview is not painted while the window is minimized, so the
    // measurement pauses rather than showing a misleading number.
    if (fpsMonitor && document.visibilityState !== 'visible') {
        els.diagMeasured.textContent = 'Paused (window hidden)';
        els.diagMeasured.dataset.tone = '';
    }
});

// ---------------------------------------------------------------------------
// Session timer
// ---------------------------------------------------------------------------

function startTimer() {
    if (timerStartMs !== null) return;
    timerStartMs = Date.now();
    els.timerCaption.textContent = 'Session in progress';
    const tick = () => { els.timer.textContent = formatDuration(Date.now() - timerStartMs); };
    tick();
    timerInterval = setInterval(tick, 250);
}

function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    if (timerStartMs !== null) {
        const elapsed = formatDuration(Date.now() - timerStartMs);
        els.timer.textContent = elapsed;
        els.timerCaption.textContent = `Last session: ${elapsed}`;
    }
    timerStartMs = null;
}

// ---------------------------------------------------------------------------
// Face analysis data + blink activity
// ---------------------------------------------------------------------------

function resetFaceIndicator() {
    faceSamples = 0;
    if (faceWatchdog) clearTimeout(faceWatchdog);
    faceWatchdog = null;
    resetBlinkSession();
}

function setBlinkLive(state, text) {
    if (els.blinkLive.dataset.state === 'blink' && state !== 'blink' && blinkFlashTimer) return;
    els.blinkLive.dataset.state = state;
    els.blinkLiveText.textContent = text;
}

function setTimelineEmpty(title, sub) {
    if (!title) {
        els.timelineEmpty.hidden = true;
        return;
    }
    els.timelineEmptyTitle.textContent = title;
    els.timelineEmptySub.textContent = sub || '';
    els.timelineEmpty.hidden = false;
}

// New session: clear every session-specific statistic.
function resetBlinkSession() {
    blinkTracker.reset();
    blinkTimeline.clear();
    lastReadingPerf = null;
    lastBlinkPerf = null;
    if (blinkFlashTimer) clearTimeout(blinkFlashTimer);
    blinkFlashTimer = null;
    els.blinkCard.dataset.state = 'waiting';
    els.blinkTotal.textContent = '0';
    els.blinkQuality.textContent = '';
    setBlinkLive('waiting', 'Waiting for blink data');
    setTimelineEmpty('No blink data yet', 'Blinks appear here as SmartSpectra detects them.');
    renderBlinkStats();
}

function formatAgo(ms) {
    const s = Math.floor(ms / 1000);
    if (s < 1) return 'just now';
    if (s < 60) return `${s}s ago`;
    const m = Math.floor(s / 60);
    return `${m}m ${String(s % 60).padStart(2, '0')}s ago`;
}

function renderBlinkStats() {
    const t = blinkTracker;
    els.blinkTotal.textContent = t.totalBlinks.toLocaleString();

    const bpm = t.blinksPerMinute(MIN_RATE_COVERAGE_US);
    if (bpm !== null) {
        els.blinkRate.textContent = `${bpm.toFixed(1)} / min`;
        els.blinkRate.classList.remove('muted');
    } else if (t.validReadings > 0) {
        const remaining = Math.ceil((MIN_RATE_COVERAGE_US - t.coveredUs) / 1_000_000);
        els.blinkRate.textContent = `in ~${remaining}s`;
        els.blinkRate.classList.add('muted');
    } else {
        els.blinkRate.textContent = '—';
        els.blinkRate.classList.add('muted');
    }

    if (lastBlinkPerf !== null) {
        els.blinkLast.textContent = phase === 'idle' ? '—' : formatAgo(performance.now() - lastBlinkPerf);
        els.blinkLast.classList.toggle('muted', phase === 'idle');
    } else {
        els.blinkLast.textContent = t.validReadings > 0 ? 'None yet' : '—';
        els.blinkLast.classList.add('muted');
    }

    els.blinkCovered.textContent = t.validReadings > 0 ? formatDuration(t.coveredUs / 1000) : '—';
    els.blinkCovered.classList.toggle('muted', t.validReadings === 0);

    const rps = t.readingsPerSecond();
    const stable = t.stableShare();
    if (rps !== null) {
        els.blinkQuality.textContent =
            `SmartSpectra readings: ~${rps.toFixed(1)}/s` +
            (stable !== null ? ` · marked stable: ${Math.round(stable * 100)}%` : '');
    }
}

// Runs twice a second during a session: refreshes "last blink" and detects
// when blink data has stopped arriving (e.g. face out of view).
function startBlinkUi() {
    stopBlinkUi();
    blinkUiTimer = setInterval(() => {
        if (phase !== 'running') return;
        if (lastReadingPerf === null) {
            setBlinkLive('waiting', 'Waiting for blink data');
        } else if (performance.now() - lastReadingPerf > BLINK_STALE_AFTER_MS) {
            setBlinkLive('stale', 'No face data right now');
        } else {
            setBlinkLive('live', 'Watching for blinks');
        }
        renderBlinkStats();
    }, 500);
}

function stopBlinkUi() {
    if (blinkUiTimer) clearInterval(blinkUiTimer);
    blinkUiTimer = null;
}

function flashBlink() {
    if (blinkFlashTimer) clearTimeout(blinkFlashTimer);
    blinkFlashTimer = null;
    setBlinkLive('blink', 'Blink detected');
    blinkFlashTimer = setTimeout(() => {
        blinkFlashTimer = null;
        if (phase === 'running') setBlinkLive('live', 'Watching for blinks');
    }, BLINK_FLASH_MS);
    els.blinkTotal.classList.remove('bump');
    void els.blinkTotal.offsetWidth;   // restart the CSS animation
    els.blinkTotal.classList.add('bump');
    blinkTimeline.markBlink();
}

// Feed one packet of SmartSpectra blink readings into the detector.
function onBlinkReadings(readings) {
    const { newBlinks, latest } = blinkTracker.ingest(readings);
    if (!latest) return;   // nothing valid in this packet

    lastReadingPerf = performance.now();
    blinkTimeline.anchor(blinkTracker.lastTsUs);
    if (els.blinkCard.dataset.state !== 'live') {
        els.blinkCard.dataset.state = 'live';
        setTimelineEmpty(null);
        if (!blinkFlashTimer) setBlinkLive('live', 'Watching for blinks');
    }
    if (newBlinks.length > 0) {
        lastBlinkPerf = performance.now();
        flashBlink();
    }
    renderBlinkStats();
}

// ---------------------------------------------------------------------------
// Gentle break reminders
// ---------------------------------------------------------------------------
//
// Logic lives in src/break-reminder.js (tested in test/break-reminder.test.js).
// This section only draws the UI. Reminders run only during a live session.

const MIN_MS = 60_000;
let welcomeBackTimer = null;

function loadBreakIntervalMin() {
    try {
        const v = Number(localStorage.getItem(BREAK_INTERVAL_KEY));
        return BREAK_INTERVAL_CHOICES.includes(v) ? v : DEFAULT_BREAK_INTERVAL_MIN;
    } catch {
        return DEFAULT_BREAK_INTERVAL_MIN;
    }
}

function saveBreakIntervalMin(v) {
    try { localStorage.setItem(BREAK_INTERVAL_KEY, String(v)); } catch { /* fine */ }
}

// Fresh = a valid SmartSpectra blink reading arrived within the stale limit.
function faceDataFresh() {
    return lastReadingPerf !== null && performance.now() - lastReadingPerf <= BLINK_STALE_AFTER_MS;
}

const breakReminder = new BreakReminder({
    intervalMs: loadBreakIntervalMin() * MIN_MS,
    getSignals: () => ({ faceDataFresh: faceDataFresh(), tracker: blinkTracker }),
    onChange: onReminderChange,
});

function hideReminderCard() {
    if (welcomeBackTimer) clearTimeout(welcomeBackTimer);
    welcomeBackTimer = null;
    els.reminder.hidden = true;
    els.reminder.dataset.mode = 'hidden';
}

function showReminderCard(mode, { eyebrow, title, text }) {
    if (welcomeBackTimer) clearTimeout(welcomeBackTimer);
    welcomeBackTimer = null;
    els.reminder.dataset.mode = mode;
    els.reminderEyebrow.textContent = eyebrow;
    els.reminderTitle.textContent = title;
    els.reminderText.textContent = text;
    els.reminderCountdown.hidden = mode !== 'break';
    els.btnBreakTake.hidden = mode !== 'remind';
    els.btnBreakLater.hidden = mode !== 'remind';
    els.btnBreakBack.hidden = mode !== 'break';
    const wasHidden = els.reminder.hidden;
    els.reminder.hidden = false;
    if (wasHidden) {
        // Restart the entrance animation.
        els.reminder.style.animation = 'none';
        void els.reminder.offsetWidth;
        els.reminder.style.animation = '';
    }
}

function reminderMessage(reason, workElapsedMs) {
    const minutes = Math.max(1, Math.round(workElapsedMs / MIN_MS));
    if (reason === 'blink') {
        return {
            eyebrow: 'Gentle reminder',
            title: 'Give your eyes a change of scenery.',
            text: 'Your blinking has been quieter than earlier in this session. ' +
                  'Look away from your screen for a moment.',
        };
    }
    return {
        eyebrow: 'Gentle reminder',
        title: 'Time for a little screen break?',
        text: `You've been at your screen for ${minutes} minute${minutes === 1 ? '' : 's'}. ` +
              'Look away from your screen for a moment.',
    };
}

function updateBreakCountdown(remainingMs, totalMs) {
    const secs = Math.ceil(remainingMs / 1000);
    els.reminderCount.textContent = String(secs);
    const circumference = 125.66;
    const done = totalMs > 0 ? 1 - remainingMs / totalMs : 1;
    els.reminderRing.style.strokeDashoffset = String(circumference * Math.min(1, Math.max(0, done)));
}

function renderBreakRow(state, info) {
    els.breakRow.dataset.state = state;
    let text;
    if (state === 'idle') {
        text = 'Break reminders: off until you start';
    } else if (state === 'working') {
        const ms = info.nextReminderInMs;
        text = ms === null ? 'Break reminders on'
            : ms <= 0 ? 'Break suggestion due'
            : `Next break suggestion in ${formatDuration(ms)}`;
    } else if (state === 'reminding') {
        text = 'Break suggested';
    } else {
        text = `On a break · ${Math.ceil((info.breakRemainingMs || 0) / 1000)}s`;
    }
    if (els.breakNextText.textContent !== text) els.breakNextText.textContent = text;
}

function onReminderChange(state, info) {
    renderBreakRow(state, info);
    switch (info.event) {
        case 'remind': {
            const msg = reminderMessage(info.reason, info.workElapsedMs);
            showReminderCard('remind', msg);
            console.log(`[screen-rhythm] break reminder shown (reason: ${info.reason})`);
            if (bridge && typeof bridge.notifyBreak === 'function') {
                bridge.notifyBreak({ title: msg.title, body: msg.text }).catch(() => {});
            }
            break;
        }
        case 'snooze':
            hideReminderCard();
            break;
        case 'break':
            showReminderCard('break', {
                eyebrow: 'Screen break',
                title: 'Look away from your screen for a moment.',
                text: 'Find something far away and let your gaze rest there. ' +
                      'Your session keeps running in the background.',
            });
            updateBreakCountdown(breakReminder.opts.breakMs, breakReminder.opts.breakMs);
            break;
        case 'break-tick':
            updateBreakCountdown(info.breakRemainingMs || 0, breakReminder.opts.breakMs);
            break;
        case 'back': {
            const mins = Math.round(breakReminder.opts.intervalMs / MIN_MS);
            showReminderCard('back', {
                eyebrow: 'Welcome back',
                title: 'Nice. Back in your rhythm.',
                text: `Your next break suggestion is in ${mins} minute${mins === 1 ? '' : 's'}.`,
            });
            welcomeBackTimer = setTimeout(hideReminderCard, WELCOME_BACK_MS);
            break;
        }
        case 'away-reset':
            // No face data for a few minutes: treated as a natural break.
            if (els.reminder.dataset.mode === 'remind') hideReminderCard();
            console.log('[screen-rhythm] no face data for a while; screen-time clock reset');
            break;
        case 'stop':
            hideReminderCard();
            break;
        default:
            break;
    }
}

els.btnBreakTake.addEventListener('click', () => breakReminder.takeBreak());
els.btnBreakLater.addEventListener('click', () => breakReminder.notNow());
els.btnBreakBack.addEventListener('click', () => breakReminder.endBreak());
els.reminder.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.reminder.dataset.mode === 'remind') breakReminder.notNow();
});

els.breakInterval.value = String(loadBreakIntervalMin());
els.breakInterval.addEventListener('change', () => {
    const v = Number(els.breakInterval.value);
    if (!BREAK_INTERVAL_CHOICES.includes(v)) return;
    saveBreakIntervalMin(v);
    breakReminder.setIntervalMs(v * MIN_MS);
});

// Session over: freeze the final statistics on screen.
function endBlinkSession() {
    stopBlinkUi();
    blinkTimeline.stop();
    if (blinkFlashTimer) clearTimeout(blinkFlashTimer);
    blinkFlashTimer = null;
    els.blinkCard.dataset.state = 'idle';
    if (blinkTracker.validReadings > 0) {
        setBlinkLive('idle', 'Session ended');
    } else {
        setBlinkLive('idle', 'Not tracking');
        setTimelineEmpty('No blink data yet', 'Start a session to see your blink rhythm over the last minute.');
    }
    renderBlinkStats();
    if (blinkTracker.validReadings > 0) {
        console.log(`[screen-rhythm] blink session: ${blinkTracker.totalBlinks} blinks, ` +
            `${blinkTracker.validReadings} valid readings, ${blinkTracker.ignoredReadings} ignored, ` +
            `${blinkTracker.suppressedEdges} flicker edges suppressed, ${blinkTracker.gaps} data gaps`);
    }
}

function armFaceWatchdog() {
    if (faceWatchdog) clearTimeout(faceWatchdog);
    faceWatchdog = setTimeout(() => {
        if (phase === 'running' && faceSamples === 0) {
            setStep(els.stepFace, els.stepFaceSub, 'warn',
                'No results yet. Make sure your face is visible and well lit');
        }
    }, FACE_DATA_GRACE_MS);
}

function onFaceSamples(count) {
    if (count <= 0) return;
    const first = faceSamples === 0;
    faceSamples += count;
    setStep(els.stepFace, els.stepFaceSub, 'ok',
        `Receiving blink-detection updates (${faceSamples.toLocaleString()})`);
    if (first) console.log('[screen-rhythm] first blink-detection readings received');
}

// ---------------------------------------------------------------------------
// Error translation (friendly, honest messages)
// ---------------------------------------------------------------------------

const SDK_ERROR_TEXT = {
    [SmartSpectraErrorCode.kAuthenticationFailed]: {
        title: 'API key not accepted',
        message: 'Presage did not accept the API key. Check PRESAGE_API_KEY in your .env file ' +
                 '(from physiology.presagetech.com), then close and restart Screen Rhythm.',
    },
    [SmartSpectraErrorCode.kConfigurationFailed]: {
        title: 'SmartSpectra could not be configured',
        message: 'The SDK rejected the session settings. Please try again.',
    },
    [SmartSpectraErrorCode.kCreditExhausted]: {
        title: 'Presage account limit reached',
        message: 'Your Presage account has no remaining credits. Check the Presage developer portal.',
    },
    [SmartSpectraErrorCode.kNetworkError]: {
        title: 'Could not reach Presage',
        message: 'SmartSpectra needs an internet connection to verify your API key. ' +
                 'Check your connection and try again.',
    },
    [SmartSpectraErrorCode.kServerError]: {
        title: 'Presage service problem',
        message: 'The Presage service returned an error. Please try again in a moment.',
    },
    [SmartSpectraErrorCode.kInputUnavailable]: {
        title: 'Camera unavailable',
        message: 'SmartSpectra could not use the camera. Close other apps that may be using it, then try again.',
        cameraSettings: true,
    },
    [SmartSpectraErrorCode.kProcessingFailed]: {
        title: 'Processing stopped',
        message: 'SmartSpectra could not process the video. Please start a new session.',
    },
    [SmartSpectraErrorCode.kMetricNotAuthorized]: {
        title: 'Face analysis not enabled for this key',
        message: 'Your API key is not authorized for blink detection. Check your plan in the Presage developer portal.',
    },
    [SmartSpectraErrorCode.kSustainedLowFrameRate]: {
        title: 'Camera frame rate too low',
        message: 'The camera stayed below a usable frame rate, so the session ended. ' +
                 'Add more light, or close other apps using the camera or CPU.',
    },
};

function describeSdkError(code, message) {
    const known = SDK_ERROR_TEXT[code];
    if (known) return { ...known, detail: message ? `SmartSpectra: ${message}` : '' };
    return {
        title: 'SmartSpectra reported a problem',
        message: 'The session could not continue. Please try starting it again.',
        detail: message ? `SmartSpectra (code ${code}): ${message}` : `Code ${code}`,
    };
}

function describeStartError(err) {
    if (err && err.reason === 'no-key') {
        return {
            title: 'API key not found',
            message: 'Add PRESAGE_API_KEY to the .env file in your Screen Rhythm folder, ' +
                     'then close and restart the app.',
        };
    }
    const camName = err && err.cause && err.cause.name;
    if (camName === 'NotAllowedError' || camName === 'SecurityError') {
        return {
            title: 'Camera access is blocked',
            message: 'Windows may be blocking camera access for desktop apps. Open Settings → ' +
                     'Privacy & security → Camera, turn on "Camera access" and ' +
                     '"Let desktop apps access your camera", then try again.',
            cameraSettings: true,
        };
    }
    if (camName === 'NotFoundError' || camName === 'OverconstrainedError') {
        return {
            title: 'No camera found',
            message: 'Screen Rhythm could not find a webcam. Connect or enable a camera, then try again.',
            cameraSettings: true,
        };
    }
    if (camName === 'NotReadableError' || camName === 'AbortError') {
        return {
            title: 'Camera is busy',
            message: 'Another app (for example Teams, Zoom or the Camera app) may be using the webcam. ' +
                     'Close it, then try again.',
        };
    }
    if (err && err.code === 'SMARTSPECTRA_IPC_TIMEOUT') {
        return {
            title: 'SmartSpectra did not respond',
            message: 'The SmartSpectra engine did not answer in time. Close and restart Screen Rhythm, then try again.',
        };
    }
    if (err && typeof err.code === 'number') {
        return describeSdkError(err.code, err.message);
    }
    return {
        title: 'Could not start the session',
        message: 'Something prevented the session from starting. Please try again.',
        detail: err && err.message ? err.message : String(err),
    };
}

// ---------------------------------------------------------------------------
// Validation hints (shown as-is from the SDK, debounced by code)
// ---------------------------------------------------------------------------

const FALLBACK_HINTS = {
    [ValidationCode.kOk]:                 'Looking good. Your face is in view',
    [ValidationCode.kNoFaceFound]:        'Bring your face into view of the camera',
    [ValidationCode.kMultipleFacesFound]: 'Make sure only one person is in view',
    [ValidationCode.kFaceNotCentered]:    'Center your face in the preview',
    [ValidationCode.kTooDark]:            'It is a little dark. Add some light',
    [ValidationCode.kTooBright]:          'It is too bright. Move away from strong light',
    [ValidationCode.kCameraTuning]:       'Camera is adjusting…',
    [ValidationCode.kFrameRateTooLow]:    'Frame rate is low. Add light or close busy apps',
    [ValidationCode.kExcessiveMotion]:    'Try to hold still for a moment',
    [ValidationCode.kFaceTooClose]:       'Move a little further from the camera',
    [ValidationCode.kFaceTooFar]:         'Move a little closer to the camera',
    [ValidationCode.kFaceTooHigh]:        'Lower the camera or your position slightly',
    [ValidationCode.kFaceTooLow]:         'Raise the camera or your position slightly',
    [ValidationCode.kFaceNotForward]:     'Face the camera',
};

// True when SmartSpectra's own processed frame rate (from frameSentThrough)
// has stayed below MIN_USABLE_FPS for LOW_FPS_TIP_AFTER_S consecutive
// seconds. The preview rate is NOT used: the preview can show 30 fps while
// SmartSpectra processes fewer. If the SDK doesn't report frameSentThrough,
// its own warning is shown as-is.
function lowFpsConfirmed() {
    if (!sdkEventsSeen) return true;
    return sdkLowSeconds >= LOW_FPS_TIP_AFTER_S;
}

// Draws the preview hint chip from the latest SDK validation status.
// The SDK's frame-rate warning ("Use a camera mode that provides at least
// 25 frames per second.") is shown while SmartSpectra's processed frame rate
// stays low, and clears automatically when it recovers.
function renderHint() {
    const v = latestValidation;
    if (!v) { els.hint.hidden = true; return; }
    if (v.code === ValidationCode.kFrameRateTooLow && !lowFpsConfirmed()) {
        els.hint.hidden = true;
        return;
    }
    showHint(v.text, v.tone);
}

function onValidationStatus(code, _timestampUs, hint) {
    if (code === lastValidationCode) return;
    lastValidationCode = code;
    const text = (hint && hint.trim()) || FALLBACK_HINTS[code] || 'Adjusting…';
    const tone = code === ValidationCode.kOk ? 'ok' : 'warn';
    latestValidation = { code, text, tone };
    if (code === ValidationCode.kFrameRateTooLow && !lowFpsConfirmed()) {
        console.info('[screen-rhythm] SDK reported a low frame rate; showing it if SDK processed fps stays low');
    }
    renderHint();
}

// ---------------------------------------------------------------------------
// SDK lifecycle
// ---------------------------------------------------------------------------

function onProcessingStatus(status) {
    console.log(`[screen-rhythm] processingStatus -> ${STATUS_NAMES[status] || status}`);
    switch (status) {
        case ProcessingStatus.kStarting:
            setPill('busy', 'Preparing face analysis…');
            setStep(els.stepSdk, els.stepSdkSub, 'busy', 'Starting (the first run can take a minute)');
            setControls({ canStart: false, canStop: true });
            break;
        case ProcessingStatus.kRunning:
            phase = 'running';
            setPill('live', 'Session live');
            setStep(els.stepSdk, els.stepSdkSub, 'ok', 'Running');
            if (faceSamples === 0) {
                setStep(els.stepFace, els.stepFaceSub, 'busy', 'Waiting for the first result…');
                armFaceWatchdog();
            }
            setControls({ canStart: false, canStop: true });
            startTimer();
            startBlinkUi();
            startSdkThroughputMonitor();
            breakReminder.start();
            blinkTimeline.start();
            break;
        case ProcessingStatus.kStopping:
            setPill('busy', 'Stopping…');
            setControls({ canStart: false, canStop: false });
            break;
        case ProcessingStatus.kError:
            setPill('error', 'Needs attention');
            setStep(els.stepSdk, els.stepSdkSub, 'error', 'Stopped because of an error');
            // The 'error' event carries the details; release everything so
            // the user can simply start again.
            teardown({ keepError: true });
            break;
        default:
            break;
    }
}

function onMetrics(buf) {
    let metrics;
    try {
        metrics = decodeMetrics(buf);
    } catch (e) {
        console.warn('[screen-rhythm] could not decode a metrics packet:', e && e.message);
        return;
    }
    // Official field path: metrics.face?.blinking?.at(-1)?.detected
    // Each packet holds every reading since the previous packet, so the
    // whole array is passed to the detector (not just the last entry).
    const blinking = metrics && metrics.face && metrics.face.blinking;
    if (Array.isArray(blinking) && blinking.length > 0) {
        onFaceSamples(blinking.length);
        onBlinkReadings(blinking);
    }
}

function onSdkError(code, message, retryable) {
    console.warn(`[screen-rhythm] SDK error code=${code} retryable=${retryable}`);
    const info = describeSdkError(code, message);
    if (code === SmartSpectraErrorCode.kSustainedLowFrameRate) {
        const parts = [];
        if (lastSdkProcessedFps !== null) parts.push(`SmartSpectra processed ${fmtFps(lastSdkProcessedFps)}`);
        if (lastSdkInputFps !== null) parts.push(`received ${fmtFps(lastSdkInputFps)}`);
        if (lastMeasuredFps !== null) parts.push(`camera preview ${fmtFps(lastMeasuredFps)}`);
        if (lastPipeline) parts.push(`camera worker read ${lastPipeline.readFps}/s, sent ${lastPipeline.sentFps}/s`);
        if (parts.length) info.message += ` Last measured: ${parts.join(', ')}.`;
        if (lastSdkProcessedFps !== null && lastSdkInputFps !== null &&
            lastSdkProcessedFps < MIN_USABLE_FPS && lastSdkInputFps >= MIN_USABLE_FPS) {
            info.message += ' Your computer\'s processor was the limit: plug in your laptop, ' +
                            'set Windows Power mode to "Best performance", and close heavy apps.';
        }
    }
    showError(info);
}

// Shows the camera in the preview and starts the frame-rate measurement.
function attachPreview(stream) {
    els.preview.srcObject = stream;
    els.preview.play().catch(() => { /* muted preview; safe to ignore */ });
    setPreview('on');
    const track = stream.getVideoTracks()[0];
    const settings = track && track.getSettings ? track.getSettings() : {};
    const size = settings.width && settings.height ? ` · ${settings.width}×${settings.height}` : '';
    setStep(els.stepCamera, els.stepCameraSub, 'ok', `On${size}`);
    startFpsMonitor(els.preview);
}

// Only fires if the SDK opened the camera itself (not the case when we
// supply a stream with useMediaStream); kept as a safe fallback.
function onStreamAvailable(stream) {
    attachPreview(stream);
}

async function startSession() {
    if (phase !== 'idle') return;
    hideError();

    if (!bridge || typeof bridge.engineStart !== 'function') {
        showError({
            title: 'App bridge missing',
            message: 'Screen Rhythm could not connect to its main process. Rebuild with "npm start".',
        });
        return;
    }

    if (!(await checkEngine())) return;

    phase = 'starting';
    setControls({ canStart: false, canStop: false });
    setPill('busy', 'Starting…');
    setPreview('starting', 'Turning on camera…', 'Your camera light will switch on.');
    setStep(els.stepCamera, els.stepCameraSub, 'busy', 'Requesting access…');
    setStep(els.stepSdk, els.stepSdkSub, 'busy', 'Connecting…');
    setStep(els.stepFace, els.stepFaceSub, 'idle', 'Waiting for SmartSpectra');
    resetFaceIndicator();
    resetDiagnostics();
    // Pause decorative animations while a session runs, so the camera frame
    // pump (which shares this thread) has as much headroom as possible.
    document.body.classList.add('session-active');
    els.timer.textContent = '00:00';
    els.timerCaption.textContent = 'Starting…';

    try {
        // 1. Open the camera ourselves at 640x480, aiming for 30 fps.
        //    (Electron grants camera-only access to this page.)
        const cam = await acquireCamera();
        cameraStream = cam.stream;
        if (phase !== 'starting') { releaseCamera(); return; }
        showCameraSettings(cameraStream, cam.mode);
        attachPreview(cameraStream);

        // 2. Real SmartSpectra, running in the main process (the API key is
        //    read there from .env and never comes to this page).
        sdk = new EngineClient({ bridge, requestedMetrics: REQUESTED_METRICS });
        sdk.on('processingStatus', onProcessingStatus);
        sdk.on('validationStatus', onValidationStatus);
        sdk.on('metrics', onMetrics);
        sdk.on('error', onSdkError);
        sdk.on('frameSentThrough', onFrameSentThrough);
        sdk.on('pipelineStats', onPipelineStats);
        sdk.useMediaStream(cameraStream);

        // 3. Start SmartSpectra, then the worker frame pump.
        await sdk.start();
        if (phase === 'starting') setControls({ canStart: false, canStop: true });
    } catch (err) {
        console.warn('[screen-rhythm] start failed:', err && (err.cause && err.cause.name || err.code || err.message));
        const info = describeStartError(err);
        teardown({ keepError: true });
        showError(info);
        if (info.cameraSettings) setStep(els.stepCamera, els.stepCameraSub, 'error', 'Not available');
    }
}

async function stopSession() {
    if (!sdk || phase === 'stopping' || phase === 'idle') return;
    phase = 'stopping';
    setControls({ canStart: false, canStop: false });
    setPill('busy', 'Stopping…');
    try {
        await sdk.stop();       // releases the camera
    } catch (err) {
        console.warn('[screen-rhythm] stop() failed:', err && err.message);
    }
    teardown();
}

// Release the SDK + camera and return the UI to a ready state.
function teardown({ keepError = false } = {}) {
    if (sdk) {
        const old = sdk;
        sdk = null;
        try { old.destroy(); } catch { /* already destroyed */ }
    }
    phase = 'idle';
    stopTimer();
    if (faceWatchdog) clearTimeout(faceWatchdog);
    faceWatchdog = null;
    breakReminder.stop();   // clears its timer and hides any reminder
    hideReminderCard();
    endBlinkSession();

    // We own the camera stream (useMediaStream), so we must turn it off.
    stopFpsMonitor();
    stopSdkThroughputMonitor();
    releaseCamera();
    els.diag.dataset.state = 'idle';
    document.body.classList.remove('session-active');

    els.preview.srcObject = null;
    setPreview('off', 'Camera is off', 'It only turns on when you start a session.');
    hideHint();

    setStep(els.stepCamera, els.stepCameraSub, 'idle', 'Off');
    if (els.stepSdk.dataset.state !== 'error') {
        setStep(els.stepSdk, els.stepSdkSub, 'idle', 'Not running');
    }
    if (faceSamples > 0) {
        setStep(els.stepFace, els.stepFaceSub, 'idle',
            `Last session: ${faceSamples.toLocaleString()} updates received`);
    } else {
        setStep(els.stepFace, els.stepFaceSub, 'idle', 'Waiting for a session');
    }

    if (!keepError || els.errorBanner.hidden) setPill('neutral', 'Ready');
    else setPill('error', 'Needs attention');
    setControls({ canStart: true, canStop: false });
}

// ---------------------------------------------------------------------------
// Camera consent (user-initiated, explained before first use)
// ---------------------------------------------------------------------------

function hasConsent() {
    try { return localStorage.getItem(CONSENT_STORAGE_KEY) === 'yes'; } catch { return false; }
}

function saveConsent() {
    try { localStorage.setItem(CONSENT_STORAGE_KEY, 'yes'); } catch { /* fine: ask again next time */ }
}

function onStartClicked() {
    if (hasConsent()) {
        startSession();
    } else {
        els.consentDialog.showModal();
    }
}

els.btnConsentOk.addEventListener('click', () => {
    saveConsent();
    els.consentDialog.close();
    startSession();
});
els.btnConsentCancel.addEventListener('click', () => els.consentDialog.close());

// ---------------------------------------------------------------------------
// Wire up
// ---------------------------------------------------------------------------

els.btnStart.addEventListener('click', onStartClicked);
els.btnStop.addEventListener('click', stopSession);
els.btnDismissError.addEventListener('click', () => {
    hideError();
    if (phase === 'idle') setPill('neutral', 'Ready');
});
els.btnOpenSettings.addEventListener('click', () => {
    if (bridge && bridge.openCameraSettings) bridge.openCameraSettings();
});

window.addEventListener('beforeunload', () => {
    if (sdk) { try { sdk.destroy(); } catch { /* ignore */ } }
    releaseCamera();
});

resetDiagnostics();

// Shows a helpful message if the SmartSpectra engine could not load.
async function checkEngine() {
    let status;
    try {
        status = await bridge.getEngineStatus();
    } catch {
        return true; // no status available: let start() report any problem
    }
    if (status && status.ok) return true;
    if (status && status.reason === 'vcredist') {
        showError({
            title: 'A Windows component needs updating',
            message: 'The SmartSpectra engine needs the latest Microsoft Visual C++ Redistributable (x64). ' +
                     'Install it from Microsoft, then restart Screen Rhythm.',
            detail: status.detail,
        });
    } else {
        showError({
            title: 'SmartSpectra engine could not load',
            message: 'Screen Rhythm could not load the SmartSpectra SDK on this computer.',
            detail: (status && status.detail) || '',
        });
    }
    setStep(els.stepSdk, els.stepSdkSub, 'error', 'Engine not available');
    return false;
}

setPill('neutral', 'Ready');
setControls({ canStart: true, canStop: false });
if (bridge && typeof bridge.getEngineStatus === 'function') checkEngine();
