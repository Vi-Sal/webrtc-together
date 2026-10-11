// Chat state without DOM: deduplication, optimistic sends, failures and unread counts.
export const MAX_MESSAGE_LENGTH = 1000;

export function validateDraft(text, max = MAX_MESSAGE_LENGTH) {
    const trimmed = (text ?? '').trim();
    if (!trimmed) return { ok: false, reason: 'empty' };
    if ([...trimmed].length > max) return { ok: false, reason: 'too-long' };
    return { ok: true, text: trimmed };
}

export class ChatModel {
    constructor() {
        this.selfId = null;
        this.messages = new Map(); // server ID → message, in arrival order
        this.pending = new Map();  // client ID → { clientId, text, ts, status, error }
        this.unread = 0;
    }

    /** Server ID that a pending client ID will receive once accepted. */
    serverId(clientId) {
        return `${this.selfId}-${clientId}`;
    }

    addPending(clientId, text, now = Date.now()) {
        const item = { clientId, text, ts: now, status: 'sending', error: '' };
        this.pending.set(clientId, item);
        return item;
    }

    /**
     * Records a server message. Returns { added, confirmed } where confirmed is the pending item
     * this message acknowledges (if any). Duplicates (replays, retries, history) are ignored.
     */
    receive(message, { countUnread = false } = {}) {
        let confirmed = null;
        if (message.from === this.selfId) {
            for (const item of this.pending.values()) {
                if (this.serverId(item.clientId) === message.id) {
                    confirmed = item;
                    this.pending.delete(item.clientId);
                    break;
                }
            }
        }
        if (this.messages.has(message.id)) return { added: false, confirmed };
        this.messages.set(message.id, message);
        if (countUnread && message.from !== this.selfId) this.unread++;
        return { added: true, confirmed };
    }

    fail(clientId, error) {
        const item = this.pending.get(clientId);
        if (!item) return null;
        item.status = 'failed';
        item.error = error;
        return item;
    }

    retry(clientId) {
        const item = this.pending.get(clientId);
        if (!item) return null;
        item.status = 'sending';
        item.error = '';
        return item;
    }

    sending() {
        return [...this.pending.values()].filter(item => item.status === 'sending');
    }

    markRead() {
        this.unread = 0;
    }
}

/** Typing indicators that expire on their own if the "stopped" signal never arrives. */
export class TypingTracker {
    constructor(ttl = 4000) {
        this.ttl = ttl;
        this.active = new Map(); // participant ID → { name, expires }
    }

    touch(id, name, now = Date.now()) {
        this.active.set(id, { name, expires: now + this.ttl });
    }

    remove(id) {
        return this.active.delete(id);
    }

    names(now = Date.now()) {
        for (const [id, entry] of this.active) if (entry.expires <= now) this.active.delete(id);
        return [...this.active.values()].map(entry => entry.name);
    }
}
