// src/break-reminder.js: gentle screen-break reminders for Screen Rhythm.
//
// Pure logic with an injectable clock and timer API, so it can be tested
// without a camera, the SDK or a DOM. The renderer supplies:
//   getSignals() -> { faceDataFresh: boolean, tracker: BlinkTracker }
//   onChange(state, info) -> update the UI
//
// States: 'idle' (no session) | 'working' | 'reminding' | 'break'
//
// When a reminder is suggested:
//   1. Time: `intervalMs` of screen time since the session started or since
//      the last break (default 20 minutes).
//   2. Blink activity (optional, conservative): after at least
//      `lowBlinkEarliestMs` of screen time, if the blink rate over the last
//      2 minutes of REAL face data has been under half of this session's own
//      earlier rate, continuously for `lowBlinkSustainMs`. This only compares
//      the user to themselves; it is not a medical interpretation.
//
// Safety rules:
//   - Only runs during an active session (start() / stop()).
//   - "Not now" snoozes; reminders never come closer together than
//     `minGapMs`.
//   - Missing, stale or patchy blink data never triggers a reminder.
//   - If no face data arrives for `awayResetMs`, the user is treated as
//     having stepped away (a natural break), and the screen-time clock resets.

'use strict';

const MIN = 60_000;

const DEFAULTS = Object.freeze({
    intervalMs: 20 * MIN,
    snoozeMs: 10 * MIN,
    minGapMs: 5 * MIN,
    breakMs: 20_000,             // suggested look-away time
    tickMs: 1_000,
    awayResetMs: 3 * MIN,
    lowBlinkEarliestMs: 10 * MIN,
    lowBlinkSustainMs: 60_000,
    blink: Object.freeze({
        windowUs: 120_000_000,           // last 2 min (matches BlinkTracker history)
        minWindowCoverageUs: 100_000_000, // need >= 100 s of real data in the window
        minBaselineCoverageUs: 180_000_000, // need >= 3 min of data before the window
        minBaselineBpm: 3,               // baseline too low = detection unreliable
        lowRatio: 0.5,                   // "low" = under half of the user's own baseline
    }),
});

/**
 * Compare the last `windowUs` of real blink data with the earlier part of
 * the same session. Returns { status: 'insufficient' | 'normal' | 'low', ... }.
 */
function assessBlinkActivity(tracker, opts = DEFAULTS.blink) {
    if (!tracker || tracker.lastTsUs == null) return { status: 'insufficient', why: 'no-data' };
    const end = tracker.lastTsUs;
    const start = end - opts.windowUs;

    let windowCoverageUs = 0;
    for (const [a, b] of tracker.segments) {
        const lo = Math.max(a, start);
        const hi = Math.min(b, end);
        if (hi > lo) windowCoverageUs += hi - lo;
    }
    if (windowCoverageUs < opts.minWindowCoverageUs) {
        return { status: 'insufficient', why: 'window-coverage', windowCoverageUs };
    }

    let windowBlinks = 0;
    for (const t of tracker.blinkTimesUs) if (t > start && t <= end) windowBlinks++;

    const baselineCoverageUs = tracker.coveredUs - windowCoverageUs;
    if (baselineCoverageUs < opts.minBaselineCoverageUs) {
        return { status: 'insufficient', why: 'baseline-coverage', baselineCoverageUs };
    }
    const baselineBlinks = Math.max(0, tracker.totalBlinks - windowBlinks);
    const baselineBpm = baselineBlinks / (baselineCoverageUs / 60_000_000);
    if (baselineBpm < opts.minBaselineBpm) {
        return { status: 'insufficient', why: 'baseline-rate', baselineBpm };
    }
    const windowBpm = windowBlinks / (windowCoverageUs / 60_000_000);
    const status = windowBpm < baselineBpm * opts.lowRatio ? 'low' : 'normal';
    return { status, windowBpm, baselineBpm, windowCoverageUs, baselineCoverageUs };
}

class BreakReminder {
    constructor({
        now = () => Date.now(),
        // Wrapped so the browser's setInterval is never called with a foreign
        // `this` (Chromium throws "Illegal invocation" in that case).
        timers = {
            setInterval: (fn, ms) => setInterval(fn, ms),
            clearInterval: (timerId) => clearInterval(timerId),
        },
        getSignals = () => ({ faceDataFresh: false, tracker: null }),
        onChange = () => {},
        ...options
    } = {}) {
        this.opts = { ...DEFAULTS, ...options, blink: { ...DEFAULTS.blink, ...(options.blink || {}) } };
        this.now = now;
        this.timers = timers;
        this.getSignals = getSignals;
        this.onChange = onChange;
        this.timerId = null;
        this._resetState();
    }

    _resetState() {
        this.state = 'idle';
        this.reason = null;
        this.workStart = null;
        this.nextAllowedAt = 0;
        this.lastShownAt = null;
        this.breakStart = null;
        this.lowSince = null;
        this.awaySince = null;
        this.lastAssessment = null;
    }

