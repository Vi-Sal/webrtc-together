import { $, el, icon, copyText } from '../utils/dom.js';
import { formatDuration, initial, toneFor } from '../utils/format.js';
import { createStore } from '../core/state.js';
import { SignalingClient } from '../core/signaling.js';
import { PeerMesh } from '../core/peers.js';
import { SpeakingMonitor } from '../core/audio-levels.js';
import { explainScreenError } from '../core/media.js';
import { inviteUrl } from '../core/room.js';
import { toggleTheme } from '../core/theme.js';
import { Tiles } from './tiles.js';
import { ChatPanel } from './chat.js';
import { Whiteboard } from '../whiteboard/whiteboard.js';
import { toast, showInviteDialog } from './feedback.js';

const MAX_PARTICIPANTS = 6;
const CONNECTION_LABELS = { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', offline: 'Offline' };

/**
 * One meeting session. UI state (view, panel, menu) lives in a store that only changes layout;
 * media and peer connections are managed separately and survive every UI change.
 */
export class Meeting {
    constructor({ room, name, media, iceConfig, onExit }) {
        this.room = room;
        this.name = name;
        this.media = media;
        this.iceConfig = iceConfig;
        this.onExit = onExit;
        this.ui = createStore({ view: 'video', panel: null, menuOpen: false });
        this.names = new Map();
        this.queue = Promise.resolve();
        this.mediaQueue = Promise.resolve();
        this.joined = false;
        this.ended = false;
        this.selfId = null;
        this.startedAt = Date.now();
        this.cleanups = [];
        this.localTracks = '';
    }

    /** Resolves once the server admits us; rejects with a readable message otherwise. */
    start() {
        this.tiles = new Tiles({ onAutoplayBlocked: () => { $('sound-notice').hidden = false; } });
        this.speaking = new SpeakingMonitor((id, speaking) => this.tiles.setSpeaking(id, speaking));
        this.signaling = new SignalingClient({ room: this.room, name: this.name, device: window.callDevice?.snapshot() });
        const send = message => this.signaling.send(message);
        this.mesh = new PeerMesh({ media: this.media, iceConfig: this.iceConfig, signal: (to, data) => send({ type: 'signal', to, data }) });
        this.chat = new ChatPanel({
            send,
            isOpen: () => this.ui.get().panel === 'chat',
            onUnread: count => this.#setBadge(count),
            onIncoming: message => toast({ title: message.name, body: message.text, person: message.name, onClick: () => this.#openPanel('chat') })
        });
        this.board = new Whiteboard({
            send,
            nameOf: id => this.names.get(id),
            onRemoteActivity: () => { $('board-badge').hidden = false; },
            onNotice: (text, quiet) => quiet ? this.chat.system(text) : toast({ title: text, error: true }),
            fileName: () => `together-whiteboard-${this.room}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.png`
        });
        this.#bindMesh();
        this.#bindControls();
        this.ui.subscribe((state, previous) => this.#render(state, previous));
        this.cleanups.push(this.media.on('change', () => this.#mediaChanged()));

        this.tiles.person('local', this.name, this.media.stream, { local: true });
        this.#mediaChanged();
        this.#render(this.ui.get(), {});
        $('room-code').textContent = this.room;

        return new Promise((resolve, reject) => {
            this.resolveJoin = resolve;
            this.signaling.on('message', message => {
                this.queue = this.queue.then(() => this.#handle(message)).catch(error => {
                    console.error(error);
                    if (!this.ended) toast({ title: 'A participant could not be connected.', body: 'Try leaving and rejoining if their video does not appear.', error: true });
                });
            });
            this.signaling.on('status', state => this.#setConnection(state));
            this.signaling.on('disconnected', () => this.#disconnected());
            this.signaling.on('fatal', message => {
                if (this.joined) this.end({ message, error: true });
                else { this.#teardown(); reject(new Error(message)); }
            });
            this.signaling.connect();
        });
    }

    /** Leaves the meeting, releasing camera, microphone and screen capture. */
    end({ message = 'You left the meeting.', error = false, keepResume = false } = {}) {
        if (this.ended) return;
        this.#teardown({ keepResume });
        this.onExit({ message, error });
    }

    async #handle(message) {
        if (this.ended) return;
        switch (message.type) {
            case 'joined': return this.#joined(message);
            case 'peer-joined':
                this.names.set(message.peer.id, message.peer.name);
                this.chat.system(`${message.peer.name} joined`);
                toast({ title: `${message.peer.name} joined`, person: message.peer.name, duration: 3000 });
                return this.#addPeer(message.peer);
            case 'peer-left': {
                const name = this.names.get(message.id);
                this.#removePeer(message.id);
                if (name) this.chat.system(`${name} left`);
                return;
            }
            case 'signal': return this.mesh.handleSignal(message.from, message.data);
            case 'chat': return this.chat.receive(message.message);
            case 'chat-typing': return this.chat.typingFrom(message.from, message.name);
            case 'error':
                if (message.code === 'chat' && message.ref) this.chat.rejected(message.ref, message.message);
                else if (message.code === 'board') this.board.handle(message);
                else toast({ title: message.message || 'Something went wrong.', error: true });
                return;
            default:
                if (message.type?.startsWith('board-')) this.board.handle(message);
        }
    }

    async #joined(message) {
        const reconnect = this.joined;
        this.joined = true;
        this.selfId = message.id;
        this.mesh.selfId = message.id;
        this.chat.setSelf(message.id);
        this.board.setSelf(message.id);
        if (message.limits?.chatLength) this.chat.maxLength = message.limits.chatLength;
        if (typeof message.startedAt === 'number' && typeof message.now === 'number') {
            this.startedAt = Date.now() - Math.max(0, message.now - message.startedAt);
        }
        this.names.set(message.id, message.name ?? this.name);
        this.chat.load(message.chat);
        this.board.load(message.board);
        // After a reconnect, drop tiles for anyone who left while we were away.
        const present = new Set(message.peers.map(peer => peer.id));
        for (const id of this.tiles.ids()) if (id !== 'local' && !present.has(id)) this.#removePeer(id);
        if (!reconnect) {
            this.timer = setInterval(() => this.#tick(), 1000);
            this.#tick();
            this.resolveJoin();
        } else {
            toast({ title: 'Reconnected', body: 'You’re back in the meeting.', duration: 2500 });
        }
        this.chat.flush();
        this.#updateCount();
        for (const peer of message.peers) {
            this.names.set(peer.id, peer.name);
            await this.#addPeer(peer);
        }
    }

    async #addPeer(info) {
        if (info.id === this.selfId) return;
        if (this.mesh.peers.has(info.id)) this.mesh.remove(info.id);
        const peer = this.mesh.add(info);
        this.#updateCount();
        await this.mesh.connect(peer);
    }

    #removePeer(id) {
        this.mesh.remove(id);
        this.tiles.remove(id);
        this.speaking.unwatch(id);
        this.chat.participantLeft(id);
        this.board.participantLeft(id);
        this.names.delete(id);
        this.#updateCount();
    }

    #disconnected() {
        // Peer connections are rebuilt after rejoining; tiles stay to avoid a jarring layout reset.
        for (const id of [...this.mesh.peers.keys()]) {
            this.mesh.remove(id);
            this.speaking.unwatch(id);
            this.tiles.setStatus(id, 'Reconnecting…');
        }
        this.chat.connectionLost();
    }

    #bindMesh() {
        this.mesh.on('added', peer => {
            this.tiles.person(peer.id, peer.info.name, peer.camera);
            this.tiles.screen(peer.id, peer.info.name, peer.screen);
            this.tiles.setState(peer.id, peer.state);
            this.tiles.setStatus(peer.id, 'Connecting…');
            this.#renderPeople();
        });
        this.mesh.on('track', (id, slot, track) => {
            const tile = $(`${slot === 'screen' ? 'screen' : 'person'}-${id}`);
            this.tiles.play(tile?.querySelector('video'));
            if (track.kind === 'audio') this.speaking.watch(id, track);
        });
        this.mesh.on('state', (id, state) => {
            const wasSharing = $(`screen-${id}`)?.hidden === false;
            this.tiles.setState(id, state);
            this.#renderPeople();
            if (state.screen && !wasSharing) {
                const name = this.names.get(id) ?? 'Someone';
                toast({
                    title: `${name} is sharing their screen`,
                    body: this.ui.get().view === 'board' ? 'Select to view it' : '',
                    onClick: this.ui.get().view === 'board' ? () => this.ui.set({ view: 'video' }) : null
                });
            }
        });
        this.mesh.on('connection', (id, state) => {
            this.tiles.setStatus(id, state === 'connected' ? ''
                : state === 'failed' || state === 'disconnected' ? 'Connection interrupted' : 'Connecting…');
        });
    }

    #mediaChanged() {
        this.mediaQueue = this.mediaQueue.then(async () => {
            if (this.ended) return;
            try {
                await this.mesh.attachAll();
            } catch (error) {
                console.warn('Could not publish media', error);
            }
            const signature = this.media.stream.getTracks().map(track => track.id).join();
            const localVideo = $('person-local')?.querySelector('video');
            if (localVideo && signature !== this.localTracks) {
                // Re-bind so every browser renders newly added tracks.
                this.localTracks = signature;
                localVideo.srcObject = null;
                localVideo.srcObject = this.media.stream;
                this.tiles.play(localVideo);
            }
            const state = this.media.state();
            this.tiles.setState('local', state);
            this.speaking.watch('local', this.media.liveTrack('audio'));
            this.mesh.announce();
            this.#syncMediaControls();
            this.#renderPeople();
        });
    }

    #syncMediaControls() {
        const audio = this.media.liveTrack('audio');
        const video = this.media.liveTrack('video');
        const micOn = !!audio?.enabled;
        const mic = $('mic');
        mic.classList.toggle('is-off', !micOn);
        mic.setAttribute('aria-pressed', String(!micOn));
        mic.setAttribute('aria-label', micOn ? 'Mute microphone' : audio ? 'Unmute microphone' : this.media.problems.audio ? 'Retry microphone' : 'Turn on microphone');
        mic.dataset.tooltip = micOn ? 'Mute' : audio ? 'Unmute' : this.media.problems.audio ? 'Retry mic' : 'Turn on mic';
        const camera = $('camera');
        camera.classList.toggle('is-off', !video);
        camera.setAttribute('aria-pressed', String(!video));
        camera.setAttribute('aria-label', video ? 'Turn off camera' : this.media.problems.video ? 'Retry camera' : 'Turn on camera');
        camera.dataset.tooltip = video ? 'Stop video' : this.media.problems.video ? 'Retry camera' : 'Start video';
        const sharing = !!this.media.screen;
        $('share').setAttribute('aria-pressed', String(sharing));
        $('share').setAttribute('aria-label', sharing ? 'Stop sharing screen' : 'Share screen');
        $('share').dataset.tooltip = sharing ? 'Stop sharing' : 'Share screen';
        $('menu-share-label').textContent = sharing ? 'Stop sharing' : 'Share screen';
        const problems = Object.values(this.media.problems).filter(Boolean);
        $('media-status').hidden = !problems.length;
        $('media-status-text').textContent = problems.length ? `${problems.join(' ')} You can stay in the meeting, listen and share your screen.` : '';
    }

    #bindControls() {
        const busy = async (button, task) => {
            if (button.classList.contains('is-busy')) return;
            button.classList.add('is-busy');
            try { await task(); } finally { button.classList.remove('is-busy'); }
        };
        $('mic').onclick = () => busy($('mic'), async () => {
            const track = this.media.liveTrack('audio');
            if (track) this.media.setMuted(track.enabled);
            else await this.media.acquire(['audio']);
        });
        $('camera').onclick = () => busy($('camera'), async () => {
            if (this.media.liveTrack('video')) this.media.stop('video');
            else await this.media.acquire(['video']);
        });
        $('share').onclick = () => busy($('share'), () => this.#toggleShare());
        $('toggle-chat').onclick = () => this.#togglePanel('chat');
        $('toggle-people').onclick = () => this.#togglePanel('people');
        $('toggle-board').onclick = () => this.ui.set({ view: this.ui.get().view === 'board' ? 'video' : 'board' });
        $('tab-chat').onclick = () => this.#openPanel('chat');
        $('tab-people').onclick = () => this.#openPanel('people');
        $('panel-close').onclick = () => this.ui.set({ panel: null });
        $('leave').onclick = () => this.end();
        $('invite').onclick = () => this.#invite();
        $('room-chip').onclick = () => this.#invite();
        for (const button of document.querySelectorAll('#meeting [data-action="invite"]')) button.onclick = () => this.#invite();
        $('enable-sound').onclick = () => { $('sound-notice').hidden = true; this.tiles.playAll(); };
        for (const button of document.querySelectorAll('#meeting [data-dismiss]')) button.onclick = () => { $(button.dataset.dismiss).hidden = true; };
        $('more').onclick = () => this.ui.set({ menuOpen: !this.ui.get().menuOpen });
        for (const item of document.querySelectorAll('#more-menu [data-menu]')) {
            item.onclick = () => {
                this.ui.set({ menuOpen: false });
                const action = item.dataset.menu;
                if (action === 'share') busy($('share'), () => this.#toggleShare());
                else if (action === 'people') this.#openPanel('people');
                else if (action === 'invite') this.#invite();
                else if (action === 'theme') toggleTheme();
            };
        }
        for (const select of [$('meeting-mic-select'), $('meeting-camera-select')]) {
            select.onchange = () => this.media.switchDevice(select.dataset.kind, select.value);
        }

        const onPointerDown = event => {
            if (this.ui.get().menuOpen && !event.target.closest('.menu-anchor')) this.ui.set({ menuOpen: false });
        };
        const onKey = event => {
            if (event.key !== 'Escape' || document.querySelector('dialog[open]')) return;
            if (this.ui.get().menuOpen) { this.ui.set({ menuOpen: false }); $('more').focus(); }
            else if (this.ui.get().panel && !event.target.closest?.('.board-surface')) this.ui.set({ panel: null });
        };
        // Refreshing or closing the tab keeps the resume token so this tab can rejoin as itself.
        const onPageHide = () => this.end({ keepResume: true, message: '' });
        document.addEventListener('pointerdown', onPointerDown);
        document.addEventListener('keydown', onKey);
        window.addEventListener('pagehide', onPageHide);
        this.cleanups.push(
            () => document.removeEventListener('pointerdown', onPointerDown),
            () => document.removeEventListener('keydown', onKey),
            () => window.removeEventListener('pagehide', onPageHide));
    }

    async #toggleShare() {
        if (this.media.screen) {
            this.#stopShare();
            return;
        }
        $('screen-notice').hidden = true;
        let captured = null, phase = 'capture';
        try {
            captured = await this.media.captureScreen();
            if (this.ended) { captured.getTracks().forEach(track => track.stop()); return; }
            phase = 'publish';
            this.media.screen = captured;
            await this.mesh.attachAll();
            const track = captured.getVideoTracks()[0];
            if (this.ended || track.readyState !== 'live') throw new DOMException('The selected source was closed.', 'NotReadableError');
            const tile = this.tiles.screen('local', this.name, captured, { local: true });
            tile.hidden = false;
            this.tiles.layout();
            track.onended = () => { if (this.media.screen === captured) this.#stopShare(); };
            this.media.setScreen(captured);
            if (this.ui.get().view === 'board') toast({ title: 'You’re sharing your screen', body: 'Others see it in the video view.' });
        } catch (error) {
            captured?.getTracks().forEach(track => track.stop());
            if (this.media.screen === captured) this.media.screen = null;
            await Promise.allSettled([this.mesh.attachAll()]);
            if (this.ended) return;
            this.#removeLocalScreen();
            this.#mediaChanged();
            const { message, details } = explainScreenError(error, phase);
            $('screen-message').textContent = message;
            $('screen-details').textContent = details;
            $('screen-notice').hidden = false;
        }
    }

    #stopShare() {
        this.media.stopScreen();
        this.#removeLocalScreen();
    }

    #removeLocalScreen() {
        $('screen-local')?.remove();
        this.tiles.layout();
    }

    #togglePanel(panel) {
        this.ui.set({ panel: this.ui.get().panel === panel ? null : panel });
    }

    #openPanel(panel) {
        this.ui.set({ panel });
    }

    #render(state, previous) {
        if (state.view !== previous.view) {
            const board = state.view === 'board';
            $('board').hidden = !board;
            this.tiles.setView(state.view);
            this.board.setVisible(board);
            const button = $('toggle-board');
            button.setAttribute('aria-pressed', String(board));
            button.setAttribute('aria-label', board ? 'Return to video view' : 'Open whiteboard');
            button.dataset.tooltip = board ? 'Back to video' : 'Whiteboard';
            if (board) $('board-badge').hidden = true;
        }
        if (state.panel !== previous.panel) {
            const panel = state.panel;
            $('side-panel').hidden = !panel;
            $('chat-panel').hidden = panel !== 'chat';
            $('people-panel').hidden = panel !== 'people';
            $('tab-chat').setAttribute('aria-selected', String(panel === 'chat'));
            $('tab-people').setAttribute('aria-selected', String(panel === 'people'));
            $('toggle-chat').setAttribute('aria-pressed', String(panel === 'chat'));
            $('toggle-chat').setAttribute('aria-label', panel === 'chat' ? 'Close chat' : 'Open chat');
            $('toggle-people').setAttribute('aria-pressed', String(panel === 'people'));
            if (panel === 'chat') {
                this.chat.opened();
                if (previous.panel !== undefined) this.chat.focusComposer();
            }
            if (panel === 'people') this.#renderPeople();
            if (!panel && previous.panel) $(previous.panel === 'chat' ? 'toggle-chat' : 'toggle-people').focus({ preventScroll: true });
        }
        if (state.menuOpen !== previous.menuOpen) {
            $('more-menu').hidden = !state.menuOpen;
            $('more').setAttribute('aria-expanded', String(state.menuOpen));
            if (state.menuOpen) {
                this.#fillDeviceMenus();
                $('more-menu').querySelector('.menu-item:not([hidden])')?.focus({ preventScroll: true });
            }
        }
    }

    async #fillDeviceMenus() {
        const devices = await this.media.devices().catch(() => ({ audio: [], video: [] }));
        for (const [select, kind] of [[$('meeting-mic-select'), 'audio'], [$('meeting-camera-select'), 'video']]) {
            fillSelect(select, devices[kind], this.media.deviceId(kind), kind === 'audio' ? 'No microphone found' : 'No camera found');
        }
    }

    #setBadge(count) {
        const badge = $('chat-badge');
        badge.hidden = count === 0;
        badge.textContent = count > 9 ? '9+' : String(count);
        const open = this.ui.get().panel === 'chat';
        $('toggle-chat').setAttribute('aria-label', open ? 'Close chat' : count ? `Open chat, ${count} unread` : 'Open chat');
    }

    #setConnection(state) {
        const node = $('connection');
        node.dataset.state = state;
        $('connection-label').textContent = CONNECTION_LABELS[state] ?? state;
        if (this.joined || state === 'connected') {
            $('connection-announcer').textContent = state === 'reconnecting' ? 'Connection lost. Reconnecting…'
                : state === 'connected' ? 'Connected to the meeting.' : '';
        }
    }

    #updateCount() {
        const count = this.mesh.peers.size + 1;
        const node = $('participant-count');
        node.querySelector('span').textContent = String(count);
        node.setAttribute('aria-label', `${count} of ${MAX_PARTICIPANTS} participants`);
        $('people-tab-count').textContent = String(count);
        $('waiting').hidden = count > 1;
        this.#renderPeople();
    }

    #renderPeople() {
        const list = $('people-list');
        if (!list || $('people-panel').hidden) return;
        const entries = [{ id: 'local', name: this.name, state: this.media.state(), self: true },
            ...[...this.mesh.peers.values()].map(peer => ({ id: peer.id, name: peer.info.name, state: peer.state }))];
        list.replaceChildren(...entries.map(({ name, state, self }) => {
            const mic = icon(state.mic ? 'mic' : 'mic-off', `icon${state.mic ? '' : ' is-off'}`);
            const cam = icon(state.camera ? 'camera' : 'camera-off', `icon${state.camera ? '' : ' is-off'}`);
            const status = `${state.mic ? 'microphone on' : 'muted'}, ${state.camera ? 'camera on' : 'camera off'}${state.screen ? ', sharing screen' : ''}`;
            return el('li', {}, [
                el('div', { className: 'avatar avatar-sm', text: initial(name), dataset: { tone: String(toneFor(name)) }, attrs: { 'aria-hidden': 'true' } }),
                el('span', { className: 'person-name' }, [name, self ? el('small', { text: ' (you)' }) : null]),
                el('span', { className: 'person-state' }, [mic, cam, el('span', { className: 'sr-only', text: status })])
            ]);
        }));
    }

    async #invite() {
        const url = inviteUrl(this.room, location.origin);
        if (await copyText(url)) toast({ title: 'Invite link copied', body: 'Send it to anyone you want to meet.', duration: 2600 });
        else showInviteDialog(url);
    }

    #tick() {
        $('meeting-timer').textContent = formatDuration(Date.now() - this.startedAt);
    }

    #teardown({ keepResume = false } = {}) {
        if (this.ended) return;
        this.ended = true;
        clearInterval(this.timer);
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.signaling?.close({ keepResume });
        this.mesh?.closeAll();
        this.media.release();
        this.speaking?.stop();
        this.chat?.destroy();
        this.board?.destroy();
        this.tiles?.destroy();
        this.#setBadge(0);
        // Reset shared DOM so a later meeting starts clean.
        $('board').hidden = true;
        $('board-badge').hidden = true;
        $('side-panel').hidden = true;
        $('more-menu').hidden = true;
        $('more').setAttribute('aria-expanded', 'false');
        for (const id of ['toggle-chat', 'toggle-people', 'toggle-board']) $(id).setAttribute('aria-pressed', 'false');
        for (const id of ['media-status', 'screen-notice', 'sound-notice']) $(id).hidden = true;
        $('waiting').hidden = false;
        $('stage').dataset.layout = 'grid';
        $('meeting-timer').textContent = '00:00';
        this.#setConnection('connecting');
    }
}

export function fillSelect(select, devices, current, emptyLabel) {
    select.replaceChildren(...(devices.length
        ? devices.map(device => el('option', { text: device.label, attrs: { value: device.id } }))
        : [el('option', { text: emptyLabel, attrs: { value: '' } })]));
    select.disabled = !devices.length;
    if (current && devices.some(device => device.id === current)) select.value = current;
}
