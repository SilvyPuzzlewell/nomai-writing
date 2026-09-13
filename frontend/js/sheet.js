/**
 * Draggable bottom sheet for the translation panel.
 *
 * Active only below the 900px breakpoint, where the panel is absolutely
 * positioned over a full-height canvas. Above it the panel is an ordinary
 * sidebar and every method here is a no-op, so callers never need to
 * branch on viewport size.
 *
 * Three snap points:
 *   peek - just the drag handle and panel header (writer, progress, preview)
 *   half - roughly half the viewport
 *   full - the whole sheet
 *
 * Dragging moves the sheet with `transform: translateY()` so it stays on the
 * compositor; the snap itself is a CSS transition toggled by a class.
 */
class BottomSheet {
    static PEEK = 'peek';
    static HALF = 'half';
    static FULL = 'full';

    constructor(el, options = {}) {
        this.el = el;
        this.grabs = options.grabs || [];
        this.scroller = options.scroller || null;
        this.onSnap = options.onSnap || (() => {});
        this.haptics = options.haptics !== false;

        this.mq = window.matchMedia('(max-width: 900px)');
        this.state = BottomSheet.PEEK;
        this.offsets = { peek: 0, half: 0, full: 0 };
        this.drag = null;

        this.bindGrabs();

        // matchMedia keeps the sheet and the sidebar from fighting over the
        // same inline transform when the window crosses the breakpoint
        this.mq.addEventListener('change', () => this.sync());
        window.addEventListener('resize', () => this.sync());
        window.addEventListener('orientationchange', () => this.sync());

        this.sync();
    }

    get enabled() {
        return this.mq.matches;
    }

    /**
     * Recompute snap offsets and re-apply the current state. Safe to call at
     * any time; clears the inline transform when the sheet is inactive.
     */
    sync() {
        if (!this.enabled) {
            this.el.style.transform = '';
            this.el.classList.remove('sheet-animating', 'sheet-peek', 'sheet-half', 'sheet-full');
            return;
        }
        this.measure();
        this.apply(this.state, false);
    }

    /**
     * Measure the snap offsets. `peek` is whatever the handle plus panel
     * header actually occupy, so the collapsed sheet is never cropped mid-row
     * however the header content grows.
     */
    measure() {
        const height = this.el.offsetHeight || 1;

        let peekHeight = 0;
        for (const el of this.grabs) peekHeight += el.offsetHeight || 0;
        if (peekHeight < 40) peekHeight = 96; // pre-layout fallback

        // Drives #canvas-controls and #toast-container, which sit above the
        // collapsed sheet
        document.documentElement.style.setProperty('--sheet-peek', `${Math.round(peekHeight)}px`);

        const halfHeight = Math.min(height, Math.round(window.innerHeight * 0.55));
        this.offsets = {
            full: 0,
            half: Math.max(0, height - halfHeight),
            peek: Math.max(0, height - Math.round(peekHeight))
        };
    }

    /**
     * Move to a snap point.
     * @param {string} state - one of peek/half/full
     * @param {boolean} animate
     */
    apply(state, animate = true) {
        this.state = state;
        this.el.classList.toggle('sheet-animating', animate);
        this.el.classList.toggle('sheet-peek', state === BottomSheet.PEEK);
        this.el.classList.toggle('sheet-half', state === BottomSheet.HALF);
        this.el.classList.toggle('sheet-full', state === BottomSheet.FULL);
        const handle = this.el.querySelector('#sheet-handle');
        if (handle) {
            handle.setAttribute('aria-expanded', String(state !== BottomSheet.PEEK));
            handle.setAttribute('aria-label', state === BottomSheet.PEEK ? 'Expand translation panel' : 'Collapse translation panel');
        }

        if (!this.enabled) return;

        // The peek offset depends on the header height, which the .sheet-peek
        // class can change (it reveals the preview line) - so re-measure after
        // the class lands rather than before.
        if (state === BottomSheet.PEEK) this.measure();

        this.el.style.transform = `translateY(${this.offsets[state]}px)`;
    }

    /**
     * Public snap, with an optional haptic tick. No-op above the breakpoint.
     */
    snapTo(state, { silent = false } = {}) {
        if (!this.enabled) {
            this.state = state;
            return;
        }
        const changed = this.state !== state;
        this.apply(state, true);
        if (changed && !silent) {
            this.tick();
            this.onSnap(state);
        }
    }

