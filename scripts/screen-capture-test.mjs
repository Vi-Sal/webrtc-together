// Screen-share failure modes leave the call intact and are explained precisely.
import assert from 'node:assert/strict';
import { launch, join, roomCode } from './lib.mjs';

const browser = await launch();
const errors = [];
try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        window.captureMode = 'unsupported'; window.capturedScreens = []; window.captureRequests = [];
        navigator.mediaDevices.getDisplayMedia = async options => {
            window.captureRequests.push(options);
            if (window.captureMode === 'unsupported') throw new DOMException('Not supported', 'NotSupportedError');
            if (window.captureMode === 'cancel') throw new DOMException('Permission denied', 'NotAllowedError');
            const stream = await capture(options);
            window.capturedScreens.push(stream);
            if (window.captureMode === 'quality') stream.getVideoTracks()[0].applyConstraints = async () => { throw new DOMException('Not supported', 'NotSupportedError'); };
            return stream;
        };
        const PC = window.RTCPeerConnection;
        window.testConnections = [];
        window.RTCPeerConnection = class extends PC { constructor(c) { super(c); window.testConnections.push(this); } };
    });
    const room = roomCode('screen');
    const alice = await join(context, room, 'Alice', { errors });
    const bob = await join(context, room, 'Bob', { errors });
    await bob.waitForFunction(() => window.testConnections.some(pc => pc.connectionState === 'connected'));
    const callIntact = () => alice.evaluate(() => document.querySelector('#connection').dataset.state === 'connected');

    await alice.locator('#share').click();
    await alice.locator('#screen-notice').waitFor();
    assert.match(await alice.locator('#screen-details').textContent(), /Step: capture\nError: NotSupportedError/);
    assert.ok(await callIntact());
    console.log('PASS: unsupported capture is explained and the call continues.');

    await alice.evaluate(() => { window.captureMode = 'cancel'; });
    await alice.locator('#share').click();
    await alice.waitForFunction(() => document.querySelector('#screen-message').textContent.includes('cancelled or blocked'));
    console.log('PASS: cancellation is distinguished from unsupported capture.');

    await alice.evaluate(() => { window.captureMode = 'quality'; });
    await alice.locator('#share').click();
    await bob.waitForFunction(() => [...document.querySelectorAll('#screens .tile:not([hidden]) video')].some(v => v.videoWidth > 0));
    assert.deepEqual(await alice.evaluate(() => window.captureRequests.at(-1)), { video: true, audio: false });
    assert.ok(await alice.locator('#screen-notice').isHidden());
    await alice.locator('#share').click();
    await bob.waitForFunction(() => document.querySelectorAll('#screens .tile:not([hidden])').length === 0);
    console.log('PASS: rejected optional quality settings still allow sharing.');

    await alice.evaluate(() => {
        window.captureMode = 'normal';
        const pc = window.testConnections.find(c => c.connectionState === 'connected');
        const sender = pc.getTransceivers()[2].sender;
        const original = sender.replaceTrack.bind(sender);
        sender.replaceTrack = track => track ? Promise.reject(new DOMException('Not supported', 'NotSupportedError')) : original(track);
    });
    await alice.locator('#share').click();
    await alice.waitForFunction(() => !document.querySelector('#screen-notice').hidden && document.querySelector('#screen-details').textContent.includes('Step: publish'));
    assert.match(await alice.locator('#screen-message').textContent(), /could not be sent/);
    assert.ok(await alice.evaluate(() => window.capturedScreens.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
    assert.equal(await alice.locator('#share').getAttribute('aria-pressed'), 'false');
    assert.ok(await callIntact());
    assert.deepEqual(errors, []);
    console.log('PASS: publish failure releases only the screen capture.');
} finally {
    await browser.close();
}
