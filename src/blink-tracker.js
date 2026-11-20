// src/blink-tracker.js: turns SmartSpectra blink readings into blink events.
//
// Input: the `metrics.face.blinking` array from each decoded metrics packet.
// Each entry is a SmartSpectra `DetectionStatus`:
//   { detected: boolean, stable: boolean, timestamp: int64 microseconds }
// (verified against @smartspectra/node-sdk/messages generated.d.ts, v3.5.0).
//
// Each metrics packet carries every reading since the previous packet, so
// ALL entries are processed in order. Looking only at `.at(-1)` would miss
// a blink that starts and ends inside one packet.
//
// Counting rule (rising edge):
//   - A blink is counted when a valid reading goes false -> true.
//   - Consecutive `true` readings belong to the same blink (not re-counted).
//   - The detector re-arms only after a `false` reading.
//   - After a gap in the data (or at session start) a `false` reading is
//     required before the next blink can count, so a `true` seen after a gap
//     is never assumed to be a new blink.
//   - A second rising edge closer than `minBlinkIntervalUs` to the previous
//     counted blink is treated as flicker and not counted.
//   - Readings with a missing/invalid timestamp, a non-boolean `detected`,
//     or a timestamp not newer than the last one (duplicates / out of order)
//     are ignored.
//
// Note: protobuf omits `false` on the wire, so a reading with no `detected`
// value decodes as `false`. That is safe: `false` can never create a blink.

'use strict';

const DEFAULTS = Object.freeze({
    maxGapUs: 1_000_000,           // >1 s between readings = data gap
    minBlinkIntervalUs: 150_000,   // rising edges closer than 150 ms = flicker
    historyUs: 120_000_000,        // keep 2 min of events/segments for the timeline
});

function toMicros(ts) {
    if (ts == null) return NaN;
    if (typeof ts === 'number') return ts;
    if (typeof ts === 'bigint') return Number(ts);
    if (typeof ts.toNumber === 'function') return ts.toNumber();   // protobufjs Long
    if (typeof ts.low === 'number' && typeof ts.high === 'number') {
        return ts.high * 4294967296 + (ts.low >>> 0);
    }
    return Number(ts);
}

class BlinkTracker {
    constructor(options = {}) {
        this.opts = { ...DEFAULTS, ...options };
        this.reset();
    }

    reset() {
        this.totalBlinks = 0;
        this.validReadings = 0;
        this.stableReadings = 0;
        this.ignoredReadings = 0;
        this.suppressedEdges = 0;   // rising edges rejected as flicker
        this.gaps = 0;
        this.coveredUs = 0;         // time spanned by valid, gap-free readings
        this.firstTsUs = null;
        this.lastTsUs = null;
        this.lastBlinkTsUs = null;
        this.armed = false;
        this.current = null;        // latest valid `detected` value
        this.blinkTimesUs = [];     // recent counted blinks (for the timeline)
        this.segments = [];         // recent [startUs, endUs] spans with data
    }

    /**
     * Process one packet's readings, in order.
     * @returns {{ newBlinks: number[], latest: null | { detected: boolean, stable: boolean, tsUs: number } }}
     */
    ingest(readings) {
        const newBlinks = [];
        let latest = null;
        if (!Array.isArray(readings)) return { newBlinks, latest };

        for (const r of readings) {
            const tsUs = r ? toMicros(r.timestamp) : NaN;
            const detected = r ? r.detected : undefined;
            if (!Number.isFinite(tsUs) || tsUs <= 0 || typeof detected !== 'boolean') {
                this.ignoredReadings++;
                continue;
            }
            if (this.lastTsUs !== null && tsUs <= this.lastTsUs) {
                this.ignoredReadings++;   // duplicate or out-of-order reading
                continue;
            }

            if (this.lastTsUs === null) {
                this.firstTsUs = tsUs;
                this.segments.push([tsUs, tsUs]);
            } else if (tsUs - this.lastTsUs > this.opts.maxGapUs) {
                this.gaps++;
                this.armed = false;       // need a fresh `false` after a gap
                this.segments.push([tsUs, tsUs]);
            } else {
                this.coveredUs += tsUs - this.lastTsUs;
                this.segments[this.segments.length - 1][1] = tsUs;
            }

            this.validReadings++;
            if (r.stable === true) this.stableReadings++;

            if (!detected) {
                this.armed = true;
            } else if (this.armed) {
                this.armed = false;
                if (this.lastBlinkTsUs === null ||
                    tsUs - this.lastBlinkTsUs >= this.opts.minBlinkIntervalUs) {
                    this.totalBlinks++;
                    this.lastBlinkTsUs = tsUs;
                    this.blinkTimesUs.push(tsUs);
                    newBlinks.push(tsUs);
                } else {
                    this.suppressedEdges++;
                }
            }

            this.lastTsUs = tsUs;
            this.current = detected;
            latest = { detected, stable: r.stable === true, tsUs };
        }

        this._prune();
        return { newBlinks, latest };
    }

    _prune() {
        if (this.lastTsUs === null) return;
        const cutoff = this.lastTsUs - this.opts.historyUs;
        while (this.blinkTimesUs.length && this.blinkTimesUs[0] < cutoff) this.blinkTimesUs.shift();
        while (this.segments.length && this.segments[0][1] < cutoff) this.segments.shift();
    }

    /** Average blinks per minute over valid data time, or null if not enough data. */
    blinksPerMinute(minCoveredUs) {
        if (this.coveredUs < minCoveredUs) return null;
        return this.totalBlinks / (this.coveredUs / 60_000_000);
    }

    /** Readings per second over valid data time, or null if unknown. */
    readingsPerSecond() {
        if (this.coveredUs < 1_000_000 || this.validReadings < 2) return null;
        return (this.validReadings - 1) / (this.coveredUs / 1_000_000);
    }

    stableShare() {
        return this.validReadings ? this.stableReadings / this.validReadings : null;
    }
}

module.exports = { BlinkTracker, toMicros };
