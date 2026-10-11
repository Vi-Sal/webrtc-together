import { Emitter } from '../utils/emitter.js';

const CONSTRAINTS = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
};
const LABEL = { audio: 'Microphone', video: 'Camera' };

export function explainMediaError(kind, error) {
    const device = LABEL[kind];
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `${device} access is blocked. Allow it in your browser's site settings, then try again.`;
    if (error.name === 'NotFoundError' || error.name === 'OverconstrainedError') return `${device} not found. Connect one, then try again.`;
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return `${device} could not start. Close other apps or tabs using it, then try again.`;
    return `${device} is unavailable (${error.message || error.name}).`;
}

/** Messages for each screen-share failure, distinguishing capture from publishing. */
export function explainScreenError(error, phase = 'capture') {
    const code = error.name || 'Error';
    let message;
    if (phase === 'publish') {
        message = 'Your screen was captured, but it could not be sent to a participant. Stop and retry sharing, or rejoin the room.';
    } else if (code === 'NotSupportedError' || /not supported/i.test(error.message || '')) {
        message = 'This browser or desktop session does not support screen capture here. Open the meeting directly in desktop Chrome, Edge, Firefox or Safari rather than an embedded browser. If available, try sharing a browser tab.';
    } else if (code === 'NotAllowedError') {
        message = 'Screen sharing was cancelled or blocked. Choose Share screen again and approve a source. If blocked, check your system screen-recording permission.';
    } else if (code === 'NotReadableError' || code === 'AbortError') {
        message = 'The selected screen could not be captured. Try a browser tab or another window, and check your system screen-recording permission.';
    } else if (code === 'InvalidStateError') {
        message = 'Bring this browser tab to the front, then choose Share screen again.';
    } else if (code === 'NotFoundError') {
        message = 'No screen source is available. Use a desktop browser in an active desktop session.';
    } else {
        message = `Screen sharing could not start (${code}). Try another window or browser tab.`;
    }
    const details = [
        `Step: ${phase}`,
        `Error: ${code}: ${error.message || '(no details)'}`,
        `Secure context: ${window.isSecureContext}`,
        `Embedded page: ${window.self !== window.top}`,
        `Capture API: ${typeof navigator.mediaDevices?.getDisplayMedia}`,
        `Browser: ${navigator.userAgent}`
    ].join('\n');
    return { message: `${message} Your camera and call remain connected.`, details };
}

/**
 * The participant's own camera, microphone and screen capture.
 * Emits `change` whenever tracks, mute state or device problems change.
 */
export class LocalMedia extends Emitter {
    stream = new MediaStream();
    screen = null;
    problems = { audio: '', video: '' };
    preferred = { audio: '', video: '' };
    // Bumped when a kind is stopped or released, so a late getUserMedia result is discarded.
    #tokens = { audio: 0, video: 0 };

    get supported() {
        return window.isSecureContext && typeof navigator.mediaDevices?.getUserMedia === 'function';
    }

    liveTrack(kind) {
        return this.stream.getTracks().find(track => track.kind === kind && track.readyState === 'live');
    }

    state() {
        return { mic: !!this.liveTrack('audio')?.enabled, camera: !!this.liveTrack('video')?.enabled, screen: !!this.screen };
    }

    deviceId(kind) {
        return this.liveTrack(kind)?.getSettings?.().deviceId || this.preferred[kind] || '';
    }

