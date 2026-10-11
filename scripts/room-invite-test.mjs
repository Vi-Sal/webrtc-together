// Invitations: unique rooms, links and codes join the same room, wrong-server links are refused.
import assert from 'node:assert/strict';
import { launch, base, join, track } from './lib.mjs';

const browser = await launch();
const errors = [];
try {
    const context = await browser.newContext();
    const starters = [];
    for (const name of ['Alice', 'Dana']) {
        const page = track(await context.newPage(), errors, name);
        await page.goto(base);
        await page.locator('#start-meeting').click();
        await page.locator('#display-name').fill(name);
        await page.locator('#join-button').click();
        await page.locator('#meeting').waitFor({ state: 'visible' });
        starters.push(page);
    }
    const [alice, dana] = starters;
    assert.notEqual(await alice.locator('#room-code').textContent(), await dana.locator('#room-code').textContent());
    assert.equal(await dana.locator('#participant-count span').textContent(), '1', 'strangers are never placed in a shared default room');
    console.log('PASS: Start a meeting creates a separate, unguessable room each time.');

    const invitation = alice.url();
    assert.match(invitation, /\?room=[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
    const bob = track(await context.newPage(), errors, 'Bob');
    await bob.goto(base);
    await bob.locator('#landing [data-action="show-join"]').last().click();
    await bob.locator('#join-code').fill(invitation);
    await bob.locator('#join-code').press('Enter');
    await bob.locator('#display-name').fill('Bob');
    await bob.locator('#join-button').click();
    for (const page of [alice, bob]) {
        await page.waitForFunction(() => document.querySelector('#participant-count span').textContent === '2');
        await page.waitForFunction(() => {
            const video = document.querySelector('#people .tile:not(.is-local) video');
            return video && video.videoWidth > 0 && !video.paused;
        }, null, { timeout: 20000 });
    }
    console.log('PASS: a pasted invitation link joins the same room with two-way video.');

    await bob.locator('#leave').click();
    await bob.locator('#lobby').waitFor();
    await bob.locator('#join-button').click();
    await alice.waitForFunction(() => document.querySelector('#participant-count span').textContent === '2');
    console.log('PASS: rejoining from the lobby returns to the same room.');

    const legacy = await join(context, 'DEFAULT_NAME', 'Legacy', { errors, mic: false, camera: false });
    assert.equal(await legacy.locator('#room-code').textContent(), 'DEFAULT_NAME', 'existing room URLs keep working');
    console.log('PASS: existing ?room= invitations remain compatible.');

    const wrong = track(await context.newPage(), errors, 'Wrong');
    await wrong.goto(base);
    await wrong.locator('#landing [data-action="show-join"]').last().click();
    const other = new URL(invitation); other.port = other.port === '8081' ? '8080' : '8081';
    await wrong.locator('#join-code').fill(other.href);
    await wrong.locator('#join-code').press('Enter');
    assert.match(await wrong.locator('#landing-error').textContent(), /same server/);
    assert.ok(await wrong.locator('#landing').isVisible());
    assert.deepEqual(errors, []);
    console.log('PASS: invitations for a different server are refused with an explanation.');
} finally {
    await browser.close();
}
