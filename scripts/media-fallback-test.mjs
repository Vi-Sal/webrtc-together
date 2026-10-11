// Same Playwright/Chrome setup as browser-test.mjs; see README.md.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required']
});
const base = process.env.TEST_URL || 'http://localhost:8081';
const errors = [];
try {
    const context = await browser.newContext();
    await context.addInitScript(() => {
        window.failAudio = ''; window.failVideo = ''; window.captured = []; window.requests = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
            window.requests.push(options);
            const failure = options.audio ? window.failAudio : window.failVideo;
            if (failure) throw new DOMException('Could not start audio source', failure);
            const stream = await original(options); window.captured.push(stream);
            if (window.delayCapture) await new Promise(resolve => { window.releaseCapture = resolve; });
            return stream;
        };
    });
    async function page(name, audioFailure = '', videoFailure = '') {
        const p = await context.newPage(); p.on('pageerror', error => errors.push(error.message));
        await p.goto(`${base}/?room=fallback-${process.pid}`);
        await p.evaluate(([audio, video]) => { window.failAudio = audio; window.failVideo = video; }, [audioFailure, videoFailure]);
        await p.locator('#name').fill(name); return p;
    }
    const healthy = await page('Alice'); await healthy.locator('#join').click();
    await healthy.locator('#call').waitFor({ state: 'visible' });
    const failed = await page('Bob', 'NotReadableError'); await failed.locator('#join').click();
    await failed.locator('#call').waitFor({ state: 'visible' });
    assert.match(await failed.locator('#media-status').textContent(), /Microphone could not start/);
    assert.equal(await failed.locator('#mic').textContent(), 'Retry mic');
    await healthy.waitForFunction(() => [...document.querySelectorAll('#videos .tile')].some(tile => tile.textContent.includes('Bob') && tile.textContent.includes('Muted') && tile.querySelector('video').videoWidth > 0));
    await failed.waitForFunction(() => [...document.querySelectorAll('#videos .tile')].some(tile => tile.textContent.includes('Alice') && tile.querySelector('video').videoWidth > 0));
    console.log('PASS: busy microphone does not block joining or bidirectional video.');
    await failed.evaluate(() => { window.failAudio = ''; }); await failed.locator('#mic').click();
    await failed.waitForFunction(() => document.querySelector('#mic').textContent === 'Mute mic');
    await healthy.waitForFunction(async () => {
        const peer = [...peers.values()].find(peer => peer.info.name === 'Bob');
        if (!peer) return false;
        return [...(await peer.pc.getStats()).values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.bytesReceived > 0);
    });
    assert.equal(await failed.locator('#media-status').isVisible(), false);
    console.log('PASS: retry microphone restores actual received audio without rejoining.');
    const listener = await page('Carol', 'NotAllowedError', 'NotFoundError');
    await listener.locator('#join').click(); await listener.locator('#call').waitFor({ state: 'visible' });
    assert.match(await listener.locator('#media-status').textContent(), /access is blocked/);
    assert.match(await listener.locator('#media-status').textContent(), /Camera not found/);
    await listener.waitForFunction(() => [...document.querySelectorAll('#videos .tile:not(.local) video')].filter(v => v.videoWidth > 0).length === 2);
    await listener.evaluate(() => { window.failVideo = ''; }); await listener.locator('#camera').click();
    await healthy.waitForFunction(() => [...document.querySelectorAll('#videos .tile')].some(tile => tile.textContent.includes('Carol') && tile.querySelector('video').videoWidth > 0));
    assert.match(await listener.locator('#media-status').textContent(), /Microphone access is blocked/);
    console.log('PASS: missing/denied devices allow listening, and camera retry restores video.');
    await listener.evaluate(() => { window.failAudio = ''; window.delayCapture = true; });
    await listener.locator('#mic').click(); await listener.waitForFunction(() => !!window.releaseCapture);
    await listener.locator('#leave').click(); await listener.evaluate(() => window.releaseCapture());
    await listener.waitForFunction(() => window.captured.every(stream => stream.getTracks().every(track => track.readyState === 'ended')));
    console.log('PASS: leaving during a pending device retry releases the late stream.');
    const off = await page('Devices off');
    await off.locator('#start-mic').uncheck(); await off.locator('#start-camera').uncheck();
    await off.locator('#join').click(); await off.locator('#call').waitFor({ state: 'visible' });
    assert.equal(await off.evaluate(() => window.requests.length), 0);
    assert.equal(await off.locator('#mic').textContent(), 'Enable mic');
    assert.equal(await off.locator('#camera').textContent(), 'Enable camera');
    await off.waitForFunction(() => [...document.querySelectorAll('#videos .tile:not(.local) video')].filter(v => v.videoWidth > 0).length === 2);
    console.log('PASS: devices-off join requests no capture and still receives remote media.');
    assert.deepEqual(errors, []);
} finally { await browser.close(); }
