import { $ } from '../utils/dom.js';
import { initial, toneFor } from '../utils/format.js';
import { inviteUrl } from '../core/room.js';
import { LocalMedia } from '../core/media.js';
import { LevelMeter } from '../core/audio-levels.js';
import { copyText } from '../utils/dom.js';
import { fillSelect } from './meeting.js';
import { toast, showInviteDialog } from './feedback.js';

const NAME_KEY = 'together-name';
const DEVICES_KEY = 'together-devices';

function load(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Optional preference. */ }
}

/**
 * Pre-join lobby with a live preview. Devices are requested only after a user action (arriving
 * via Start/Join, a toggle, or the explicit check button), never on a cold invitation link.
 */
export class Lobby {
    constructor({ onBack, onJoin }) {
        this.onBack = onBack;
        this.onJoin = onJoin;
        this.media = null;
        this.room = null;
        this.joining = false;
        this.meter = new LevelMeter($('preview-meter'));
        this.wanted = { audio: true, video: true, ...load(DEVICES_KEY, {}) };
        this.#bind();
    }

    enter(room, { autoPreview = false, message = '', error = false } = {}) {
        this.room = room;
        this.joining = false;
        this.media?.release();
        this.media = new LocalMedia();
        this.offChange = this.media.on('change', () => this.#refresh());
        $('lobby-room').textContent = room;
        $('display-name').value ||= load(NAME_KEY, '');
        $('display-name').removeAttribute('aria-invalid');
        $('join-button').disabled = false;
        $('join-button').textContent = 'Join now';
        this.#status(message, error);
        this.#refresh();
        if (autoPreview) this.#startPreview();
    }

    /** Hands the preview's live media to the meeting without stopping it. */
    detach() {
        const media = this.media;
        this.offChange?.();
        this.meter.stop();
        $('preview-video').srcObject = null;
        this.media = null;
        return media;
    }

    exit() {
        this.offChange?.();
        this.meter.stop();
        this.media?.release();
        this.media = null;
        $('preview-video').srcObject = null;
    }

    #bind() {
        $('lobby-back').addEventListener('click', () => this.onBack());
        $('preview-allow').addEventListener('click', () => this.#startPreview());
        $('lobby-mic').addEventListener('click', () => this.#toggle('audio'));
        $('lobby-camera').addEventListener('click', () => this.#toggle('video'));
        $('display-name').addEventListener('input', () => {
            $('display-name').removeAttribute('aria-invalid');
            this.#refreshAvatar();
        });
        for (const select of [$('mic-select'), $('camera-select')]) {
            select.addEventListener('change', () => this.media?.switchDevice(select.dataset.kind, select.value));
        }
        $('lobby-copy').addEventListener('click', async () => {
            const url = inviteUrl(this.room, location.origin);
            if (await copyText(url)) toast({ title: 'Invite link copied', duration: 2400 });
            else showInviteDialog(url);
        });
        $('lobby-form').addEventListener('submit', event => {
            event.preventDefault();
            this.#join();
        });
        navigator.mediaDevices?.addEventListener?.('devicechange', () => this.#fillDevices());
    }

    async #startPreview() {
        if (!this.media) return;
        const kinds = ['audio', 'video'].filter(kind => this.wanted[kind] && !this.media.liveTrack(kind));
        if (!kinds.length) return;
        const media = this.media;
        $('preview-loading').hidden = false;
        $('preview-allow').hidden = true;
        await media.acquire(kinds);
        if (media === this.media) $('preview-loading').hidden = true;
    }

    async #toggle(kind) {
        if (!this.media) return;
        this.wanted[kind] = !this.wanted[kind];
        save(DEVICES_KEY, this.wanted);
        if (this.wanted[kind]) {
            const media = this.media;
            if (kind === 'video') $('preview-loading').hidden = false;
            await media.acquire([kind]);
            if (media === this.media) $('preview-loading').hidden = true;
        } else {
            this.media.stop(kind);
        }
        this.#refresh();
    }

    #refresh() {
        const media = this.media;
        if (!media) return;
        const video = media.liveTrack('video');
        const audio = media.liveTrack('audio');
        const preview = $('preview');
        const element = $('preview-video');
        const signature = video?.id ?? '';
        if (video && element.dataset.track !== signature) {
            // Re-bind when the camera track changes so every browser renders the new track.
            element.srcObject = null;
            element.srcObject = media.stream;
            element.play().catch(() => {});
        }
        element.dataset.track = signature;
        preview.classList.toggle('has-video', !!video);
        this.meter[audio ? 'watch' : 'stop'](audio);
        for (const [kind, id] of [['audio', 'lobby-mic'], ['video', 'lobby-camera']]) {
            const on = this.wanted[kind];
            const button = $(id);
            const label = kind === 'audio' ? 'microphone' : 'camera';
            button.setAttribute('aria-pressed', String(on));
            button.setAttribute('aria-label', `${on ? 'Turn off' : 'Turn on'} ${label}`);
            button.dataset.tooltip = `${on ? 'Turn off' : 'Turn on'} ${label}`;
        }
        const anyLive = !!(video || audio);
        const wantsAny = this.wanted.audio || this.wanted.video;
        $('preview-allow').hidden = anyLive || !wantsAny || !media.supported || !$('preview-loading').hidden;
        $('preview-message').textContent = !media.supported ? 'Camera and microphone need HTTPS or localhost.'
            : this.wanted.video && !video && !media.problems.video ? 'Check your camera before joining'
            : 'Your camera is off';
        const problems = Object.values(media.problems).filter(Boolean);
        $('lobby-media-notice').hidden = !problems.length;
        $('lobby-media-notice').textContent = problems.length ? `${problems.join(' ')} You can still join and fix it later.` : '';
        this.#refreshAvatar();
        if (anyLive) this.#fillDevices();
    }

    #refreshAvatar() {
        const name = $('display-name').value.trim();
        const avatar = $('preview-avatar');
        avatar.textContent = name ? initial(name) : '?';
        avatar.dataset.tone = String(toneFor(name));
    }

