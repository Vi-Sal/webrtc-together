import { $, el, throttle } from '../utils/dom.js';
import { randomId } from '../utils/ids.js';
import { cursorColor } from '../utils/format.js';
import { BoardModel } from './model.js';
import { BoardRenderer, renderExport } from './renderer.js';
import { MAX_LIVE_VALUES, MAX_STROKE_VALUES, farEnough, fitBoard, normalize, quantize, textSize } from './geometry.js';
import { confirmAction } from '../components/feedback.js';

export const SWATCHES = [
    { color: '#243341', name: 'Ink' },
    { color: '#2F6F92', name: 'Glacier blue' },
    { color: '#3E7C6B', name: 'Pine' },
    { color: '#D97B3C', name: 'Amber' },
    { color: '#C2453E', name: 'Coral red' },
    { color: '#8A5A7A', name: 'Plum' }
];
const TOOL_KEYS = { p: 'pen', e: 'eraser', l: 'line', r: 'rect', o: 'ellipse', t: 'text' };
const SHAPES = new Set(['line', 'rect', 'ellipse']);
const LIVE_SEND_MS = 50;
const CURSOR_SEND_MS = 70;
const LIVE_STALE_MS = 4000;
const CURSOR_IDLE_MS = 4000;

/**
 * Collaborative whiteboard. Drawing is sent as compact operations, never as images:
 * in-progress strokes stream as throttled `board-live` deltas (ephemeral), and finished
 * operations are committed with `board-add`, which the server sequences for everyone.
 */
