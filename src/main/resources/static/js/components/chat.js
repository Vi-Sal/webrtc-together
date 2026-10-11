import { $, el } from '../utils/dom.js';
import { formatTime, listNames } from '../utils/format.js';
import { randomId } from '../utils/ids.js';
import { ChatModel, TypingTracker, validateDraft, MAX_MESSAGE_LENGTH } from '../core/chat-model.js';

const NEAR_BOTTOM_PX = 80;
const GROUP_WINDOW_MS = 3 * 60_000;
const TYPING_SEND_MS = 2500;
const ACK_TIMEOUT_MS = 10_000;

/**
 * Room chat UI. Messages are rendered with textContent only. Unsent messages stay visible and are
 * resent after a reconnect; the server deduplicates retries by client ID.
 */
export class ChatPanel {
    constructor({ send, isOpen, onUnread, onIncoming }) {
        this.send = send;
        this.isOpen = isOpen;
        this.onUnread = onUnread;
        this.onIncoming = onIncoming;
        this.model = new ChatModel();
        this.typing = new TypingTracker();
        this.maxLength = MAX_MESSAGE_LENGTH;
        this.list = $('chat-list');
        this.scroller = $('chat-scroll');
        this.input = $('chat-input');
        this.sendButton = $('chat-send');
        this.lastTypingSent = 0;
        this.ackTimers = new Map();
        this.lastItem = null; // { from, ts } for grouping
        this.typingTimer = setInterval(() => this.#renderTyping(), 1000);
        this.#bind();
    }

    setSelf(id) {
        this.model.selfId = id;
    }

    /** History from `joined`. Safe to call again after a reconnect: known messages are skipped. */
    load(history) {
        for (const message of history ?? []) this.#receive(message, { history: true });
        this.scrollToBottom();
    }

    receive(message) {
        this.#receive(message, { history: false });
    }

    typingFrom(id, name) {
        this.typing.touch(id, name);
        this.#renderTyping();
    }

    participantLeft(id) {
        if (this.typing.remove(id)) this.#renderTyping();
    }

    system(text) {
        const stick = this.#nearBottom();
        this.list.append(el('li', { className: 'msg-system', text }));
        this.lastItem = null;
        this.#afterAppend(!stick);
    }

    /** Server rejected a message: show it as failed with a retry action. */
    rejected(clientId, reason) {
        const item = this.model.fail(clientId, reason);
        if (item) this.#renderPending(item);
    }

    /** Resends queued messages once the connection is back. */
    flush() {
        for (const item of this.model.sending()) this.#transmit(item);
    }

    connectionLost() {
        for (const timer of this.ackTimers.values()) clearTimeout(timer);
        this.ackTimers.clear();
    }

    opened() {
        this.model.markRead();
        this.onUnread(0);
        $('chat-jump').hidden = true;
        this.scrollToBottom();
    }

    focusComposer() {
        // Avoid popping the on-screen keyboard over the sheet on touch devices.
        if (matchMedia('(pointer: fine)').matches) this.input.focus();
    }

    scrollToBottom() {
        this.scroller.scrollTop = this.scroller.scrollHeight;
        $('chat-jump').hidden = true;
    }

    destroy() {
        clearInterval(this.typingTimer);
        this.connectionLost();
        this.list.replaceChildren();
        $('chat-empty').hidden = false;
        $('chat-typing').textContent = '';
        this.input.value = '';
        this.#updateComposer();
    }

    #bind() {
        $('chat-form').onsubmit = event => { event.preventDefault(); this.#submit(); };
        this.input.onkeydown = event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
                event.preventDefault();
                this.#submit();
            }
        };
        this.input.oninput = () => {
            this.#updateComposer();
            const now = Date.now();
            if (this.input.value.trim() && now - this.lastTypingSent > TYPING_SEND_MS) {
                this.lastTypingSent = now;
                this.send({ type: 'typing' });
            }
        };
        this.scroller.onscroll = () => { if (this.#nearBottom()) $('chat-jump').hidden = true; };
        $('chat-jump').onclick = () => this.scrollToBottom();
        this.#updateComposer();
    }

    #updateComposer() {
        const length = [...this.input.value.trim()].length;
        const verdict = validateDraft(this.input.value, this.maxLength);
        this.sendButton.disabled = !verdict.ok;
        const counter = $('chat-counter');
        counter.textContent = length > this.maxLength * 0.8 ? `${length} / ${this.maxLength}` : '';
        counter.classList.toggle('is-over', length > this.maxLength);
        // Auto-grow up to the CSS max-height.
        this.input.style.height = 'auto';
        this.input.style.height = `${Math.min(this.input.scrollHeight, 132)}px`;
    }

