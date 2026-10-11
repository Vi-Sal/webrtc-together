import { Emitter } from '../utils/emitter.js';

const HEARTBEAT_MS = 25_000;
const JOIN_TIMEOUT_MS = 12_000;
const RECONNECT_DELAYS = [600, 1200, 2500, 5000, 8000];
const RECONNECT_GIVE_UP_MS = 90_000;
export const PROTOCOL_VERSION = 2;

/**
 * The single WebSocket a participant uses for signaling, chat and the whiteboard.
 *
 * Events:
 *   message(msg)     every server message in arrival order, including `joined`
 *   status(state)    'connecting' | 'connected' | 'reconnecting'
 *   disconnected()   the socket dropped after joining; a reconnect is scheduled
 *   fatal(message)   joining failed or reconnection gave up; the client is closed
 */
export class SignalingClient extends Emitter {
    #socket = null;
    #heartbeat = null;
    #joinTimer = null;
    #retryTimer = null;
    #attempt = 0;
    #lostAt = 0;
    #closed = false;
    #joinedOnce = false;
    #onOnline = () => { if (this.state === 'reconnecting') this.#reconnectNow(); };

    constructor({ room, name, device }) {
        super();
        this.room = room;
        this.name = name;
        this.device = device;
        this.state = 'idle';
        this.selfId = null;
    }

    connect() {
        this.#closed = false;
        window.addEventListener('online', this.#onOnline);
        this.#open();
    }

    get isOpen() {
        return this.state === 'connected' && this.#socket?.readyState === WebSocket.OPEN;
    }

    /** Sends when joined; returns false so callers can queue or report the failure. */
    send(message) {
        if (!this.isOpen) return false;
        this.#socket.send(JSON.stringify(message));
        return true;
    }

    /** Leaves the room. A page refresh keeps the resume token so the participant keeps its identity. */
    close({ keepResume = false } = {}) {
        this.#closed = true;
        window.removeEventListener('online', this.#onOnline);
        this.#teardownSocket();
        clearTimeout(this.#retryTimer);
        this.state = 'closed';
        if (!keepResume) this.#forgetResume();
        this.removeAll();
    }

    #open() {
        this.#teardownSocket();
        this.#setState(this.#joinedOnce ? 'reconnecting' : 'connecting');
        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const socket = new WebSocket(`${protocol}//${location.host}/ws/rooms`);
        this.#socket = socket;
        this.#joinTimer = setTimeout(() => {
            if (this.#socket !== socket || this.state === 'connected') return;
            if (this.#joinedOnce) socket.close();
            else this.#fail('The meeting server did not respond. Check your connection and try again.');
        }, JOIN_TIMEOUT_MS);
        socket.onopen = () => {
            socket.send(JSON.stringify({
                type: 'join', protocol: PROTOCOL_VERSION, room: this.room, name: this.name,
                device: this.device, resume: this.#loadResume()
            }));
        };
        socket.onmessage = event => {
            if (this.#socket !== socket) return;
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message?.type === 'joined') this.#joined(message);
            else if (message?.type === 'error' && (message.code === 'join' || this.state !== 'connected')) {
                this.#fail(message.message || 'Could not join the meeting.');
                return;
            }
            this.emit('message', message);
        };
        socket.onclose = () => {
            if (this.#socket !== socket || this.#closed) return;
            this.#teardownSocket();
            if (!this.#joinedOnce) {
                this.#fail('Unable to reach the meeting server. Check your connection and try again.');
                return;
            }
            if (!this.#lostAt) {
                this.#lostAt = Date.now();
                this.#setState('reconnecting');
                this.emit('disconnected');
            }
            this.#scheduleReconnect();
        };
    }

    #joined(message) {
        clearTimeout(this.#joinTimer);
        this.#joinedOnce = true;
        this.#attempt = 0;
        this.#lostAt = 0;
        this.selfId = message.id;
        this.#saveResume(message.resume);
        clearInterval(this.#heartbeat);
        // Media bypasses the server, so keepalives stop idle proxies from closing signaling.
        this.#heartbeat = setInterval(() => this.send({ type: 'ping' }), HEARTBEAT_MS);
        this.#setState('connected');
    }

    #scheduleReconnect() {
        if (Date.now() - this.#lostAt > RECONNECT_GIVE_UP_MS) {
            this.#fail('Connection to the meeting was lost. Rejoin when you are back online.');
            return;
        }
        const delay = RECONNECT_DELAYS[Math.min(this.#attempt, RECONNECT_DELAYS.length - 1)];
        this.#attempt++;
        clearTimeout(this.#retryTimer);
        this.#retryTimer = setTimeout(() => this.#open(), delay + Math.random() * 300);
    }

    #reconnectNow() {
        clearTimeout(this.#retryTimer);
        this.#attempt = 0;
        this.#open();
    }

    #fail(message) {
        const listenersStillAttached = !this.#closed;
        this.#closed = true;
        window.removeEventListener('online', this.#onOnline);
        this.#teardownSocket();
        clearTimeout(this.#retryTimer);
        this.state = 'closed';
        if (listenersStillAttached) this.emit('fatal', message);
        this.removeAll();
    }

    #teardownSocket() {
        clearInterval(this.#heartbeat);
        clearTimeout(this.#joinTimer);
        const socket = this.#socket;
        this.#socket = null;
        if (socket) {
            socket.onopen = socket.onmessage = socket.onclose = socket.onerror = null;
            if (socket.readyState <= WebSocket.OPEN) socket.close();
        }
    }

    #setState(state) {
        if (this.state === state) return;
        this.state = state;
        this.emit('status', state);
    }

    // Per-tab, so two tabs in the same room remain two participants.
    #resumeKey() {
        return `together-resume:${this.room}`;
    }

    #loadResume() {
        try { return sessionStorage.getItem(this.#resumeKey()) || undefined; } catch { return undefined; }
    }

    #saveResume(token) {
        try { if (token) sessionStorage.setItem(this.#resumeKey(), token); } catch { /* Optional. */ }
    }

    #forgetResume() {
        try { sessionStorage.removeItem(this.#resumeKey()); } catch { /* Optional. */ }
    }
}
