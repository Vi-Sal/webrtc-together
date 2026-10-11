/**
 * Speaking detection from audio levels. One shared AudioContext, polled a few times per second
 * (not per frame) to keep CPU use low. Muted tracks produce silence and never count as speaking.
 */
const THRESHOLD = 0.035;
const HOLD_MS = 650;
const INTERVAL_MS = 120;

let context = null;
function audioContext() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    context ??= new Context();
    if (context.state === 'suspended') context.resume().catch(() => {});
    return context;
}

function rms(analyser, buffer) {
    analyser.getByteTimeDomainData(buffer);
    let sum = 0;
    for (const value of buffer) { const centered = (value - 128) / 128; sum += centered * centered; }
    return Math.sqrt(sum / buffer.length);
}

export class SpeakingMonitor {
    #sources = new Map(); // id → { track, source, analyser, buffer, speaking, lastLoud }
    #timer = null;

    constructor(onChange) {
        this.onChange = onChange;
    }

    watch(id, track) {
        const existing = this.#sources.get(id);
        if (existing?.track === track) return;
        this.unwatch(id);
        if (!track || track.kind !== 'audio') return;
        const ctx = audioContext();
        if (!ctx) return;
        try {
            const source = ctx.createMediaStreamSource(new MediaStream([track]));
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            source.connect(analyser);
            this.#sources.set(id, { track, source, analyser, buffer: new Uint8Array(analyser.fftSize), speaking: false, lastLoud: 0 });
            this.#timer ??= setInterval(() => this.#poll(), INTERVAL_MS);
        } catch { /* Level detection is optional. */ }
    }

    unwatch(id) {
        const entry = this.#sources.get(id);
        if (!entry) return;
        entry.source.disconnect();
        this.#sources.delete(id);
        if (entry.speaking) this.onChange(id, false);
        if (!this.#sources.size) { clearInterval(this.#timer); this.#timer = null; }
    }

    stop() {
        for (const id of [...this.#sources.keys()]) this.unwatch(id);
    }

    #poll() {
        const now = performance.now();
        for (const [id, entry] of this.#sources) {
            const active = entry.track.readyState === 'live' && entry.track.enabled;
            if (active && rms(entry.analyser, entry.buffer) > THRESHOLD) entry.lastLoud = now;
            const speaking = active && now - entry.lastLoud < HOLD_MS;
            if (speaking !== entry.speaking) {
                entry.speaking = speaking;
                this.onChange(id, speaking);
            }
        }
    }
}

/** Five-bar microphone meter for the lobby preview. */
export class LevelMeter {
    #entry = null;
    #frame = 0;

    constructor(container) {
        this.container = container;
        this.bars = [...container.children];
    }

    watch(track) {
        this.stop();
        const ctx = track && audioContext();
        if (!ctx) return;
        try {
            const source = ctx.createMediaStreamSource(new MediaStream([track]));
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            this.#entry = { track, source, analyser, buffer: new Uint8Array(analyser.fftSize) };
            this.container.classList.add('is-live');
            const tick = () => {
                const entry = this.#entry;
                if (!entry) return;
                const level = entry.track.enabled ? Math.min(1, rms(entry.analyser, entry.buffer) * 6) : 0;
                this.bars.forEach((bar, index) => {
                    const weight = 1 - Math.abs(index - 2) * 0.22;
                    bar.style.height = `${4 + Math.round(level * weight * 14)}px`;
                });
                this.#frame = setTimeout(tick, 70);
            };
            tick();
        } catch { /* Optional. */ }
    }

    stop() {
        clearTimeout(this.#frame);
        this.#entry?.source.disconnect();
        this.#entry = null;
        this.container.classList.remove('is-live');
    }
}