    /** Starts the requested kinds. A failing device never prevents the other from starting. */
    async acquire(kinds) {
        kinds = [...new Set(kinds)];
        if (!kinds.length) return;
        if (!this.supported) {
            for (const kind of kinds) this.problems[kind] = 'Camera and microphone need a secure (HTTPS or localhost) page in a supported browser.';
            this.emit('change');
            return;
        }
        const tokens = Object.fromEntries(kinds.map(kind => [kind, this.#tokens[kind]]));
        const results = [];
        if (kinds.length === 2) {
            // One prompt where possible; fall back to separate requests to isolate a failing device.
            try {
                results.push(await navigator.mediaDevices.getUserMedia({ audio: this.#constraints('audio'), video: this.#constraints('video') }));
            } catch { /* Retried per device below. */ }
        }
        if (!results.length) {
            for (const kind of kinds) {
                try {
                    results.push(await this.#request(kind));
                    this.problems[kind] = '';
                } catch (error) {
                    if (tokens[kind] === this.#tokens[kind]) this.problems[kind] = explainMediaError(kind, error);
                }
            }
        }
        for (const stream of results) {
            for (const track of stream.getTracks()) {
                if (tokens[track.kind] !== this.#tokens[track.kind]) { track.stop(); continue; }
                this.#replace(track);
                this.problems[track.kind] = '';
            }
        }
        this.emit('change');
    }

    /** Stops a device entirely (camera light off), as opposed to muting it. */
    stop(kind) {
        this.#tokens[kind]++;
        for (const track of this.stream.getTracks().filter(track => track.kind === kind)) {
            track.onended = null;
            track.stop();
            this.stream.removeTrack(track);
        }
        this.emit('change');
    }

    setMuted(muted) {
        const track = this.liveTrack('audio');
        if (track) track.enabled = !muted;
        this.emit('change');
    }

    async switchDevice(kind, deviceId) {
        this.preferred[kind] = deviceId;
        const current = this.liveTrack(kind);
        if (!current) return;
        const enabled = current.enabled;
        await this.acquire([kind]);
        const replacement = this.liveTrack(kind);
        if (replacement && !enabled) {
            replacement.enabled = false;
            this.emit('change');
        }
    }

    async devices() {
        if (!navigator.mediaDevices?.enumerateDevices) return { audio: [], video: [] };
        const all = await navigator.mediaDevices.enumerateDevices();
        const group = (kind, label) => all.filter(device => device.kind === kind && device.deviceId)
            .map((device, index) => ({ id: device.deviceId, label: device.label || `${label} ${index + 1}` }));
        return { audio: group('audioinput', 'Microphone'), video: group('videoinput', 'Camera') };
    }

    /** Captures a screen, applying optional quality hints that may never fail the capture. */
    async captureScreen() {
        if (!window.isSecureContext || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
            throw new DOMException('Screen capture requires a supported browser on localhost or HTTPS.', 'NotSupportedError');
        }
        // Keep the request minimal and directly inside the click gesture.
        const captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        const track = captured.getVideoTracks()[0];
        if (!track || track.readyState !== 'live') {
            captured.getTracks().forEach(t => t.stop());
            throw new DOMException('The selected source is no longer available.', 'NotReadableError');
        }
        try {
            const supported = navigator.mediaDevices.getSupportedConstraints();
            const preferences = {};
            if (supported.width) preferences.width = { ideal: 1280 };
            if (supported.height) preferences.height = { ideal: 720 };
            if (supported.frameRate) preferences.frameRate = { ideal: 15, max: 20 };
            if (Object.keys(preferences).length) await track.applyConstraints(preferences);
        } catch { /* Use the browser's selected quality. */ }
        if (track.readyState !== 'live') {
            captured.getTracks().forEach(t => t.stop());
            throw new DOMException('The selected source was closed.', 'NotReadableError');
        }
        return captured;
    }

    setScreen(stream) {
        this.screen = stream;
        this.emit('change');
    }

    stopScreen() {
        const old = this.screen;
        this.screen = null;
        old?.getTracks().forEach(track => { track.onended = null; track.stop(); });
        if (old) this.emit('change');
        return !!old;
    }

    /** Stops every capture, including requests still waiting for permission. */
    release() {
        this.#tokens.audio++;
        this.#tokens.video++;
        for (const track of this.stream.getTracks()) {
            track.onended = null;
            track.stop();
            this.stream.removeTrack(track);
        }
        this.stopScreen();
        this.problems = { audio: '', video: '' };
        this.emit('change');
    }

    #constraints(kind) {
        const id = this.preferred[kind];
        return id ? { ...CONSTRAINTS[kind], deviceId: { exact: id } } : CONSTRAINTS[kind];
    }

    async #request(kind) {
        try {
            return await navigator.mediaDevices.getUserMedia({ [kind]: this.#constraints(kind) });
        } catch (error) {
            // A remembered device may have been unplugged: fall back to the default one.
            if (this.preferred[kind] && (error.name === 'OverconstrainedError' || error.name === 'NotFoundError')) {
                this.preferred[kind] = '';
                return navigator.mediaDevices.getUserMedia({ [kind]: CONSTRAINTS[kind] });
            }
            throw error;
        }
    }

    #replace(track) {
        for (const old of this.stream.getTracks().filter(existing => existing.kind === track.kind)) {
            old.onended = null;
            old.stop();
            this.stream.removeTrack(old);
        }
        this.stream.addTrack(track);
        track.onended = () => {
            if (!this.stream.getTracks().includes(track)) return;
            this.problems[track.kind] = `${LABEL[track.kind]} disconnected. Reconnect it, then try again.`;
            this.stream.removeTrack(track);
            this.emit('change');
        };
    }
}
