// src/blink-timeline.js: a lightweight live canvas of blink activity.
//
// Draws the last 60 seconds of REAL data from BlinkTracker:
//   - a thin baseline where SmartSpectra readings were received (gaps stay empty)
//   - one glowing bar per counted blink
// It redraws at most ~20 times per second and only while a session is live
// and the window is visible, so it doesn't compete with camera processing.

'use strict';

const WINDOW_US = 60_000_000;
const FRAME_INTERVAL_MS = 50;           // ~20 fps is plenty for a scrolling chart
const MAX_EXTRAPOLATE_US = 1_500_000;   // don't scroll past data for long

function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
}

class BlinkTimeline {
    constructor(canvas, tracker) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.tracker = tracker;
        this.running = false;
        this.raf = 0;
        this.lastDraw = 0;
        this.anchorTsUs = null;   // latest SDK timestamp seen
        this.anchorPerf = 0;      // performance.now() when it was seen
        this.newestBlinkPerf = 0;
        this.colors = {
            teal: cssVar('--accent', '#f2b733'),
            violet: cssVar('--accent-2', '#e39f1c'),
            text3: cssVar('--text-3', '#877f73'),
        };
        this.width = 0;
        this.height = 0;
        this._resize();
        if (typeof ResizeObserver === 'function') {
            new ResizeObserver(() => { this._resize(); this.draw(); }).observe(canvas);
        }
        this._loop = this._loop.bind(this);
        document.addEventListener('visibilitychange', () => {
            if (this.running && document.visibilityState === 'visible') this._schedule();
        });
    }

    _resize() {
        const rect = this.canvas.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        this.width = Math.max(1, Math.round(rect.width));
        this.height = Math.max(1, Math.round(rect.height));
        this.canvas.width = Math.round(this.width * dpr);
        this.canvas.height = Math.round(this.height * dpr);
        this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    /** Call whenever new readings arrive (tsUs = latest SDK timestamp). */
    anchor(tsUs) {
        if (tsUs == null) return;
        this.anchorTsUs = tsUs;
        this.anchorPerf = performance.now();
    }

    markBlink() {
        this.newestBlinkPerf = performance.now();
    }

    start() {
        this.running = true;
        this._schedule();
    }

    stop() {
        this.running = false;
        if (this.raf) cancelAnimationFrame(this.raf);
        this.raf = 0;
        this.anchorPerf = performance.now();   // freeze at the last data point
        this.draw(true);
    }

    clear() {
        this.anchorTsUs = null;
        this.newestBlinkPerf = 0;
        this.draw(true);
    }

    _schedule() {
        if (!this.raf) this.raf = requestAnimationFrame(this._loop);
    }

    _loop(now) {
        this.raf = 0;
        if (!this.running || document.visibilityState !== 'visible') return;
        if (now - this.lastDraw >= FRAME_INTERVAL_MS) {
            this.lastDraw = now;
            this.draw();
        }
        this._schedule();
    }

    draw(frozen = false) {
        const { ctx, width: w, height: h, colors } = this;
        ctx.clearRect(0, 0, w, h);

        const padX = 6;
        const baseY = h - 22;
        const topY = 12;
        const plotW = w - padX * 2;

        // Grid: every 10 s, with labels.
        ctx.font = '10.5px "Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif';
        ctx.textBaseline = 'alphabetic';
        for (let s = 0; s <= 60; s += 10) {
            const x = padX + plotW * (1 - s / 60);
            ctx.strokeStyle = 'rgba(255, 238, 205, 0.06)';
            ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(Math.round(x) + 0.5, topY);
            ctx.lineTo(Math.round(x) + 0.5, baseY);
            ctx.stroke();
            if (s % 30 === 0) {
                ctx.fillStyle = colors.text3;
                ctx.textAlign = s === 0 ? 'right' : s === 60 ? 'left' : 'center';
                ctx.fillText(s === 0 ? 'now' : `-${s}s`, x, h - 5);
            }
        }

        // Faint full-width baseline = "no data" track.
        ctx.strokeStyle = 'rgba(255, 238, 205, 0.10)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(padX, baseY + 0.5);
        ctx.lineTo(w - padX, baseY + 0.5);
        ctx.stroke();

        if (this.anchorTsUs == null) return;

        const elapsedUs = frozen ? 0 : Math.min((performance.now() - this.anchorPerf) * 1000, MAX_EXTRAPOLATE_US);
        const nowUs = this.anchorTsUs + elapsedUs;
        const startUs = nowUs - WINDOW_US;
        const xOf = (tsUs) => padX + plotW * ((tsUs - startUs) / WINDOW_US);

        // Coverage: where real readings were received.
        ctx.strokeStyle = 'rgba(242, 183, 51, 0.40)';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        for (const [a, b] of this.tracker.segments) {
            if (b < startUs) continue;
            const x1 = Math.max(padX, xOf(a));
            const x2 = Math.max(x1 + 1, xOf(b));
            ctx.beginPath();
            ctx.moveTo(x1, baseY + 0.5);
            ctx.lineTo(Math.min(x2, w - padX), baseY + 0.5);
            ctx.stroke();
        }

        // Blink bars.
        const grad = ctx.createLinearGradient(0, topY, 0, baseY);
        grad.addColorStop(0, colors.violet);
        grad.addColorStop(1, colors.teal);
        const times = this.tracker.blinkTimesUs;
        const newest = times.length ? times[times.length - 1] : null;
        const sinceNewestMs = performance.now() - this.newestBlinkPerf;
        const fullH = baseY - topY - 4;
        for (const t of times) {
            if (t < startUs) continue;
            const x = xOf(t);
            let barH = fullH * 0.78;
            let glow = 0;
            if (t === newest && !frozen && sinceNewestMs < 600) {
                const p = Math.min(1, sinceNewestMs / 260);
                barH = fullH * (0.35 + 0.65 * (1 - Math.pow(1 - p, 3)));
                glow = 14 * (1 - sinceNewestMs / 600);
            }
            ctx.save();
            if (glow > 0) {
                ctx.shadowColor = colors.teal;
                ctx.shadowBlur = glow;
            }
            ctx.fillStyle = grad;
            roundRect(ctx, x - 1.75, baseY - barH, 3.5, barH, 1.75);
            ctx.fill();
            ctx.restore();
        }
    }
}

function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
}

module.exports = { BlinkTimeline };
