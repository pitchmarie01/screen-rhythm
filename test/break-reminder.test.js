// test/break-reminder.test.js: reminder timing, snooze, break and cleanup.
// Uses a fake clock and fake timers; blink data here are test fixtures fed
// through the real BlinkTracker.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BreakReminder, assessBlinkActivity } = require('../src/break-reminder');
const { BlinkTracker } = require('../src/blink-tracker');

const MIN = 60_000;

// Fake clock + fake setInterval/clearInterval.
function harness({ signals, ...options } = {}) {
    let now = 1_000_000;
    const intervals = new Map();
    let nextId = 1;
    const timers = {
        setInterval(fn, ms) { const id = nextId++; intervals.set(id, { fn, ms }); return id; },
        clearInterval(id) { intervals.delete(id); },
    };
    const events = [];
    let sig = signals || { faceDataFresh: true, tracker: null };
    const reminder = new BreakReminder({
        now: () => now,
        timers,
        getSignals: () => sig,
        onChange: (state, info) => events.push({ state, ...info }),
        ...options,
    });
    // Advance time, firing the tick timer once per second like the real one.
    function advance(ms) {
        const end = now + ms;
        while (now < end) {
            now = Math.min(end, now + 1000);
            for (const { fn } of [...intervals.values()]) fn();
        }
    }
    return {
        reminder, timers, intervals, events, advance,
        setSignals(s) { sig = s; },
        get now() { return now; },
    };
}

test('no reminder before the interval, one reminder at 20 minutes', () => {
    const h = harness();
    h.reminder.start();
    h.advance(19 * MIN + 58_000);
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(3_000);
    assert.strictEqual(h.reminder.state, 'reminding');
    assert.strictEqual(h.reminder.reason, 'time');
    assert.strictEqual(h.events.filter((e) => e.event === 'remind').length, 1);
});

test('does nothing before start() and after stop()', () => {
    const h = harness();
    h.reminder.tick();
    assert.strictEqual(h.reminder.state, 'idle');
    h.reminder.start();
    h.reminder.stop();
    h.advance(30 * MIN);
    assert.strictEqual(h.reminder.state, 'idle');
    assert.strictEqual(h.events.filter((e) => e.event === 'remind').length, 0);
});

test('stop() clears its timer; start() is idempotent', () => {
    const h = harness();
    h.reminder.start();
    h.reminder.start();
    assert.strictEqual(h.intervals.size, 1);
    h.reminder.stop();
    assert.strictEqual(h.intervals.size, 0);
    assert.strictEqual(h.reminder.timerId, null);
    h.reminder.stop();   // safe to call twice
    assert.strictEqual(h.intervals.size, 0);
});

test('restart after stop begins a fresh 20-minute interval', () => {
    const h = harness();
    h.reminder.start();
    h.advance(15 * MIN);
    h.reminder.stop();
    h.reminder.start();
    h.advance(15 * MIN);
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(5 * MIN + 1000);
    assert.strictEqual(h.reminder.state, 'reminding');
});

test('"Not now" snoozes for 10 minutes and does not repeat sooner', () => {
    const h = harness();
    h.reminder.start();
    h.advance(20 * MIN + 1000);
    assert.strictEqual(h.reminder.state, 'reminding');
    h.reminder.notNow();
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(9 * MIN + 50_000);
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(15_000);
    assert.strictEqual(h.reminder.state, 'reminding');
    assert.strictEqual(h.events.filter((e) => e.event === 'remind').length, 2);
});

test('taking a break ends after 20 s and resets the screen-time clock', () => {
    const h = harness();
    h.reminder.start();
    h.advance(20 * MIN + 1000);
    h.reminder.takeBreak();
    assert.strictEqual(h.reminder.state, 'break');
    h.advance(10_000);
    assert.strictEqual(h.reminder.state, 'break');
    h.advance(11_000);
    assert.strictEqual(h.reminder.state, 'working');
    assert.ok(h.events.some((e) => e.event === 'back'));
    assert.ok(h.reminder.workElapsedMs() < 5_000);
    h.advance(19 * MIN);
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(1 * MIN + 1000);
    assert.strictEqual(h.reminder.state, 'reminding');
});

test('"I\'m back" ends a break early', () => {
    const h = harness();
    h.reminder.start();
    h.reminder.takeBreak();
    h.advance(5_000);
    h.reminder.endBreak();
    assert.strictEqual(h.reminder.state, 'working');
    assert.strictEqual(h.reminder.workElapsedMs(), 0);
});

test('stopping during a reminder or break cleans up fully', () => {
    for (const enterBreak of [false, true]) {
        const h = harness();
        h.reminder.start();
        h.advance(20 * MIN + 1000);
        if (enterBreak) h.reminder.takeBreak();
        h.reminder.stop();
        assert.strictEqual(h.reminder.state, 'idle');
        assert.strictEqual(h.reminder.reason, null);
        assert.strictEqual(h.intervals.size, 0);
        assert.strictEqual(h.reminder.nextReminderInMs(), null);
    }
});

test('no face data for 3 minutes counts as a natural break', () => {
    const h = harness();
    h.reminder.start();
    h.advance(15 * MIN);
    h.setSignals({ faceDataFresh: false, tracker: null });
    h.advance(3 * MIN + 1000);
    assert.ok(h.events.some((e) => e.event === 'away-reset'));
    assert.ok(h.reminder.workElapsedMs() < 5_000);
    h.setSignals({ faceDataFresh: true, tracker: null });
    h.advance(10 * MIN);
    assert.strictEqual(h.reminder.state, 'working');
});

