// Run with PLAYWRIGHT_MODULE=/absolute/path/to/playwright/index.mjs node scripts/browser-test.mjs
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_URL || 'http://localhost:8081';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing',
        '--allow-http-screen-capture', '--autoplay-policy=no-user-gesture-required']
});
const errors = [];
const pages = [];
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(() => {
        window.testConnections = [];
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
            constructor(config) { super(config); window.testConnections.push(this); }
        };
        window.testStreams = [];
        const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async options => {
            const stream = await original(options); window.testStreams.push(stream); return stream;
        };
    });
    const room = `test-${Date.now()}`;
    for (const name of ['Alice', 'Bob', 'Charlie']) {
        const page = await context.newPage(); pages.push(page);
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        await page.goto(`${base}/?room=${room}`);
        if (name === 'Alice') await page.screenshot({ path: '/tmp/together-lobby.png', fullPage: true });
        await page.locator('#name').fill(name);
        await page.locator('#join').click();
        await page.locator('#call').waitFor({ state: 'visible' });
    }
    for (const page of pages) {
        await page.waitForFunction(() => window.testConnections.length === 2 && window.testConnections.every(pc => pc.connectionState === 'connected'));
        await page.waitForFunction(() => [...document.querySelectorAll('#videos video')].length === 3 && [...document.querySelectorAll('#videos video')].every(video => video.videoWidth > 0));
        const receivedAudio = await page.evaluate(async () => {
            const reports = await Promise.all(window.testConnections.map(pc => pc.getStats()));
            return reports.every(report => [...report.values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.bytesReceived > 0));
        });
        assert.ok(receivedAudio, 'every peer receives remote audio');
    }
    console.log('PASS: three participants exchange real WebRTC camera and audio tracks.');
    await pages[0].locator('#mic').click();
    await pages[1].waitForFunction(() => [...document.querySelectorAll('#videos .tile')].some(tile => tile.textContent.includes('Alice') && tile.textContent.includes('Muted')));
    await pages[0].locator('#camera').click();
    await pages[1].waitForFunction(() => [...document.querySelectorAll('#videos .tile')].some(tile => tile.textContent.includes('Alice') && tile.querySelector('video').style.opacity === '0'));
    await pages[0].locator('#camera').click(); await pages[0].locator('#mic').click();
    console.log('PASS: microphone and camera state propagate to peers.');
    for (const page of pages.slice(0, 2)) {
        await page.locator('#share').click();
        await page.waitForFunction(() => document.querySelector('#share').textContent === 'Stop sharing');
    }
    await pages[2].waitForFunction(() => {
        const screens = [...document.querySelectorAll('#screens .tile:not([hidden]) video')];
        return screens.length === 2 && screens.every(video => video.videoWidth > 0);
    });
    await pages[2].screenshot({ path: '/tmp/together-group-call.png', fullPage: true });
    console.log('PASS: two simultaneous screen shares received alongside three camera tiles.');
    // A late arrival must receive already-running screen shares too.
    await pages[2].reload(); await pages[2].locator('#name').fill('Charlie'); await pages[2].locator('#join').click();
    await pages[2].waitForFunction(() => [...document.querySelectorAll('#screens .tile:not([hidden]) video')].filter(video => video.videoWidth > 0).length === 2);
    await pages[0].locator('#share').click();
    await pages[2].waitForFunction(() => document.querySelectorAll('#screens .tile:not([hidden])').length === 1);
    console.log('PASS: late join and stop-sharing preserve other shares.');
    await pages[0].locator('#share').click();
    await pages[2].waitForFunction(() => [...document.querySelectorAll('#screens .tile:not([hidden]) video')].filter(video => video.videoWidth > 0).length === 2);
    await pages[0].locator('#leave').click();
    await pages[1].waitForFunction(() => document.querySelectorAll('#videos .tile').length === 2);
    assert.ok(await pages[0].evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))));
    console.log('PASS: restart sharing and leave cleanup.');
    await pages[1].evaluate(() => socket.close());
    await pages[1].locator('#lobby').waitFor({ state: 'visible' });
    assert.ok(await pages[1].evaluate(() => window.testStreams.every(stream => stream.getTracks().every(track => track.readyState === 'ended'))));
    console.log('PASS: signaling loss returns to lobby and releases devices.');
    await pages[0].setViewportSize({ width: 390, height: 844 });
    await pages[0].screenshot({ path: '/tmp/together-mobile.png', fullPage: true });
    assert.ok(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile layout has no horizontal overflow');
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS: mobile layout and no browser errors.');
} catch (error) {
    for (let i = 0; i < pages.length; i++) {
        console.error(`Page ${i}:`, await pages[i].locator('#status').textContent());
        console.error(await pages[i].evaluate(() => window.testConnections?.map(pc => ({ connection: pc.connectionState, signaling: pc.signalingState, transceivers: pc.getTransceivers().map(t => ({ mid: t.mid, direction: t.direction, current: t.currentDirection, sender: t.sender.track?.kind, receiver: t.receiver.track.kind })) }))));
    }
    console.error(errors); throw error;
} finally { await browser.close(); }
