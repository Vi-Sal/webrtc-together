import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
        '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing',
        '--allow-http-screen-capture', '--autoplay-policy=no-user-gesture-required']
});
try {
    const context = await browser.newContext();
    const errors = [];
    await context.addInitScript(() => {
        const capture = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        window.captureMode = 'unsupported'; window.capturedScreens = []; window.captureRequests = [];
        navigator.mediaDevices.getDisplayMedia = async options => {
            window.captureRequests.push(options);
            if (window.captureMode === 'unsupported') throw new DOMException('Not supported', 'NotSupportedError');
            if (window.captureMode === 'cancel') throw new DOMException('Permission denied', 'NotAllowedError');
            const stream = await capture(options); window.capturedScreens.push(stream);
            if (window.captureMode === 'quality') stream.getVideoTracks()[0].applyConstraints = async () => { throw new DOMException('Not supported', 'NotSupportedError'); };
            return stream;
        };
    });
    const room = `screen-errors-${Date.now()}`;
    const pages = [];
    for (const name of ['Alice', 'Bob']) {
        const page = await context.newPage(); pages.push(page);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(`${process.env.TEST_URL || 'http://localhost:8081'}/?room=${room}`);
        await page.locator('#name').fill(name); await page.locator('#join').click();
        await page.locator('#call').waitFor({ state: 'visible' });
    }
    const [alice, bob] = pages;
    await bob.waitForFunction(() => [...peers.values()].every(peer => peer.pc.connectionState === 'connected'));
    await alice.locator('#share').click(); await alice.locator('#screen-notice').waitFor({ state: 'visible' });
    assert.match(await alice.locator('#screen-details').textContent(), /Step: capture\nError: NotSupportedError/);
    assert.equal(await alice.locator('#share').isEnabled(), true);
    assert.ok(await alice.evaluate(() => joined && localMedia.getTracks().every(t => t.readyState === 'live')));
    console.log('PASS: unsupported capture explains the environment limitation and preserves the call.');
    await alice.evaluate(() => { window.captureMode = 'cancel'; });
    await alice.locator('#share').click();
    await alice.waitForFunction(() => document.querySelector('#screen-message').textContent.includes('cancelled or blocked'));
    assert.equal(await alice.locator('#share').isEnabled(), true);
    console.log('PASS: cancellation is distinguished from unsupported capture.');
    await alice.evaluate(() => { window.captureMode = 'quality'; });
    await alice.locator('#share').click();
    await bob.waitForFunction(() => [...document.querySelectorAll('#screens .tile:not([hidden]) video')].some(video => video.videoWidth > 0));
    assert.deepEqual(await alice.evaluate(() => window.captureRequests.at(-1)), { video: true, audio: false });
    assert.equal(await alice.locator('#screen-notice').isVisible(), false);
    await alice.locator('#share').click();
    await bob.waitForFunction(() => document.querySelectorAll('#screens .tile:not([hidden])').length === 0);
    console.log('PASS: unsupported optional quality settings still permit screen sharing.');
    await alice.evaluate(() => {
        window.captureMode = 'normal';
        const sender = [...peers.values()][0].pc.getTransceivers()[2].sender;
        const original = sender.replaceTrack.bind(sender);
        sender.replaceTrack = track => track ? Promise.reject(new DOMException('Not supported', 'NotSupportedError')) : original(track);
    });
    await alice.locator('#share').click();
    await alice.waitForFunction(() => !document.querySelector('#screen-notice').hidden && document.querySelector('#screen-details').textContent.includes('Step: publish'));
    assert.ok(await alice.evaluate(() => window.capturedScreens.every(stream => stream.getTracks().every(t => t.readyState === 'ended'))));
    assert.ok(await alice.evaluate(() => localMedia.getTracks().every(t => t.readyState === 'live')));
    assert.match(await alice.locator('#screen-message').textContent(), /could not be sent/);
    assert.deepEqual(errors, []);
    console.log('PASS: publishing failure is identified separately and releases screen capture only.');
} finally { await browser.close(); }
