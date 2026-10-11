import { Emitter } from '../utils/emitter.js';

/**
 * Full-mesh WebRTC connections. One deterministic offerer per pair creates three fixed slots
 * (audio, camera, screen) so camera and screen can change via replaceTrack without renegotiation
 * collisions. Layout changes never touch these connections.
 *
 * Events: added(peer), removed(id), track(id, slot), state(id, mediaState), connection(id, state)
 */
export class PeerMesh extends Emitter {
    constructor({ media, signal, iceConfig }) {
        super();
        this.media = media;
        this.signal = signal;
        this.iceConfig = iceConfig;
        this.selfId = null;
        this.peers = new Map();
    }

    add(info) {
        if (this.peers.has(info.id)) return this.peers.get(info.id);
        const pc = new RTCPeerConnection(this.iceConfig);
        const peer = {
            id: info.id, info, pc, candidates: [], restarting: false,
            initiator: this.selfId.localeCompare(info.id) < 0,
            state: { mic: false, camera: false, screen: false },
            camera: new MediaStream(), screen: new MediaStream()
        };
        this.peers.set(info.id, peer);
        pc.onicecandidate = ({ candidate }) => { if (candidate) this.signal(info.id, { candidate }); };
        pc.ontrack = ({ track, transceiver }) => {
            const slot = pc.getTransceivers().indexOf(transceiver) === 2 ? 'screen' : 'camera';
            const stream = peer[slot];
            for (const old of stream.getTracks().filter(t => t.kind === track.kind)) stream.removeTrack(old);
            stream.addTrack(track);
            this.emit('track', info.id, slot, track);
        };
        pc.onconnectionstatechange = () => {
            const state = pc.connectionState;
            this.emit('connection', info.id, state);
            if (state === 'connected') {
                peer.restarting = false;
                this.signal(info.id, { state: this.media.state() });
            } else if (state === 'failed' && peer.initiator && !peer.restarting) {
                peer.restarting = true;
                this.#offer(peer, true).catch(error => console.warn('ICE restart failed', error));
            }
        };
        if (peer.initiator) {
            pc.addTransceiver('audio', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
            pc.addTransceiver('video', { direction: 'sendrecv' });
        }
        this.emit('added', peer);
        return peer;
    }

    async connect(peer) {
        if (peer.initiator) await this.#offer(peer);
        this.signal(peer.id, { state: this.media.state() });
    }

    remove(id) {
        const peer = this.peers.get(id);
        if (!peer) return;
        peer.pc.onconnectionstatechange = peer.pc.ontrack = peer.pc.onicecandidate = null;
        peer.pc.close();
        this.peers.delete(id);
        this.emit('removed', id);
    }

    closeAll() {
        for (const id of [...this.peers.keys()]) this.remove(id);
    }

    async handleSignal(from, data) {
        const peer = this.peers.get(from);
        if (!peer || !data || typeof data !== 'object') return;
        const { description, candidate, state } = data;
        if (state && typeof state === 'object') {
            peer.state = { mic: !!state.mic, camera: !!state.camera, screen: !!state.screen };
            this.emit('state', from, peer.state);
        }
        if (description) {
            await peer.pc.setRemoteDescription(description);
            await this.#attach(peer);
            for (const pending of peer.candidates.splice(0)) await peer.pc.addIceCandidate(pending);
            if (description.type === 'offer') {
                await peer.pc.setLocalDescription(await peer.pc.createAnswer());
                this.signal(from, { description: peer.pc.localDescription });
            }
            this.signal(from, { state: this.media.state() });
        } else if (candidate) {
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate);
            else peer.candidates.push(candidate);
        }
    }

    /** Publishes the current local tracks to every peer. */
    attachAll() {
        return Promise.all([...this.peers.values()].map(peer => this.#attach(peer)));
    }

    announce() {
        const state = this.media.state();
        for (const id of this.peers.keys()) this.signal(id, { state });
    }

    async #attach(peer) {
        const tracks = [this.media.liveTrack('audio'), this.media.liveTrack('video'), this.media.screen?.getVideoTracks()[0]];
        await Promise.all(peer.pc.getTransceivers().map((transceiver, index) => {
            if (index > 2 || transceiver.stopped) return null;
            transceiver.direction = 'sendrecv';
            return transceiver.sender.replaceTrack(tracks[index] || null);
        }));
    }

    async #offer(peer, restart = false) {
        await this.#attach(peer);
        await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: restart }));
        this.signal(peer.id, { description: peer.pc.localDescription });
    }
}
