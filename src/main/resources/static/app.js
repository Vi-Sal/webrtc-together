'use strict';
const $ = id => document.getElementById(id);
const peers = new Map();
let heartbeat, joinTimeout;
let socket, localMedia, screenMedia, ownId, iceConfig, joined = false, busy = false, generation = 0;
const mediaProblems = { audio: '', video: '' };
const mediaConstraints = {
    audio: { echoCancellation: true, noiseSuppression: true },
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 24, max: 30 } }
};
const DEFAULT_ROOM = 'DEFAULT_NAME';
let room = new URL(location.href).searchParams.get('room') || '';
const invitation = new URL(location.href);
invitation.search = ''; invitation.hash = '';
$('room-input').value = room;
function updateJoinLabel() {
    const hasInvite = $('room-input').value.trim().length > 0;
    $('join-title').textContent = hasInvite ? 'Join your people.' : 'Join the default room';
    $('join').textContent = hasInvite ? 'Join this room →' : 'Join DEFAULT_NAME →';
}
function selectRoom() {
    let value = $('room-input').value.trim();
    if (/^https?:\/\//i.test(value)) {
        const link = new URL(value);
        if (link.origin !== location.origin) {
            throw new Error(`This invitation uses ${link.origin}. Open that exact invite URL in your browser. Both people must use the same server and port.`);
        }
        value = link.searchParams.get('room') || '';
        if (!value) throw new Error('That link has no room code. Ask your friend to use Copy invite link inside their call.');
    }
    if (value && !/^[a-zA-Z0-9_-]{8,80}$/.test(value)) {
        throw new Error('Paste the full invitation link or a valid room code (8–80 letters, numbers, dashes or underscores).');
    }
    room = value || DEFAULT_ROOM;
    $('room-input').value = room;
    invitation.searchParams.set('room', room);
}
$('room-input').addEventListener('input', updateJoinLabel);
updateJoinLabel();
const status = (message, error = false) => { $('status').textContent = message; $('status').classList.toggle('error', error); };
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function signal(to, data) { send({ type: 'signal', to, data }); }
function liveTrack(kind) { return localMedia?.getTracks().find(track => track.kind === kind && track.readyState === 'live'); }
function mediaState() { return { mic: !!liveTrack('audio')?.enabled, camera: !!liveTrack('video')?.enabled, screen: !!screenMedia }; }
function explainMediaError(kind, error) {
    const device = kind === 'audio' ? 'Microphone' : 'Camera';
    if (error.name === 'NotAllowedError' || error.name === 'SecurityError') return `${device} access is blocked. Allow it in your browser's site permissions, then retry.`;
    if (error.name === 'NotFoundError') return `${device} not found. Connect a device, then retry.`;
    if (error.name === 'NotReadableError' || error.name === 'AbortError') return `${device} could not start. Close other apps or tabs using it and check your system's input settings, then retry.`;
    return `${device} is unavailable: ${error.message || error.name}. You can retry during the call.`;
}
function refreshMediaControls() {
    for (const [id, kind, on, off] of [['mic', 'audio', 'Mute mic', 'Unmute mic'], ['camera', 'video', 'Camera off', 'Camera on']]) {
        const track = liveTrack(kind);
        $(id).textContent = track ? (track.enabled ? on : off) : `${mediaProblems[kind] ? 'Retry' : 'Enable'} ${id === 'mic' ? 'mic' : 'camera'}`;
        $(id).setAttribute('aria-pressed', String(!track?.enabled));
    }
    const problems = Object.values(mediaProblems).filter(Boolean);
    $('media-status').textContent = problems.length ? `${problems.join(' ')} You can stay in the call and listen or share your screen.` : '';
    $('media-status').hidden = !problems.length;
}
function watchTrack(track) {
    track.onended = () => {
        if (!localMedia?.getTracks().includes(track)) return;
        mediaProblems[track.kind] = `${track.kind === 'audio' ? 'Microphone' : 'Camera'} disconnected. Reconnect it, then retry.`;
        refreshMediaControls(); announce();
    };
}
async function acquireTrack(kind, attempt) {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: false, [kind]: mediaConstraints[kind] });
        if (attempt !== generation) { stream.getTracks().forEach(track => track.stop()); return; }
        for (const old of localMedia.getTracks().filter(track => track.kind === kind)) { old.stop(); localMedia.removeTrack(old); }
        for (const track of stream.getTracks()) { localMedia.addTrack(track); watchTrack(track); }
        mediaProblems[kind] = '';
    } catch (error) {
        if (attempt === generation) mediaProblems[kind] = explainMediaError(kind, error);
    }
}

