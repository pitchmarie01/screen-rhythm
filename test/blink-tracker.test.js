// test/blink-tracker.test.js: unit tests for the blink event detector.
// Uses hand-written reading sequences (test fixtures only; the app itself
// uses real SmartSpectra readings).

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { BlinkTracker } = require('../src/blink-tracker');

const T0 = 1_700_000_000_000_000;
const ms = (n) => T0 + n * 1000;
const R = (t, d, extra = {}) => ({ timestamp: ms(t), detected: d, stable: true, ...extra });

test('counts only false -> true transitions', () => {
    const t = new BlinkTracker();
    t.ingest([R(0, true), R(33, true), R(66, false), R(100, true), R(133, true), R(166, true), R(200, false)]);
    assert.strictEqual(t.totalBlinks, 1);
});

test('counts a blink that starts and ends inside one packet', () => {
    const t = new BlinkTracker();
    const r = t.ingest([R(0, false), R(33, true), R(66, false)]);
    assert.strictEqual(t.totalBlinks, 1);
    assert.strictEqual(r.newBlinks.length, 1);
});

test('duplicate packets are not double counted', () => {
    const t = new BlinkTracker();
    const pkt = [R(0, false), R(33, true)];
    t.ingest(pkt);
    t.ingest(pkt);
    t.ingest([R(33, true), R(66, true)]);
    assert.strictEqual(t.totalBlinks, 1);
    assert.ok(t.ignoredReadings >= 3);
});

test('rising edges closer than 150 ms are treated as flicker', () => {
    const t = new BlinkTracker();
    t.ingest([R(0, false), R(33, true), R(66, false), R(100, true), R(400, false), R(433, true)]);
    assert.strictEqual(t.totalBlinks, 2);
    assert.strictEqual(t.suppressedEdges, 1);
});

test('after a data gap a false reading is required before the next blink', () => {
    const t = new BlinkTracker();
    t.ingest([R(0, false), R(33, false)]);
    t.ingest([R(2000, true), R(2033, false), R(2066, true)]);
    assert.strictEqual(t.totalBlinks, 1);
    assert.strictEqual(t.gaps, 1);
});

test('invalid readings are ignored and never become blinks', () => {
    const t = new BlinkTracker();
    t.ingest([R(0, false), { timestamp: 0, detected: true }, { timestamp: ms(40), detected: null }, null, { detected: true }, R(50, false)]);
    assert.strictEqual(t.totalBlinks, 0);
    assert.strictEqual(t.ignoredReadings, 4);
});

test('accepts protobuf Long-style timestamps', () => {
    const t = new BlinkTracker();
    const L = (n) => ({ toNumber: () => ms(n) });
    t.ingest([{ timestamp: L(0), detected: false }, { timestamp: L(33), detected: true }]);
    assert.strictEqual(t.totalBlinks, 1);
});

test('blinks per minute only after 60 s of valid data', () => {
    const t = new BlinkTracker();
    const arr = [];
    for (let i = 0; i <= 2000; i++) arr.push(R(i * 33, i % 60 === 30));
    t.ingest(arr.slice(0, 900));
    assert.strictEqual(t.blinksPerMinute(60e6), null);
    t.ingest(arr.slice(900));
    const bpm = t.blinksPerMinute(60e6);
    assert.ok(bpm > 29 && bpm < 31, `bpm ${bpm}`);
    assert.ok(Math.abs(t.readingsPerSecond() - 30.3) < 0.5);
});

test('reset clears session statistics', () => {
    const t = new BlinkTracker();
    t.ingest([R(0, false), R(33, true)]);
    t.reset();
    assert.strictEqual(t.totalBlinks, 0);
    assert.strictEqual(t.blinkTimesUs.length, 0);
    assert.strictEqual(t.lastTsUs, null);
});