    get active() { return this.state !== 'idle'; }

    setIntervalMs(ms) {
        if (!(ms > 0)) return;
        this.opts.intervalMs = ms;
        this._emit('settings');
    }

    /** Session started. Idempotent. */
    start() {
        if (this.active) return;
        this._resetState();
        this.state = 'working';
        this.workStart = this.now();
        this.timerId = this.timers.setInterval(() => this.tick(), this.opts.tickMs);
        this._emit('start');
    }

    /** Session ended: stop the timer and clear everything. Idempotent. */
    stop() {
        if (this.timerId !== null) {
            this.timers.clearInterval(this.timerId);
            this.timerId = null;
        }
        const wasActive = this.active;
        this._resetState();
        if (wasActive) this._emit('stop');
    }

    /** "Not now": hide the reminder and snooze. */
    notNow() {
        if (this.state !== 'reminding') return;
        this.state = 'working';
        this.reason = null;
        this.lowSince = null;
        this.nextAllowedAt = Math.max(this.nextAllowedAt, this.now() + this.opts.snoozeMs);
        this._emit('snooze');
    }

    /** "Take a break": start the short look-away break. */
    takeBreak() {
        if (this.state !== 'reminding' && this.state !== 'working') return;
        this.state = 'break';
        this.breakStart = this.now();
        this._emit('break');
    }

    /** Break finished (timer or "I'm back"): reset the screen-time clock. */
    endBreak() {
        if (this.state !== 'break') return;
        this._restartWork();
        this._emit('back');
    }

    _restartWork() {
        const t = this.now();
        this.state = 'working';
        this.reason = null;
        this.workStart = t;
        this.breakStart = null;
        this.lowSince = null;
        this.nextAllowedAt = 0;
    }

    /** Milliseconds of screen time since the session start or last break. */
    workElapsedMs() {
        return this.workStart === null ? 0 : Math.max(0, this.now() - this.workStart);
    }

    /** Milliseconds until the time-based reminder (never negative). */
    nextReminderInMs() {
        if (this.state !== 'working') return null;
        const t = this.now();
        const due = Math.max(this.workStart + this.opts.intervalMs, this.nextAllowedAt);
        return Math.max(0, due - t);
    }

    breakRemainingMs() {
        if (this.state !== 'break') return null;
        return Math.max(0, this.breakStart + this.opts.breakMs - this.now());
    }

    tick() {
        if (!this.active) return;
        const t = this.now();

        if (this.state === 'break') {
            if (t - this.breakStart >= this.opts.breakMs) this.endBreak();
            else this._emit('break-tick');
            return;
        }

        let signals = {};
        try { signals = this.getSignals() || {}; } catch { signals = {}; }

        // Away detection: no face data for a while = the user stepped away.
        if (signals.faceDataFresh) {
            this.awaySince = null;
        } else {
            if (this.awaySince === null) this.awaySince = t;
            if (t - this.awaySince >= this.opts.awayResetMs) {
                this.awaySince = t;
                this._restartWork();
                this._emit('away-reset');
                return;
            }
        }

        if (this.state !== 'working') return;   // already reminding: wait for the user

        // Blink-activity signal (only with fresh, sufficient, real data).
        let lowBlink = false;
        if (signals.faceDataFresh && signals.tracker) {
            const a = assessBlinkActivity(signals.tracker, this.opts.blink);
            this.lastAssessment = a;
            if (a.status === 'low') {
                if (this.lowSince === null) this.lowSince = t;
                lowBlink = t - this.lowSince >= this.opts.lowBlinkSustainMs;
            } else {
                this.lowSince = null;
            }
        } else {
            this.lowSince = null;
        }

        const elapsed = t - this.workStart;
        const gapOk = this.lastShownAt === null || t - this.lastShownAt >= this.opts.minGapMs;
        const allowed = t >= this.nextAllowedAt && gapOk;
        if (!allowed) { this._emit('tick'); return; }

        let reason = null;
        if (elapsed >= this.opts.intervalMs) reason = 'time';
        else if (lowBlink && elapsed >= Math.min(this.opts.lowBlinkEarliestMs, this.opts.intervalMs)) reason = 'blink';

        if (reason) {
            this.state = 'reminding';
            this.reason = reason;
            this.lastShownAt = t;
            this._emit('remind');
        } else {
            this._emit('tick');
        }
    }

    _emit(event) {
        try {
            this.onChange(this.state, {
                event,
                reason: this.reason,
                workElapsedMs: this.workElapsedMs(),
                nextReminderInMs: this.nextReminderInMs(),
                breakRemainingMs: this.breakRemainingMs(),
            });
        } catch (e) {
            // UI errors must never break the reminder timer.
            if (typeof console !== 'undefined') console.warn('[break-reminder] onChange failed:', e && e.message);
        }
    }
}

module.exports = { BreakReminder, assessBlinkActivity, DEFAULTS };