    /** Raise a collapsed sheet to half; leave it alone if already open. */
    reveal() {
        if (this.enabled && this.state === BottomSheet.PEEK) this.snapTo(BottomSheet.HALF);
    }

    /** Drop the sheet back to peek. */
    collapse() {
        if (this.enabled && this.state !== BottomSheet.PEEK) this.snapTo(BottomSheet.PEEK);
    }

    tick() {
        if (!this.haptics) return;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
        if (navigator.vibrate) navigator.vibrate(6);
    }

    // =========================================================================
    // Drag
    // =========================================================================

    bindGrabs() {
        for (const el of this.grabs) {
            el.addEventListener('pointerdown', (e) => this.onPointerDown(e, el));
            if (el.id === 'sheet-handle') el.addEventListener('click', event => {
                // Pointer taps are handled on release; native keyboard clicks
                // have no pointer gesture and still need an accessible action.
                if (event.detail === 0) this.snapTo(this.state === BottomSheet.PEEK ? BottomSheet.HALF : BottomSheet.PEEK);
            });
        }
        this.el.addEventListener('pointermove', (e) => this.onPointerMove(e));
        this.el.addEventListener('pointerup', (e) => this.onPointerUp(e));
        this.el.addEventListener('pointercancel', (e) => this.onPointerUp(e));
    }

    onPointerDown(event, grabEl) {
        if (!this.enabled) return;
        // Controls inside the header (e.g. Delete) keep their own taps
        if (event.target.closest('button, a, input, select, textarea') && grabEl.id !== 'sheet-handle') return;

        this.drag = {
            id: event.pointerId,
            startY: event.clientY,
            startOffset: this.offsets[this.state],
            lastY: event.clientY,
            lastT: event.timeStamp,
            velocity: 0,
            moved: false
        };
        grabEl.setPointerCapture(event.pointerId);
        this.el.classList.remove('sheet-animating');
    }

    onPointerMove(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.id) return;

        const dy = event.clientY - drag.startY;
        if (!drag.moved && Math.abs(dy) < 3) return;
        drag.moved = true;

        const dt = event.timeStamp - drag.lastT;
        if (dt > 0) drag.velocity = (event.clientY - drag.lastY) / dt; // px/ms
        drag.lastY = event.clientY;
        drag.lastT = event.timeStamp;

        const max = this.offsets.peek;
        let offset = drag.startOffset + dy;
        // Rubber-band past the ends instead of stopping dead
        if (offset < 0) offset /= 3;
        else if (offset > max) offset = max + (offset - max) / 3;

        this.el.style.transform = `translateY(${offset}px)`;
    }

    onPointerUp(event) {
        const drag = this.drag;
        if (!drag || event.pointerId !== drag.id) return;
        this.drag = null;

        if (!drag.moved) {
            // A tap on the handle toggles between peek and half
            if (event.target.closest('#sheet-handle')) {
                this.snapTo(this.state === BottomSheet.PEEK ? BottomSheet.HALF : BottomSheet.PEEK);
            } else {
                this.apply(this.state, true);
            }
            return;
        }

        const offset = drag.startOffset + (drag.lastY - drag.startY);

        // A decisive flick skips to the neighbouring snap point regardless of
        // how far the sheet actually travelled
        const FLICK = 0.5; // px/ms
        if (Math.abs(drag.velocity) > FLICK) {
            const order = [BottomSheet.FULL, BottomSheet.HALF, BottomSheet.PEEK];
            const at = order.indexOf(this.nearest(offset));
            const next = drag.velocity > 0 ? at + 1 : at - 1;
            this.snapTo(order[Math.max(0, Math.min(order.length - 1, next))]);
            return;
        }

        this.snapTo(this.nearest(offset));
    }

    /** Closest snap point to a pixel offset. */
    nearest(offset) {
        let best = this.state;
        let bestDist = Infinity;
        for (const state of [BottomSheet.PEEK, BottomSheet.HALF, BottomSheet.FULL]) {
            const dist = Math.abs(this.offsets[state] - offset);
            if (dist < bestDist) {
                bestDist = dist;
                best = state;
            }
        }
        return best;
    }
}

window.BottomSheet = BottomSheet;