    #submit() {
        const verdict = validateDraft(this.input.value, this.maxLength);
        if (!verdict.ok) return;
        const item = this.model.addPending(randomId(16), verdict.text);
        this.input.value = '';
        this.lastTypingSent = 0;
        this.#updateComposer();
        this.#renderPending(item);
        this.scrollToBottom();
        this.#transmit(item);
    }

    #transmit(item) {
        if (!this.send({ type: 'chat', id: item.clientId, text: item.text })) return; // Resent by flush().
        clearTimeout(this.ackTimers.get(item.clientId));
        this.ackTimers.set(item.clientId, setTimeout(() => {
            this.ackTimers.delete(item.clientId);
            const failed = this.model.fail(item.clientId, 'Not delivered.');
            if (failed) this.#renderPending(failed);
        }, ACK_TIMEOUT_MS));
    }

    #receive(message, { history }) {
        if (!message || typeof message.id !== 'string' || typeof message.text !== 'string') return;
        const counting = !history && !this.isOpen();
        const { added, confirmed } = this.model.receive(message, { countUnread: counting });
        if (confirmed) {
            clearTimeout(this.ackTimers.get(confirmed.clientId));
            this.ackTimers.delete(confirmed.clientId);
            const pendingNode = $(`chat-pending-${confirmed.clientId}`);
            if (pendingNode) {
                pendingNode.replaceWith(this.#messageNode(message, pendingNode.classList.contains('starts-group')));
                return;
            }
        }
        if (!added) return;
        if (message.from !== this.model.selfId) this.typing.remove(message.from);
        const stick = this.#nearBottom();
        this.list.append(this.#messageNode(message, this.#startsGroup(message.from, message.ts)));
        this.#renderTyping();
        const fromOther = message.from !== this.model.selfId;
        this.#afterAppend(fromOther && !history && !stick);
        if (counting && fromOther) {
            this.onUnread(this.model.unread);
            this.onIncoming(message);
        }
    }

    #startsGroup(from, ts) {
        const starts = !this.lastItem || this.lastItem.from !== from || ts - this.lastItem.ts > GROUP_WINDOW_MS;
        this.lastItem = { from, ts };
        return starts;
    }

    #messageNode(message, startsGroup) {
        const self = message.from === this.model.selfId;
        const time = el('time', { text: formatTime(message.ts), attrs: { datetime: new Date(message.ts).toISOString() } });
        const meta = el('div', { className: 'msg-meta' }, [el('strong', { text: self ? 'You' : message.name }), time]);
        return el('li', {
            className: `msg${self ? ' is-self' : ''}${startsGroup ? ' starts-group' : ''}`,
            dataset: { id: message.id }
        }, [meta, el('div', { className: 'msg-bubble', text: message.text })]);
    }

    #renderPending(item) {
        const id = `chat-pending-${item.clientId}`;
        let node = $(id);
        if (!node) {
            node = this.#messageNode({ id, from: this.model.selfId, name: 'You', text: item.text, ts: item.ts },
                this.#startsGroup(this.model.selfId, item.ts));
            node.id = id;
            this.list.append(node);
            $('chat-empty').hidden = true;
        }
        node.classList.toggle('is-pending', item.status === 'sending');
        node.classList.toggle('is-failed', item.status === 'failed');
        node.querySelector('.msg-fail')?.remove();
        if (item.status === 'failed') {
            const retry = el('button', { text: 'Retry', attrs: { type: 'button' } });
            retry.onclick = () => {
                const again = this.model.retry(item.clientId);
                if (again) { this.#renderPending(again); this.#transmit(again); }
            };
            node.append(el('div', { className: 'msg-fail', attrs: { role: 'alert' } }, [el('span', { text: item.error || 'Not sent.' }), retry]));
        }
    }

    // Follow new messages only when the reader was already at the bottom.
    #afterAppend(readingOlder) {
        $('chat-empty').hidden = this.list.children.length > 0;
        if (!readingOlder) this.scrollToBottom();
        else $('chat-jump').hidden = false;
    }

    #nearBottom() {
        return this.scroller.scrollHeight - this.scroller.scrollTop - this.scroller.clientHeight < NEAR_BOTTOM_PX;
    }

    #renderTyping() {
        const names = this.typing.names();
        const text = !names.length ? '' : names.length > 3 ? 'Several people are typing…'
            : `${listNames(names)} ${names.length === 1 ? 'is' : 'are'} typing…`;
        const node = $('chat-typing');
        if (node.textContent !== text) node.textContent = text;
    }
}