test('short gaps in face data do not reset or trigger anything', () => {
    const h = harness();
    h.reminder.start();
    h.advance(5 * MIN);
    h.setSignals({ faceDataFresh: false, tracker: null });
    h.advance(30_000);
    h.setSignals({ faceDataFresh: true, tracker: null });
    h.advance(1000);
    assert.ok(!h.events.some((e) => e.event === 'away-reset'));
    assert.ok(h.reminder.workElapsedMs() > 5 * MIN);
});

test('a custom interval (demo mode) is respected', () => {
    const h = harness({ intervalMs: 1 * MIN });
    h.reminder.start();
    h.advance(59_000);
    assert.strictEqual(h.reminder.state, 'working');
    h.advance(2_000);
    assert.strictEqual(h.reminder.state, 'reminding');
});

// ---- Blink-activity assessment ------------------------------------------

const T0 = 1_700_000_000_000_000;
// Feed a tracker `seconds` of readings at 20/s with `bpm` evenly spaced blinks.
function feed(tracker, startS, seconds, bpm) {
    const readings = [];
    const step = 50; // ms
    const blinkEveryMs = bpm > 0 ? 60_000 / bpm : Infinity;
    let nextBlink = blinkEveryMs / 2;
    for (let ms = 0; ms < seconds * 1000; ms += step) {
        let detected = false;
        if (ms >= nextBlink && ms < nextBlink + 150) detected = true;
        if (ms >= nextBlink + 150) nextBlink += blinkEveryMs;
        readings.push({ timestamp: T0 + (startS * 1000 + ms) * 1000, detected, stable: true });
    }
    tracker.ingest(readings);
}

test('assessment is "insufficient" without enough real data', () => {
    const t = new BlinkTracker();
    assert.strictEqual(assessBlinkActivity(t).status, 'insufficient');
    feed(t, 0, 60, 15);
    assert.strictEqual(assessBlinkActivity(t).status, 'insufficient');
});

test('assessment is "normal" when recent activity matches the session', () => {
    const t = new BlinkTracker();
    feed(t, 0, 310, 15);
    const a = assessBlinkActivity(t);
    assert.strictEqual(a.status, 'normal', JSON.stringify(a));
});

test('assessment is "low" when recent activity is under half of earlier', () => {
    const t = new BlinkTracker();
    feed(t, 0, 240, 16);
    feed(t, 240, 120, 4);
    const a = assessBlinkActivity(t);
    assert.strictEqual(a.status, 'low', JSON.stringify(a));
});

test('patchy recent data is "insufficient", never "low"', () => {
    const t = new BlinkTracker();
    feed(t, 0, 240, 16);
    feed(t, 260, 30, 0);   // only 30 s of data in the last 2 min
    assert.strictEqual(assessBlinkActivity(t).status, 'insufficient');
});

test('sustained low blink activity can suggest a break after 10 minutes', () => {
    const tracker = new BlinkTracker();
    feed(tracker, 0, 240, 16);
    feed(tracker, 240, 120, 4);
    const h = harness({ signals: { faceDataFresh: true, tracker } });
    h.reminder.start();
    h.advance(9 * MIN);
    assert.strictEqual(h.reminder.state, 'working', 'not before 10 minutes');
    h.advance(1 * MIN + 2000);
    assert.strictEqual(h.reminder.state, 'reminding');
    assert.strictEqual(h.reminder.reason, 'blink');
});

test('low blink activity needs to last 60 s and fresh data', () => {
    const tracker = new BlinkTracker();
    feed(tracker, 0, 240, 16);
    feed(tracker, 240, 120, 4);
    const h = harness({ signals: { faceDataFresh: true, tracker } });
    h.reminder.start();
    h.advance(8 * MIN);
    // Data goes stale (under the 3-minute away limit) past the 10-minute mark:
    // stale data must never trigger a blink-based reminder.
    h.setSignals({ faceDataFresh: false, tracker });
    h.advance(2 * MIN + 30_000);
    assert.strictEqual(h.reminder.state, 'working', 'stale data must not trigger');
    h.setSignals({ faceDataFresh: true, tracker });
    h.advance(30_000);
    assert.strictEqual(h.reminder.state, 'working', 'needs 60 s sustained');
    h.advance(31_000);
    assert.strictEqual(h.reminder.state, 'reminding');
});

test('default timers work when setInterval requires the global `this` (browser behaviour)', () => {
    // Chromium throws "Illegal invocation" if window.setInterval is called as
    // a method of another object. Recreate that strictness here.
    const realSet = globalThis.setInterval;
    const realClear = globalThis.clearInterval;
    const calls = [];
    globalThis.setInterval = function (fn, ms) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        calls.push(ms);
        return 42;
    };
    globalThis.clearInterval = function (timerId) {
        if (this !== undefined && this !== globalThis) throw new TypeError('Illegal invocation');
        calls.push(`clear:${timerId}`);
    };
    try {
        const r = new BreakReminder({ getSignals: () => ({ faceDataFresh: true, tracker: null }) });
        r.start();
        assert.strictEqual(r.state, 'working');
        r.stop();
        assert.deepStrictEqual(calls, [1000, 'clear:42']);
    } finally {
        globalThis.setInterval = realSet;
        globalThis.clearInterval = realClear;
    }
});

test('a throwing UI callback does not break the reminder', () => {
    let now = 0;
    const r = new BreakReminder({
        now: () => now,
        timers: { setInterval: () => 1, clearInterval: () => {} },
        getSignals: () => ({ faceDataFresh: true, tracker: null }),
        onChange: () => { throw new Error('ui'); },
        intervalMs: 1000,
    });
    const warn = console.warn;
    console.warn = () => {};
    try {
        r.start();
        now = 2000;
        r.tick();
    } finally {
        console.warn = warn;
    }
    assert.strictEqual(r.state, 'reminding');
});