export class Whiteboard {
    constructor({ send, nameOf, onRemoteActivity, onNotice, fileName }) {
        this.send = send;
        this.nameOf = nameOf;
        this.onRemoteActivity = onRemoteActivity;
        this.onNotice = onNotice;
        this.fileName = fileName;
        this.model = new BoardModel();
        this.surface = $('board-surface');
        this.canvas = $('board-canvas');
        this.renderer = new BoardRenderer(this.canvas);
        this.tool = 'pen';
        this.color = SWATCHES[0].color;
        this.brush = 4;
        this.visible = false;
        this.active = null;      // the local stroke being drawn
        this.live = new Map();   // participant ID → their in-progress element
        this.cursors = new Map(); // participant ID → { node, timer }
        this.frame = 0;
        this.fullRedraw = true;
        this.lastSync = 0;
        this.sendLive = throttle(() => this.#sendLive(), LIVE_SEND_MS);
        this.sendCursor = throttle(point => this.send(point ? { type: 'board-cursor', points: point } : { type: 'board-cursor', hidden: true }), CURSOR_SEND_MS);
        this.cleanups = [];
        this.#buildToolbar();
        this.#bindPointer();
        this.#bindKeys();
        this.resizeObserver = new ResizeObserver(() => this.#resize());
        this.resizeObserver.observe($('board-area'));
        this.#watchPixelRatio();
    }

    setSelf(id) {
        this.model.selfId = id;
    }

    /** Snapshot from `joined` or `board-snapshot`; unconfirmed local work is resent. */
    load(snapshot) {
        this.model.loadSnapshot(snapshot);
        for (const element of this.model.unconfirmed()) this.send({ type: 'board-add', element: this.#wire(element) });
        this.#invalidate(true);
    }

    handle(message) {
        switch (message.type) {
            case 'board-snapshot':
                this.load(message);
                return;
            case 'board-live':
                this.#receiveLive(message);
                return;
            case 'board-cursor':
                this.#receiveCursor(message);
                return;
            case 'error':
                if (message.ref) this.model.dropPending(message.ref);
                this.onNotice(message.message || 'That drawing could not be saved.');
                this.#invalidate(true);
                return;
        }
        const result = this.model.apply(message);
        if (result.gap) {
            this.#requestSync();
            return;
        }
        if (message.type === 'board-add') {
            this.live.delete(message.element.author);
            if (message.element.author !== this.model.selfId && !this.visible) this.onRemoteActivity();
        }
        if (message.type === 'board-clear' && message.by !== this.model.selfId) {
            this.onNotice(`${message.name} cleared the whiteboard.`, true);
        }
        if (result.render === 'append' && !this.fullRedraw) {
            if (this.renderer.width) this.renderer.append(result.element);
            this.#invalidate(false);
        } else if (result.render) {
            this.#invalidate(true);
        }
    }

    participantLeft(id) {
        this.live.delete(id);
        this.#removeCursor(id);
        this.#invalidate(false);
    }

    setVisible(visible) {
        this.visible = visible;
        if (visible) {
            this.#resize();
            this.#invalidate(true);
        } else {
            this.#cancelActive();
            this.sendCursor(null);
            this.#closeTextInput(false);
        }
    }

    destroy() {
        cancelAnimationFrame(this.frame);
        this.resizeObserver.disconnect();
        this.sendLive.cancel();
        this.sendCursor.cancel();
        for (const cleanup of this.cleanups) cleanup();
        for (const id of [...this.cursors.keys()]) this.#removeCursor(id);
        this.#closeTextInput(false);
        $('board-swatches').replaceChildren();
    }

    setTool(tool) {
        this.#closeTextInput(true);
        this.tool = tool;
        this.surface.dataset.tool = tool;
        for (const button of document.querySelectorAll('.tool-btn[data-tool]')) {
            button.setAttribute('aria-pressed', String(button.dataset.tool === tool));
        }
    }

    setColor(color) {
        this.color = color;
        $('board-color').value = color;
        for (const swatch of $('board-swatches').children) swatch.setAttribute('aria-pressed', String(swatch.dataset.color === color));
        this.#syncSizeDot();
    }

    undo() {
        const id = this.model.takeUndo();
        if (id) this.send({ type: 'board-undo', id });
        this.#syncHistoryButtons();
    }

    redo() {
        const id = this.model.takeRedo();
        if (id) this.send({ type: 'board-redo', id });
        this.#syncHistoryButtons();
    }

    async clear() {
        const confirmed = await confirmAction({
            title: 'Clear the whiteboard?',
            body: 'This removes every drawing for everyone in the meeting. It can’t be undone. Export a PNG first if you want to keep it.',
            confirmLabel: 'Clear for everyone'
        });
        if (confirmed && !this.send({ type: 'board-clear' })) this.onNotice('You’re offline. Try again when reconnected.');
    }

    exportPng() {
        const canvas = renderExport([...this.model.visible(), ...this.model.pending.values()]);
        canvas.toBlob(blob => {
            if (!blob) return;
            const url = URL.createObjectURL(blob);
            const link = el('a', { attrs: { href: url, download: this.fileName() } });
            document.body.append(link);
            link.click();
            link.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        }, 'image/png');
    }

    #buildToolbar() {
        const swatches = $('board-swatches');
        for (const { color, name } of SWATCHES) {
            const swatch = el('button', {
                className: 'swatch',
                attrs: { type: 'button', 'aria-label': name, 'aria-pressed': String(color === this.color), 'data-tooltip': name },
                dataset: { color }
            });
            swatch.style.setProperty('--swatch', color);
            swatch.onclick = () => this.setColor(color);
            swatches.append(swatch);
        }
        for (const button of document.querySelectorAll('.tool-btn[data-tool]')) button.onclick = () => this.setTool(button.dataset.tool);
        $('board-color').oninput = event => this.setColor(event.target.value);
        $('board-size').oninput = event => { this.brush = Number(event.target.value); this.#syncSizeDot(); };
        $('board-undo').onclick = () => this.undo();
        $('board-redo').onclick = () => this.redo();
        $('board-clear').onclick = () => this.clear();
        $('board-export').onclick = () => this.exportPng();
        this.brush = Number($('board-size').value);
        this.setTool('pen');
        this.setColor(this.color);
    }

    #syncSizeDot() {
        const dot = $('board-size-dot');
        dot.style.setProperty('--dot', `${Math.min(22, Math.max(3, this.brush * 0.9))}px`);
        dot.style.setProperty('--board-color', this.tool === 'eraser' ? 'var(--text-tertiary)' : this.color);
        $('board-size').setAttribute('aria-valuetext', `${this.brush}`);
    }

    #syncHistoryButtons() {
        $('board-undo').disabled = !this.model.canUndo();
        $('board-redo').disabled = !this.model.canRedo();
        $('board-empty').hidden = !this.model.isEmpty() || !!this.active;
    }

    #bindPointer() {
        const canvas = this.canvas;
        const point = event => normalize(event.clientX, event.clientY, canvas.getBoundingClientRect());
        const listen = (type, handler) => {
            canvas.addEventListener(type, handler);
            this.cleanups.push(() => canvas.removeEventListener(type, handler));
        };
        listen('pointerdown', event => {
            if (this.active || (event.pointerType === 'mouse' && event.button !== 0)) return;
            const [x, y] = point(event);
            if (this.tool === 'text') {
                event.preventDefault();
                this.#openTextInput(x, y);
                return;
            }
            this.#closeTextInput(true);
            canvas.setPointerCapture(event.pointerId);
            this.#begin(event.pointerId, x, y);
        });
        listen('pointermove', event => {
            const [x, y] = point(event);
            if (event.pointerType !== 'touch') this.sendCursor([x, y]);
            if (!this.active || this.active.pointerId !== event.pointerId) return;
            const samples = event.getCoalescedEvents?.() ?? [];
            for (const sample of samples.length ? samples : [event]) this.#extend(...point(sample));
            this.sendLive();
            this.#invalidate(false);
        });
        const finish = event => {
            if (this.active?.pointerId === event.pointerId) this.#commit();
        };
        listen('pointerup', finish);
        listen('pointercancel', event => { if (this.active?.pointerId === event.pointerId) this.#cancelActive(); });
        listen('pointerleave', event => { if (event.pointerType !== 'touch') this.sendCursor(null); });
    }

    #bindKeys() {
        const onKey = event => {
            if (!this.visible || event.defaultPrevented || document.querySelector('dialog[open]')) return;
            const target = event.target;
            if (target instanceof HTMLElement && target.closest('input, textarea, select, [contenteditable="true"]')) return;
            const mod = event.ctrlKey || event.metaKey;
            const key = event.key.toLowerCase();
            if (mod && key === 'z') { event.preventDefault(); event.shiftKey ? this.redo() : this.undo(); }
            else if (mod && key === 'y') { event.preventDefault(); this.redo(); }
            else if (!mod && !event.altKey && TOOL_KEYS[key]) { this.setTool(TOOL_KEYS[key]); }
            else if (event.key === 'Escape' && this.active) this.#cancelActive();
        };
        document.addEventListener('keydown', onKey);
        this.cleanups.push(() => document.removeEventListener('keydown', onKey));
    }

    #begin(pointerId, x, y) {
        const kind = this.tool;
        this.active = {
            pointerId, sent: 0,
            element: {
                id: randomId(14), kind, author: this.model.selfId,
                color: kind === 'eraser' ? '#000000' : this.color,
                size: kind === 'eraser' ? Math.max(6, this.brush * 3) : this.brush,
                points: SHAPES.has(kind) ? [x, y, x, y] : [x, y]
            }
        };
        $('board-empty').hidden = true;
        this.sendLive();
        this.#invalidate(false);
    }

    #extend(x, y) {
        const element = this.active.element;
        if (SHAPES.has(element.kind)) {
            element.points[2] = x;
            element.points[3] = y;
            return;
        }
        if (!farEnough(element.points, x, y)) return;
        element.points.push(x, y);
        // Long strokes are split into chained segments that each fit the server limit.
        if (element.points.length >= MAX_STROKE_VALUES) {
            const pointerId = this.active.pointerId;
            this.#commit();
            this.#begin(pointerId, x, y);
        }
    }

