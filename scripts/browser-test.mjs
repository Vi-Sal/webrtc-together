// Multi-participant call regression: media, mute/camera, screens, view switching, reconnect, cleanup.
import assert from 'node:assert/strict';
import { launch, instrument, join, waitForPeers, tileOf, roomCode } from './lib.mjs';

const browser = await launch();
const errors = [];
try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await context.addInitScript(instrument);
    const room = roomCode('call');
    const pages = [];
    for (const name of ['Alice', 'Bob', 'Charlie']) pages.push(await join(context, room, name, { errors }));
    const [alice, bob, charlie] = pages;
    for (const page of pages) {
        await waitForPeers(page, 2);
        const audio = await page.evaluate(async () => {
            const reports = await Promise.all(window.testConnections.filter(pc => pc.connectionState === 'connected').map(pc => pc.getStats()));
            return reports.every(report => [...report.values()].some(stat => stat.type === 'inbound-rtp' && stat.kind === 'audio' && stat.bytesReceived > 0));
        });
        assert.ok(audio, 'every peer receives remote audio');
    }
    assert.equal(await alice.locator('#participant-count span').textContent(), '3');
    await alice.screenshot({ path: '/tmp/together-group-call.png' });
    console.log('PASS: three participants exchange camera video and audio.');

    await alice.locator('#mic').click();
    await bob.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Alice') && t.classList.contains('mic-off')));
    assert.equal(await alice.locator('#mic').getAttribute('aria-label'), 'Unmute microphone');
    await alice.locator('#camera').click();
    await bob.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Alice') && t.classList.contains('camera-off')));
    assert.ok(await alice.evaluate(() => window.testStreams.some(s => s.getVideoTracks().some(t => t.readyState === 'ended'))), 'camera off releases the device');
    await alice.locator('#camera').click();
    await alice.locator('#mic').click();
    await bob.waitForFunction(() => [...document.querySelectorAll('#people .tile')].some(t => t.textContent.includes('Alice') && !t.classList.contains('camera-off') && !t.classList.contains('mic-off') && t.querySelector('video').videoWidth > 0));
    console.log('PASS: mute and camera state propagate; camera restarts.');

    const before = await bob.evaluate(() => window.testConnections.filter(pc => pc.connectionState === 'connected'));
    await bob.locator('#toggle-board').click();
    await bob.locator('#board').waitFor();
    await bob.locator('#toggle-chat').click();
    await bob.evaluate(() => document.querySelector('[data-theme-toggle]').click());
    await bob.locator('#toggle-board').click();
    assert.ok(await bob.evaluate(() => {
        const live = window.testConnections.filter(pc => pc.connectionState === 'connected');
        return live.length === 2 && window.testConnections.length === 2;
    }), 'switching views, panels and theme never recreates peer connections');
    assert.ok(before);
    await bob.locator('#panel-close').click();
    console.log('PASS: view, panel and theme changes keep the same peer connections.');

    for (const page of [alice, bob]) {
        await page.locator('#share').click();
        await page.waitForFunction(() => document.querySelector('#share').getAttribute('aria-pressed') === 'true');
    }
    await charlie.waitForFunction(() => {
        const screens = [...document.querySelectorAll('#screens .tile:not([hidden]) video')];
        return screens.length === 2 && screens.every(video => video.videoWidth > 0) && document.querySelector('#stage').dataset.layout === 'presentation';
    });
    await charlie.screenshot({ path: '/tmp/together-presentation.png' });
    console.log('PASS: two simultaneous screen shares use the presentation layout.');

    await charlie.reload();
    await charlie.locator('#display-name').fill('Charlie');
    await charlie.locator('#join-button').click();
    await charlie.waitForFunction(() => [...document.querySelectorAll('#screens .tile:not([hidden]) video')].filter(v => v.videoWidth > 0).length === 2, null, { timeout: 20000 });
    await alice.locator('#share').click();
    await charlie.waitForFunction(() => document.querySelectorAll('#screens .tile:not([hidden])').length === 1);
    console.log('PASS: late join receives running shares; stopping one keeps the other.');

    // Signaling loss: the client reconnects with the same identity and media resumes.
    const aliceId = await alice.evaluate(() => sessionStorage.getItem(Object.keys(sessionStorage).find(k => k.startsWith('together-resume'))));
    assert.ok(aliceId, 'resume token stored per tab');
    await bob.evaluate(() => window.testSockets.at(-1).close());
    await bob.waitForFunction(() => document.querySelector('#connection').dataset.state === 'reconnecting' || document.querySelector('#connection').dataset.state === 'connected');
    await bob.waitForFunction(() => document.querySelector('#connection').dataset.state === 'connected', null, { timeout: 20000 });
    await bob.waitForFunction(() => window.testConnections.filter(pc => pc.connectionState === 'connected').length === 2, null, { timeout: 20000 });
    await alice.waitForFunction(() => document.querySelectorAll('#people .tile').length === 3);
    assert.ok(await bob.evaluate(() => window.testStreams.some(s => s.getTracks().some(t => t.readyState === 'live'))), 'local media kept across reconnect');
    console.log('PASS: a dropped signaling connection reconnects automatically and restores media.');

    await alice.locator('#leave').click();
    await alice.locator('#lobby').waitFor();
    await bob.waitForFunction(() => document.querySelectorAll('#people .tile').length === 2);
    assert.ok(await alice.evaluate(() => window.testStreams.every(s => s.getTracks().every(t => t.readyState === 'ended'))));
    console.log('PASS: leaving releases camera, microphone and screen capture.');

    await charlie.setViewportSize({ width: 390, height: 844 });
    await charlie.waitForTimeout(400);
    await charlie.screenshot({ path: '/tmp/together-mobile.png' });
    assert.ok(await charlie.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile has no horizontal overflow');
    assert.ok(await charlie.locator('#share').isHidden(), 'compact toolbar moves Share into More');
    await charlie.locator('#more').click();
    assert.ok(await charlie.locator('[data-menu="share"]').isVisible());
    await charlie.keyboard.press('Escape');
    assert.ok(await charlie.locator('#more-menu').isHidden());
    await charlie.locator('#toggle-chat').click();
    const sheet = await charlie.locator('#side-panel').boundingBox();
    assert.ok(sheet.width >= 389 && sheet.y > 100, 'chat opens as a bottom sheet');
    await charlie.screenshot({ path: '/tmp/together-mobile-chat.png' });
    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS: mobile layout, compact toolbar, bottom-sheet chat and no browser errors.');
} catch (error) {
    console.error(errors);
    throw error;
} finally {
    await browser.close();
}
