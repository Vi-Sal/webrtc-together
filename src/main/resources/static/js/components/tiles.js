import { $, el, icon } from '../utils/dom.js';
import { initial, toneFor } from '../utils/format.js';

const GAP = 12;

/**
 * Picks the column count giving the largest tiles that fit the stage without scrolling.
 * Landscape stages keep tiles between 4:3 and 16:9 so video is not cropped into slivers;
 * portrait phones may use taller tiles (down to 4:5).
 */
export function bestGrid(count, width, height, gap = GAP) {
    const minAspect = width >= height ? 4 / 3 : 4 / 5;
    let best = { cols: 1, tileW: width, tileH: height, area: 0 };
    for (let cols = 1; cols <= Math.max(1, count); cols++) {
        const rows = Math.ceil(count / cols);
        const cellW = (width - gap * (cols - 1)) / cols;
        const cellH = (height - gap * (rows - 1)) / rows;
        if (cellW <= 0 || cellH <= 0) continue;
        const aspect = Math.min(16 / 9, Math.max(minAspect, cellW / cellH));
        const tileW = Math.min(cellW, cellH * aspect);
        const tileH = tileW / aspect;
        if (tileW * tileH > best.area) best = { cols, tileW, tileH, area: tileW * tileH };
    }
    return best;
}

/**
 * Camera and screen tiles. Video elements are created once per participant and stay mounted;
 * switching between grid, presentation and whiteboard layouts only changes CSS.
 */
export class Tiles {
    constructor({ onAutoplayBlocked }) {
        this.people = $('people');
        this.screens = $('screens');
        this.stage = $('stage');
        this.onAutoplayBlocked = onAutoplayBlocked;
        this.view = 'video';
        this.resizeObserver = new ResizeObserver(() => this.layout());
        this.resizeObserver.observe(this.stage);
    }

    person(id, name, stream, { local = false } = {}) {
        let tile = $(`person-${id}`);
        if (!tile) {
            tile = this.#create(id, name, { local, screen: false });
            this.people.append(tile);
        }
        this.#bind(tile, stream);
        this.layout();
        return tile;
    }

    screen(id, name, stream, { local = false } = {}) {
        let tile = $(`screen-${id}`);
        if (!tile) {
            tile = this.#create(id, name, { local, screen: true });
            tile.hidden = true;
            this.screens.append(tile);
        }
        this.#bind(tile, stream);
        return tile;
    }

    rename(id, name) {
        for (const tile of [$(`person-${id}`), $(`screen-${id}`)]) {
            if (!tile) continue;
            tile.querySelector('.tile-name').textContent = this.#label(name, tile.classList.contains('is-local'), tile.classList.contains('is-screen'));
        }
    }

    remove(id) {
        $(`person-${id}`)?.remove();
        $(`screen-${id}`)?.remove();
        this.layout();
    }

    clear() {
        this.people.replaceChildren();
        this.screens.replaceChildren();
        this.layout();
    }

    ids() {
        return [...this.people.children].map(tile => tile.dataset.id);
    }

    setState(id, state) {
        const tile = $(`person-${id}`);
        if (tile) {
            tile.classList.toggle('camera-off', !state.camera);
            tile.classList.toggle('mic-off', !state.mic);
            tile.querySelector('.tile-mic').hidden = state.mic;
        }
        const screen = $(`screen-${id}`);
        if (screen && screen.hidden === !!state.screen) {
            screen.hidden = !state.screen;
            if (state.screen) this.play(screen.querySelector('video'));
            this.layout();
        }
    }

    setStatus(id, text) {
        const status = $(`person-${id}`)?.querySelector('.tile-status');
        if (status) status.textContent = text;
    }

    setSpeaking(id, speaking) {
        $(`person-${id}`)?.classList.toggle('is-speaking', speaking);
    }

    play(video) {
        if (!video?.srcObject) return;
        video.play().catch(() => { if (!video.muted) this.onAutoplayBlocked(); });
    }

    playAll() {
        for (const video of this.stage.querySelectorAll('video')) this.play(video);
    }

    setView(view) {
        this.view = view;
        this.layout();
    }

    get hasVisibleScreens() {
        return [...this.screens.children].some(tile => !tile.hidden);
    }

    layout() {
        const layout = this.view === 'board' ? 'board' : this.hasVisibleScreens ? 'presentation' : 'grid';
        this.stage.dataset.layout = layout;
        const count = this.people.children.length;
        this.people.dataset.count = String(count);
        if (layout !== 'grid') {
            this.people.style.removeProperty('--cols');
            this.people.style.removeProperty('--tile-w');
            this.people.style.removeProperty('--tile-h');
            return;
        }
        const { width, height } = this.stage.getBoundingClientRect();
        if (!width || !height) return;
        const grid = bestGrid(Math.max(1, count), width, height);
        this.people.style.setProperty('--cols', String(grid.cols));
        this.people.style.setProperty('--tile-w', `${Math.floor(grid.tileW)}px`);
        this.people.style.setProperty('--tile-h', `${Math.floor(grid.tileH)}px`);
    }

    destroy() {
        this.resizeObserver.disconnect();
        this.clear();
    }

    #label(name, local, screen) {
        return `${name}${local ? ' (you)' : ''}${screen ? ' · screen' : ''}`;
    }

    #create(id, name, { local, screen }) {
        const video = el('video', { attrs: { autoplay: true, playsinline: true } });
        video.muted = local || screen; // Audio arrives with the camera slot; screens are video-only.
        const tile = el('article', {
            className: `tile${local ? ' is-local' : ''}${screen ? ' is-screen' : ' camera-off'}`,
            attrs: { id: `${screen ? 'screen' : 'person'}-${id}`, 'aria-label': this.#label(name, local, screen) },
            dataset: { id }
        });
        const placeholder = el('div', { className: 'tile-placeholder' },
            [el('div', { className: 'avatar', text: initial(name), dataset: { tone: String(toneFor(name)) }, attrs: { 'aria-hidden': 'true' } })]);
        const mic = el('span', { className: 'tile-mic', attrs: { title: 'Muted' } }, [icon('mic-off'), el('span', { className: 'sr-only', text: 'Muted' })]);
        mic.hidden = true;
        const label = el('div', { className: 'tile-label' }, [el('span', { className: 'tile-name', text: this.#label(name, local, screen) }), mic]);
        const status = el('span', { className: 'tile-status', text: local || screen ? '' : 'Connecting…' });
        tile.append(video, placeholder, label, status);
        return tile;
    }

    #bind(tile, stream) {
        const video = tile.querySelector('video');
        if (video.srcObject !== stream) video.srcObject = stream;
        this.play(video);
    }
}