function announce() { for (const id of peers.keys()) signal(id, { state: mediaState() }); updateTile('local', mediaState()); }
function tile(id, name, screen = false, local = false) {
    const element = document.createElement('article');
    element.className = `tile${local && !screen ? ' local' : ''}`; element.id = `${screen ? 'screen' : 'person'}-${id}`;
    const avatar = document.createElement('div'); avatar.className = 'avatar'; avatar.textContent = name.slice(0, 1).toUpperCase();
    const video = document.createElement('video'); video.autoplay = true; video.playsInline = true; video.muted = local || screen;
    const label = document.createElement('div'); label.className = 'label';
    const title = document.createElement('span'); title.textContent = `${name}${local ? ' (you)' : ''}${screen ? ' · screen' : ''}`;
    const state = document.createElement('span'); state.className = 'state'; state.textContent = screen ? 'Sharing' : 'Connecting';
    label.append(title, state); element.append(avatar, video, label); $(screen ? 'screens' : 'videos').append(element);
    return element;
}
function play(video) { video.play().catch(() => { if (!video.muted) $('audio').hidden = false; }); }
function updateTile(id, state) {
    const element = $(`person-${id}`);
    if (element) {
        element.querySelector('video').style.opacity = state.camera ? '1' : '0';
        element.querySelector('.state').textContent = `${state.mic ? 'Mic on' : 'Muted'}${state.camera ? '' : ' · Camera off'}`;
    }
    const screen = $(`screen-${id}`); if (screen) screen.hidden = !state.screen;
}
function count() { $('participant-count').textContent = `${peers.size + 1} ${peers.size ? 'people' : 'person'} · Room limit: 6`; $('waiting').hidden = peers.size > 0; }
function createPeer(info) {
    if (peers.has(info.id)) return peers.get(info.id);
    const pc = new RTCPeerConnection(iceConfig);
    const camera = tile(info.id, info.name), screen = tile(info.id, info.name, true); screen.hidden = true;
    const cameraStream = new MediaStream(), shareStream = new MediaStream();
    camera.querySelector('video').srcObject = cameraStream; screen.querySelector('video').srcObject = shareStream;
    const peer = { pc, info, candidates: [], state: { mic: true, camera: true, screen: false }, initiator: ownId.localeCompare(info.id) < 0, restarting: false };
    peers.set(info.id, peer);
    pc.onicecandidate = ({ candidate }) => { if (candidate) signal(info.id, { candidate }); };
    pc.ontrack = ({ track, transceiver }) => {
        const isScreen = pc.getTransceivers().indexOf(transceiver) === 2;
        const stream = isScreen ? shareStream : cameraStream;
        if (!stream.getTracks().includes(track)) stream.addTrack(track);
        play(isScreen ? screen.querySelector('video') : camera.querySelector('video'));
    };
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'connected') { peer.restarting = false; updateTile(info.id, peer.state); signal(info.id, { state: mediaState() }); }
        else if (['failed', 'disconnected'].includes(pc.connectionState)) {
            camera.querySelector('.state').textContent = 'Connection interrupted';
            if (pc.connectionState === 'failed' && peer.initiator && !peer.restarting) {
                peer.restarting = true; offer(peer, true).catch(() => status('A connection failed. Leave and rejoin to try again.', true));
            }
        }
    };
    // One offerer per pair; three stable slots avoid camera/screen negotiation collisions.
    if (peer.initiator) {
        pc.addTransceiver('audio', { direction: 'sendrecv' });
        pc.addTransceiver('video', { direction: 'sendrecv' });
        pc.addTransceiver('video', { direction: 'sendrecv' });
    }
    count(); return peer;
}
async function attach(peer) {
    const tracks = [liveTrack('audio'), liveTrack('video'), screenMedia?.getVideoTracks()[0]];
    await Promise.all(peer.pc.getTransceivers().map((transceiver, index) => {
        transceiver.direction = 'sendrecv';
        return transceiver.sender.replaceTrack(tracks[index] || null);
    }));
}
async function offer(peer, restart = false) {
    await attach(peer); await peer.pc.setLocalDescription(await peer.pc.createOffer({ iceRestart: restart }));
    signal(peer.info.id, { description: peer.pc.localDescription });
}
async function receive(message) {
    if (message.type === 'error') { if (!joined) cleanup(); status(message.message, true); return; }
    if (message.type === 'joined') {
        ownId = message.id; joined = true; busy = false;
        clearTimeout(joinTimeout);
        heartbeat = setInterval(() => send({ type: 'ping' }), 25000);
        $('lobby').hidden = true; $('call').hidden = false; $('join').disabled = false;
        history.replaceState(null, '', invitation);
        $('room-code').textContent = room; $('room-server').textContent = location.origin;
        const local = tile('local', $('name').value.trim(), false, true);
        local.querySelector('video').srcObject = localMedia; play(local.querySelector('video')); updateTile('local', mediaState()); count(); refreshMediaControls();
        for (const info of message.peers) { const peer = createPeer(info); if (peer.initiator) await offer(peer); }
        status('You’re in. Share the invitation to bring people together.');
    } else if (message.type === 'peer-joined') {
        const peer = createPeer(message.peer); if (peer.initiator) await offer(peer); signal(message.peer.id, { state: mediaState() });
    } else if (message.type === 'peer-left') removePeer(message.id);
    else if (message.type === 'signal') {
        const peer = peers.get(message.from); if (!peer) return;
        const { description, candidate, state } = message.data;
        if (state) { peer.state = state; updateTile(message.from, state); }
        if (description) {
            await peer.pc.setRemoteDescription(description); await attach(peer);
            for (const pending of peer.candidates.splice(0)) await peer.pc.addIceCandidate(pending);
            if (description.type === 'offer') {
                await peer.pc.setLocalDescription(await peer.pc.createAnswer()); signal(message.from, { description: peer.pc.localDescription });
            }
            signal(message.from, { state: mediaState() });
        } else if (candidate) {
            if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(candidate); else peer.candidates.push(candidate);
        }
    }
}
function removePeer(id) {
    const peer = peers.get(id); if (!peer) return;
    peer.pc.onconnectionstatechange = null; peer.pc.close(); peers.delete(id);
    $(`person-${id}`)?.remove(); $(`screen-${id}`)?.remove(); count();
}
function cleanup() {
    generation++; joined = false; busy = false;
    clearInterval(heartbeat); clearTimeout(joinTimeout);
    if (socket) { socket.onclose = null; socket.onmessage = null; socket.close(); socket = null; }
    for (const id of [...peers.keys()]) removePeer(id);
    localMedia?.getTracks().forEach(track => track.stop()); screenMedia?.getTracks().forEach(track => track.stop());
    localMedia = screenMedia = null; ownId = null;
    mediaProblems.audio = mediaProblems.video = ''; $('media-status').hidden = true; $('media-status').textContent = '';
    $('mic').disabled = $('camera').disabled = false;
    $('videos').replaceChildren(); $('screens').replaceChildren(); $('lobby').hidden = false; $('call').hidden = true;
    $('join').disabled = false; updateJoinLabel(); $('share').disabled = false;
    for (const [id, text] of [['mic', 'Mute mic'], ['camera', 'Camera off'], ['share', 'Share screen']]) { $(id).textContent = text; $(id).setAttribute('aria-pressed', 'false'); }
    $('audio').hidden = true; $('invite-fallback').hidden = true; $('screen-notice').hidden = true;
}
$('join-form').addEventListener('submit', async event => {
    event.preventDefault(); if (busy || joined) return;
    try { selectRoom(); } catch (error) { status(error.message, true); return; }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) { status('Open this app on localhost or HTTPS to use your camera and microphone.', true); return; }
    busy = true; const attempt = ++generation; $('join').disabled = true; $('join').textContent = 'Preparing devices…'; status('Allow access to your selected devices. You can still join if a device is unavailable.');
    try {
        localMedia = new MediaStream();
        // A failed microphone must not discard a working camera (or block joining).
        for (const kind of ['audio', 'video']) {
            if ($(kind === 'audio' ? 'start-mic' : 'start-camera').checked) await acquireTrack(kind, attempt);
            if (attempt !== generation) return;
        }
        const response = await fetch('/api/call-config', { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error('Could not load call configuration.');
        iceConfig = await response.json(); if (attempt !== generation) return;
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws/rooms`);
        let queue = Promise.resolve();
        joinTimeout = setTimeout(() => { if (!joined && attempt === generation) { cleanup(); status('Connection timed out. Please try joining again.', true); } }, 12000);
        socket.onopen = () => send({ type: 'join', room, name: $('name').value.trim(), device: window.callDevice?.snapshot() });
        socket.onmessage = event => { queue = queue.then(() => attempt === generation ? receive(JSON.parse(event.data)) : undefined).catch(error => { console.error(error); status('Could not connect to a participant. Try leaving and joining again.', true); }); };
        socket.onclose = () => { clearTimeout(joinTimeout); if (attempt === generation) { cleanup(); status('Connection to the room was lost. Join again to reconnect.', true); } };
        socket.onerror = () => status('Unable to reach the call server.', true);
    } catch (error) {
        cleanup(); status(error.name === 'NotAllowedError' ? 'Camera or microphone permission was denied. Allow access in your browser and try again.' : `Could not join: ${error.message}`, true);
    }
});
for (const [id, kind] of [['mic', 'audio'], ['camera', 'video']]) {
    $(id).addEventListener('click', async () => {
        if (!joined) return;
        const track = liveTrack(kind);
        if (track) { track.enabled = !track.enabled; refreshMediaControls(); announce(); return; }
        const attempt = generation; $(id).disabled = true;
        try {
            await acquireTrack(kind, attempt);
            if (attempt !== generation || !joined) return;
            await Promise.all([...peers.values()].map(attach));
            if (attempt !== generation || !joined) return;
            const preview = $('person-local').querySelector('video');
            preview.srcObject = localMedia; if (localMedia.getTracks().length) play(preview);
            refreshMediaControls(); announce();
            if (liveTrack(kind)) status(`${kind === 'audio' ? 'Microphone' : 'Camera'} connected.`);
        } catch (error) {
            if (attempt === generation) status(`Could not update media for a participant: ${error.message}`, true);
        } finally { if (attempt === generation) $(id).disabled = false; }
    });
}
function screenProblem(error, phase = 'capture') {
    const code = error.name || 'Error';
    let message;
    if (phase === 'publish') {
        message = 'Your screen was captured, but it could not be sent to a participant. Stop and retry sharing, or rejoin the room.';
    } else if (code === 'NotSupportedError' || /not supported/i.test(error.message || '')) {
        message = 'This browser or desktop session does not support screen capture here. Open the call directly in a desktop Chrome, Edge, or Firefox window, rather than an IDE preview or embedded browser. If available, try sharing a browser tab instead of the entire screen.';
    } else if (code === 'NotAllowedError') {
        message = 'Screen sharing was cancelled or blocked. Click Share screen again and approve a source in the browser picker. If blocked, check browser or system screen-recording permissions.';
    } else if (code === 'NotReadableError' || code === 'AbortError') {
        message = 'The selected screen could not be captured by your browser or operating system. Try a browser tab or another window, and check system screen-recording permissions.';
    } else if (code === 'InvalidStateError') {
        message = 'Bring this browser tab to the foreground, then click Share screen again.';
    } else if (code === 'NotFoundError') {
        message = 'No screen source is available. Use a desktop browser in an active desktop session.';
    } else {
        message = `Screen sharing could not start (${code}). Try another window or browser tab.`;
    }
    $('screen-message').textContent = `${message} Your camera and call remain connected.`;
    $('screen-details').textContent = `Step: ${phase}\nError: ${code}: ${error.message || '(no details)'}\nSecure context: ${window.isSecureContext}\nEmbedded page: ${window.self !== window.top}\nCapture API: ${typeof navigator.mediaDevices?.getDisplayMedia}\nBrowser: ${navigator.userAgent}`;
    $('screen-notice').hidden = false;
}
async function stopShare() {
    const attempt = generation;
    const old = screenMedia; screenMedia = null;
    old?.getTracks().forEach(track => { track.onended = null; track.stop(); });
    await Promise.allSettled([...peers.values()].map(attach));
    if (attempt !== generation) return;
    $('screen-local')?.remove(); $('share').textContent = 'Share screen'; $('share').setAttribute('aria-pressed', 'false'); announce();
}
$('share').addEventListener('click', async () => {
    if (!joined) return;
    if (screenMedia) {
        $('share').disabled = true;
        const attempt = generation;
        try { await stopShare(); } finally { if (attempt === generation) $('share').disabled = false; }
        return;
    }
    $('screen-notice').hidden = true;
    if (!window.isSecureContext || typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
        screenProblem(new DOMException('Screen capture requires a supported browser on localhost or HTTPS.', 'NotSupportedError'));
        return;
    }
    const attempt = generation; $('share').disabled = true;
    let captured, phase = 'capture';
    try {
        // Keep the picker request minimal and directly inside the click gesture.
        captured = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
        if (attempt !== generation || !joined) { captured.getTracks().forEach(track => track.stop()); return; }
        const track = captured.getVideoTracks()[0];
        if (!track || track.readyState !== 'live') throw new DOMException('The selected source is no longer available.', 'NotReadableError');
        // Quality preferences must never turn successful capture into a failed call.
        try {
            const supported = navigator.mediaDevices.getSupportedConstraints();
            const preferences = {};
            if (supported.width) preferences.width = { ideal: 1280 };
            if (supported.height) preferences.height = { ideal: 720 };
            if (supported.frameRate) preferences.frameRate = { ideal: 15, max: 20 };
            if (Object.keys(preferences).length) await track.applyConstraints(preferences);
        } catch { /* Use the browser's selected capture quality. */ }
        if (attempt !== generation || !joined) { captured.getTracks().forEach(track => track.stop()); return; }
        if (track.readyState !== 'live') throw new DOMException('The selected source was closed.', 'NotReadableError');
        phase = 'publish'; screenMedia = captured;
        await Promise.all([...peers.values()].map(attach));
        if (attempt !== generation || !joined) { captured.getTracks().forEach(track => track.stop()); return; }
        if (track.readyState !== 'live') throw new DOMException('The selected source was closed.', 'NotReadableError');
        const local = tile('local', $('name').value.trim(), true, true); local.querySelector('video').srcObject = captured; play(local.querySelector('video'));
        track.onended = () => { if (screenMedia === captured) stopShare(); };
        $('share').textContent = 'Stop sharing'; $('share').setAttribute('aria-pressed', 'true'); announce();
        status('Your screen and camera are both live. Others can share their screens too.');
    } catch (error) {
        captured?.getTracks().forEach(track => track.stop());
        if (attempt !== generation) return;
        await stopShare();
        if (attempt === generation) screenProblem(error, phase);
    } finally { if (attempt === generation) $('share').disabled = false; }
});
$('invite').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(invitation.href); status('Invite copied. Send it to someone you want to call.'); }
    catch { $('invite-fallback').hidden = false; $('invite-url').value = invitation.href; $('invite-url').select(); }
});
$('audio').addEventListener('click', () => { $('audio').hidden = true; document.querySelectorAll('video').forEach(play); });
$('leave').addEventListener('click', () => { cleanup(); status('You left the call. Your camera, microphone and screen capture are off.'); });
window.addEventListener('pagehide', cleanup);