    #sendLive() {
        const active = this.active;
        if (!active) return;
        const { element } = active;
        const points = SHAPES.has(element.kind) ? element.points : element.points.slice(active.sent, active.sent + MAX_LIVE_VALUES);
        if (!points.length) return;
        if (!SHAPES.has(element.kind)) active.sent += points.length;
        this.send({ type: 'board-live', id: element.id, kind: element.kind, color: element.color, size: element.size, points });
    }

    #commit() {
        const active = this.active;
        if (!active) return;
        this.sendLive.flush();
        this.active = null;
        const element = active.element;
        const p = element.points;
        // A click with a shape tool draws nothing.
        if (SHAPES.has(element.kind) && Math.abs(p[2] - p[0]) < 0.002 && Math.abs(p[3] - p[1]) < 0.002) {
            this.#invalidate(false);
            this.#syncHistoryButtons();
            return;
        }
        this.#publish(element);
    }

    #publish(element) {
        this.model.addLocal(element);
        this.send({ type: 'board-add', element: this.#wire(element) }); // Pending work is resent on reconnect.
        this.#invalidate(false);
        this.#syncHistoryButtons();
    }

    #cancelActive() {
        if (!this.active) return;
        this.sendLive.cancel();
        this.active = null;
        this.#invalidate(false);
        this.#syncHistoryButtons();
    }

    #wire(element) {
        const wire = { id: element.id, kind: element.kind, color: element.color, size: element.size, points: element.points.map(quantize) };
        if (element.kind === 'text') wire.text = element.text;
        return wire;
    }

    #openTextInput(x, y) {
        this.#closeTextInput(true);
        const { width, height } = this.renderer;
        const size = textSize(this.brush);
        const input = el('input', {
            className: 'board-text-input',
            attrs: { type: 'text', maxlength: '200', 'aria-label': 'Text to place on the whiteboard', enterkeyhint: 'done' }
        });
        input.style.left = `${x * width}px`;
        input.style.top = `${y * height}px`;
        input.style.fontSize = `${(size * width) / 1000}px`;
        input.style.color = this.color;
        input.style.setProperty('color', this.color, 'important');
        input.dataset.x = String(x);
        input.dataset.y = String(y);
        input.onkeydown = event => {
            if (event.key === 'Enter') { event.preventDefault(); this.#closeTextInput(true); }
            else if (event.key === 'Escape') { event.preventDefault(); this.#closeTextInput(false); }
        };
        input.onblur = () => this.#closeTextInput(true);
        this.surface.append(input);
        this.textInput = input;
        requestAnimationFrame(() => input.focus());
    }

    #closeTextInput(commit) {
        const input = this.textInput;
        if (!input) return;
        this.textInput = null;
        input.onblur = null;
        const text = input.value.replace(/\s+/g, ' ').trim();
        input.remove();
        if (!commit || !text) return;
        this.#publish({
            id: randomId(14), kind: 'text', author: this.model.selfId, color: this.color,
            size: textSize(this.brush), points: [quantize(Number(input.dataset.x)), quantize(Number(input.dataset.y))],
            text: [...text].slice(0, 200).join('')
        });
    }

    #receiveLive(message) {
        const current = this.live.get(message.from);
        if (current && current.id === message.id && !SHAPES.has(message.kind)) {
            current.points.push(...message.points);
            current.updated = performance.now();
        } else {
            this.live.set(message.from, { ...message, points: [...message.points], updated: performance.now() });
        }
        this.#invalidate(false);
    }

    #receiveCursor(message) {
        if (message.hidden) {
            this.#removeCursor(message.from);
            return;
        }
        let cursor = this.cursors.get(message.from);
        if (!cursor) {
            const name = this.nameOf(message.from) ?? 'Guest';
            const node = el('div', { className: 'cursor' }, [el('span', { text: name })]);
            node.insertAdjacentHTML('afterbegin', '<svg viewBox="0 0 18 18" aria-hidden="true"><path d="M2 2l5.2 13.5 2.1-5.6 5.6-2.1z"/></svg>');
            node.style.setProperty('--cursor', cursorColor(message.from));
            $('board-cursors').append(node);
            cursor = { node, timer: 0 };
            this.cursors.set(message.from, cursor);
        }
        const [x, y] = message.points;
        cursor.node.style.transform = `translate(${x * this.renderer.width}px, ${y * this.renderer.height}px)`;
        cursor.node.classList.remove('is-idle');
        clearTimeout(cursor.timer);
        cursor.timer = setTimeout(() => cursor.node.classList.add('is-idle'), CURSOR_IDLE_MS);
    }

    #removeCursor(id) {
        const cursor = this.cursors.get(id);
        if (!cursor) return;
        clearTimeout(cursor.timer);
        cursor.node.remove();
        this.cursors.delete(id);
    }

    #requestSync() {
        // A sequence gap means an event was missed; a fresh snapshot restores convergence.
        if (performance.now() - this.lastSync < 2000) return;
        this.lastSync = performance.now();
        this.send({ type: 'board-sync' });
    }

    #invalidate(full) {
        if (full) this.fullRedraw = true;
        this.#syncHistoryButtons();
        if (!this.visible || this.frame) return;
        this.frame = requestAnimationFrame(() => {
            this.frame = 0;
            this.#draw();
        });
    }

    #draw() {
        if (!this.renderer.width) return;
        if (this.fullRedraw) {
            this.renderer.rebuild(this.model.visible());
            this.fullRedraw = false;
        }
        const now = performance.now();
        const overlays = [...this.model.pending.values()];
        for (const [id, live] of this.live) {
            if (now - live.updated > LIVE_STALE_MS) this.live.delete(id);
            else overlays.push(live);
        }
        if (this.active) overlays.push(this.active.element);
        this.renderer.compose(overlays);
    }

    #resize() {
        if (!this.visible) return;
        const area = $('board-area').getBoundingClientRect();
        const { width, height } = fitBoard(area.width, area.height);
        if (!width || !height) return;
        this.surface.style.setProperty('--board-w', `${width}px`);
        this.surface.style.setProperty('--board-h', `${height}px`);
        const dpr = Math.min(window.devicePixelRatio || 1, 3);
        if (width === this.renderer.width && height === this.renderer.height && dpr === this.renderer.dpr) return;
        this.renderer.resize(width, height, dpr);
        this.#invalidate(true);
    }

    #watchPixelRatio() {
        const query = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`);
        const onChange = () => {
            this.#resize();
            this.#watchPixelRatio();
        };
        query.addEventListener('change', onChange, { once: true });
        this.cleanups.push(() => query.removeEventListener('change', onChange));
    }
}
