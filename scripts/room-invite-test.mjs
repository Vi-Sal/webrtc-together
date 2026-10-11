import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.TEST_URL || 'http://localhost:8081';
const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
});
try {
    const context = await browser.newContext();
    const errors = [];
    async function open(name) {
        const page = await context.newPage(); page.on('pageerror', e => errors.push(e.message));
        await page.goto(base); await page.locator('#name').fill(name); return page;
    }
    const alice = await open('Alice'), bob = await open('Bob');
    await bob.locator('#room-input').fill('   ');
    for (const page of [alice, bob]) {
        assert.match(await page.locator('#join').textContent(), /Join DEFAULT_NAME/);
        await page.locator('#join').click(); await page.locator('#call').waitFor({ state: 'visible' });
    }
    for (const page of [alice, bob]) {
        await page.waitForFunction(() => document.querySelector('#participant-count').textContent.startsWith('2 people'));
        assert.equal(await page.locator('#room-code').textContent(), 'DEFAULT_NAME');
    }
    console.log('PASS: empty room fields join the same DEFAULT_NAME room.');
    const invitation = alice.url();
    await bob.locator('#leave').click(); await bob.locator('#room-input').fill(invitation);
    assert.match(await bob.locator('#join').textContent(), /Join this room/);
    await bob.locator('#join').click();
    for (const page of [alice, bob]) {
        await page.waitForFunction(() => document.querySelector('#participant-count').textContent.startsWith('2 people'));
        await page.waitForFunction(() => {
            const video = document.querySelector('#videos .tile:not(.local) video');
            return video && video.videoWidth > 0 && !video.paused && video.currentTime > 0;
        });
        const time = await page.locator('#videos .tile:not(.local) video').evaluate(video => video.currentTime);
        await page.waitForFunction(previous => document.querySelector('#videos .tile:not(.local) video').currentTime > previous + 0.2, time);
    }
    assert.equal(await alice.locator('#room-code').textContent(), await bob.locator('#room-code').textContent());
    console.log('PASS: pasting the same invite produces two participants and advancing video in both directions.');
    await bob.locator('#leave').click();
    await bob.locator('#room-input').fill(await alice.locator('#room-code').textContent());
    await bob.locator('#join').click();
    await bob.waitForFunction(() => document.querySelector('#participant-count').textContent.startsWith('2 people'));
    console.log('PASS: room code alone rejoins the existing room.');
    const custom = await open('Custom room');
    await custom.locator('#room-input').fill('custom-room'); await custom.locator('#join').click();
    await custom.locator('#call').waitFor({ state: 'visible' });
    assert.equal(await custom.locator('#room-code').textContent(), 'custom-room');
    assert.match(await custom.locator('#participant-count').textContent(), /^1 person/);
    console.log('PASS: custom room remains separate from DEFAULT_NAME.');
    const wrongServer = await open('Other server');
    const otherLink = new URL(invitation); otherLink.port = otherLink.port === '8081' ? '8080' : '8081';
    await wrongServer.locator('#room-input').fill(otherLink.href); await wrongServer.locator('#join').click();
    assert.match(await wrongServer.locator('#status').textContent(), /same server and port/);
    assert.equal(await wrongServer.locator('#lobby').isVisible(), true);
    assert.equal(await wrongServer.locator('#call').isVisible(), false);
    assert.deepEqual(errors, []);
    console.log('PASS: different-server invites cannot silently create an isolated room.');
} finally { await browser.close(); }