    async #fillDevices() {
        if (!this.media) return;
        const devices = await this.media.devices().catch(() => ({ audio: [], video: [] }));
        const known = devices.audio.length || devices.video.length;
        $('device-fields').hidden = !known;
        if (!known || !this.media) return;
        fillSelect($('mic-select'), devices.audio, this.media.deviceId('audio'), 'No microphone found');
        fillSelect($('camera-select'), devices.video, this.media.deviceId('video'), 'No camera found');
    }

    async #join() {
        if (this.joining || !this.media) return;
        const nameInput = $('display-name');
        const name = nameInput.value.replace(/\s+/g, ' ').trim();
        if (!name || name.length > 40) {
            nameInput.setAttribute('aria-invalid', 'true');
            this.#status('Enter your name (up to 40 characters) so others know who you are.', true);
            nameInput.focus();
            return;
        }
        save(NAME_KEY, name);
        this.joining = true;
        const button = $('join-button');
        button.disabled = true;
        button.textContent = 'Joining…';
        this.#status('');
        const media = this.media;
        try {
            const missing = ['audio', 'video'].filter(kind => this.wanted[kind] && !media.liveTrack(kind));
            if (missing.length && media.supported) {
                this.#status('Allow access to your devices. You can still join if one is unavailable.');
                await media.acquire(missing);
            }
            if (media !== this.media) return;
            const response = await fetch('/api/call-config', { signal: AbortSignal.timeout(15000) });
            if (!response.ok) throw new Error('Could not load the meeting configuration.');
            const iceConfig = await response.json();
            if (media !== this.media) return;
            this.#status('Connecting to the meeting…');
            await this.onJoin({ room: this.room, name, media: this.detach(), iceConfig });
        } catch (error) {
            if (media === this.media || !this.media) {
                this.joining = false;
                button.disabled = false;
                button.textContent = 'Join now';
                this.#status(error.name === 'TimeoutError' ? 'The server took too long to respond. Try again.' : error.message, true);
            }
        }
    }

    #status(message, error = false) {
        const status = $('lobby-status');
        status.textContent = message;
        status.classList.toggle('is-error', error);
    }
}
