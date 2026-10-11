// Unavailable or denied devices never block joining; retry restores them live.
import assert from 'node:assert/strict';
import { launch, base, join, roomCode, track } from './lib.mjs';

const browser = await launch();
const errors = [];
try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        window.failAudio = ''; window.failVideo = ''; window.captured = []; window.requests = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
            window.requests.push(options);
            const failure = (options.audio && window.failAudio) || (options.video && window.failVideo);
            if (failure) throw new DOMException('Could not start source', failure);
            const stream = await original(options);
            window.captured.push(stream);
            if (window.delayCapture) await new Promise(resolve => { window.releaseCapture = resolve; });
            return stream;
        };
    });
    const room = roomCode('fallback');
    async function open(name, audio = '', video = '') {
        const page = track(await context.newPage(), errors, name);
        await page.goto(`${base}/?room=${room}`);
        await page.evaluate(([a, v]) => { window.failAudio = a; window.failVideo = v; }, [audio, video]);
        await page.locator('#display-name').fill(name);
        await page.locator('#join-button').click();
        await page.locator('#meeting').waitFor({ state: 'visible' });
        return page;
    }
    const healthy = await open('Alice');
    const busyMic = await open('Bob', 'NotReadableError');
    assert.match(await busyMic.locator('#media-status-text').textContent(), /Microphone could not start/);
    assert.equal(await busyMic.locator('#mic').getAttribute('aria-label'), 'Retry microphone');
    await healthy.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Bob') && t.classList.contains('mic-off') && t.querySelector('video').videoWidth > 0));
    console.log('PASS: a busy microphone does not block joining or video.');

    await busyMic.evaluate(() => { window.failAudio = ''; });
    await busyMic.locator('#mic').click();
    await busyMic.waitForFunction(() => document.querySelector('#mic').getAttribute('aria-label') === 'Mute microphone');
    await healthy.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Bob') && !t.classList.contains('mic-off')));
    assert.ok(await busyMic.locator('#media-status').isHidden());
    console.log('PASS: retrying the microphone restores it without rejoining.');

    const listener = await open('Carol', 'NotAllowedError', 'NotFoundError');
    const notice = await listener.locator('#media-status-text').textContent();
    assert.match(notice, /Microphone access is blocked/);
    assert.match(notice, /Camera not found/);
    await listener.waitForFunction(() => [...document.querySelectorAll('#people .tile:not(.is-local) video')].filter(v => v.videoWidth > 0).length === 2, null, { timeout: 20000 });
    await listener.evaluate(() => { window.failVideo = ''; });
    await listener.locator('#camera').click();
    await healthy.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Carol') && !t.classList.contains('camera-off') && t.querySelector('video').videoWidth > 0));
    console.log('PASS: denied/missing devices still allow listening; camera retry restores video.');

    await listener.evaluate(() => { window.failAudio = ''; window.delayCapture = true; });
    await listener.locator('#mic').click();
    await listener.waitForFunction(() => !!window.releaseCapture);
    await listener.locator('#leave').click();
    await listener.evaluate(() => window.releaseCapture());
    await listener.waitForFunction(() => window.captured.every(s => s.getTracks().every(t => t.readyState === 'ended')));
    console.log('PASS: leaving during a pending device request releases the late stream.');

    const off = track(await context.newPage(), errors, 'Off');
    await off.goto(`${base}/?room=${room}`);
    await off.locator('#lobby-mic').click();
    await off.locator('#lobby-camera').click();
    await off.locator('#display-name').fill('Devices off');
    await off.locator('#join-button').click();
    await off.locator('#meeting').waitFor({ state: 'visible' });
    assert.equal(await off.evaluate(() => window.requests.length), 0, 'no capture requested');
    assert.equal(await off.locator('#mic').getAttribute('aria-label'), 'Turn on microphone');
    assert.deepEqual(errors, []);
    console.log('PASS: joining with devices off requests no capture.');
} finally {
    await browser.close();
}
