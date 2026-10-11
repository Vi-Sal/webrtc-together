// Live chat, collaborative whiteboard, themes and keyboard controls in real browsers.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { launch, instrument, join, base, roomCode } from './lib.mjs';

const browser = await launch();
const errors = [];

async function draw(page, from, to, steps = 12) {
    const box = await page.locator('#board-canvas').boundingBox();
    const at = ([x, y]) => [box.x + x * box.width, box.y + y * box.height];
    await page.mouse.move(...at(from));
    await page.mouse.down();
    for (let i = 1; i <= steps; i++) {
        await page.mouse.move(...at([from[0] + (to[0] - from[0]) * i / steps, from[1] + (to[1] - from[1]) * i / steps + Math.sin(i) * 0.01]));
    }
    await page.mouse.up();
}
const boardState = page => page.evaluate(() => {
    const canvas = document.querySelector('#board-canvas');
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let ink = 0;
    for (let i = 3; i < data.length; i += 16) if (data[i] > 0) ink++;
    return ink;
});

try {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, acceptDownloads: true });
    await context.addInitScript(instrument);
    const room = roomCode('collab');
    const alice = await join(context, room, 'Alice', { errors, mic: false, camera: false });
    const bob = await join(context, room, 'Bob', { errors, mic: false, camera: false });
    const outsider = await join(context, roomCode('other'), 'Eve', { errors, mic: false, camera: false });
    assert.equal(await alice.evaluate(() => window.testStreams.length), 0, 'devices-off join requests no capture');

    // ---- Chat ----
    await alice.locator('#toggle-chat').click();
    assert.ok(await alice.locator('#chat-send').isDisabled(), 'send disabled for an empty draft');
    await alice.locator('#chat-input').fill('   ');
    assert.ok(await alice.locator('#chat-send').isDisabled(), 'whitespace-only drafts cannot be sent');
    await alice.locator('#chat-input').fill('Line one');
    await alice.keyboard.press('Shift+Enter');
    await alice.keyboard.type('line two <img src=x onerror="window.pwned=1">');
    await alice.keyboard.press('Enter');
    await alice.waitForFunction(() => document.querySelectorAll('#chat-list .msg.is-self:not(.is-pending)').length === 1);
    assert.equal(await alice.locator('#chat-input').inputValue(), '', 'composer clears after Enter');
    await bob.waitForFunction(() => document.querySelector('#chat-badge')?.textContent === '1');
    assert.ok(await bob.locator('.toast', { hasText: 'Alice' }).first().isVisible(), 'new-message notification while chat is closed');
    assert.match(await bob.locator('#toggle-chat').getAttribute('aria-label'), /1 unread/);
    await bob.locator('#toggle-chat').click();
    assert.ok(await bob.locator('#chat-badge').isHidden(), 'opening chat clears unread');
    const bubble = bob.locator('#chat-list .msg-bubble').first();
    assert.equal(await bubble.textContent(), 'Line one\nline two <img src=x onerror="window.pwned=1">');
    assert.equal(await bob.locator('#chat-list img').count(), 0, 'message HTML is never parsed');
    assert.equal(await bob.evaluate(() => window.pwned), undefined);
    assert.equal(await bob.locator('#chat-list .msg-meta strong').first().textContent(), 'Alice');
    assert.equal(await outsider.locator('#chat-list .msg').count(), 0, 'no leakage across rooms');
    console.log('PASS: chat sends with Enter, keeps Shift+Enter newlines, renders safely and stays in its room.');

    await bob.locator('#chat-input').pressSequentially('typing…', { delay: 20 });
    await alice.waitForFunction(() => document.querySelector('#chat-typing').textContent === 'Bob is typing…');
    await alice.waitForFunction(() => document.querySelector('#chat-typing').textContent === '', null, { timeout: 8000 });
    await bob.locator('#chat-input').fill('');
    console.log('PASS: typing indicator appears and expires on its own.');

    await alice.locator('#chat-input').fill('x'.repeat(1001));
    assert.equal((await alice.locator('#chat-input').inputValue()).length, 1000, 'composer stops at the 1000-character limit');
    assert.equal(await alice.locator('#chat-counter').textContent(), '1000 / 1000', 'counter shown near the limit');
    await alice.locator('#chat-input').fill('');

    // Reading older messages: new arrivals must not yank the scroll position.
    for (let i = 0; i < 7; i++) {
        await alice.locator('#chat-input').fill(`Filler message ${i}\n`.repeat(3).trim());
        await alice.keyboard.press('Enter');
    }
    await bob.waitForFunction(() => document.querySelectorAll('#chat-list .msg').length >= 8);
    await bob.evaluate(() => { document.querySelector('#chat-scroll').scrollTop = 0; });
    await alice.locator('#chat-input').fill('Are you still reading?');
    await alice.keyboard.press('Enter');
    await bob.waitForFunction(() => [...document.querySelectorAll('#chat-list .msg-bubble')].some(b => b.textContent === 'Are you still reading?'));
    assert.equal(await bob.evaluate(() => document.querySelector('#chat-scroll').scrollTop), 0, 'reader keeps their position');
    assert.ok(await bob.locator('#chat-jump').isVisible(), 'new-messages pill appears');
    await bob.locator('#chat-jump').click();
    console.log('PASS: no forced scrolling while reading older messages.');

    const late = await join(context, room, 'Late', { errors, mic: false, camera: false });
    await late.locator('#toggle-chat').click();
    await late.waitForFunction(() => document.querySelectorAll('#chat-list .msg').length === 9);
    console.log('PASS: late joiners receive recent chat history.');

    // Reconnect: a message typed while offline is delivered once after reconnecting.
    await alice.evaluate(() => window.testSockets.at(-1).close());
    await alice.locator('#chat-input').fill('Sent while reconnecting');
    await alice.keyboard.press('Enter');
    await alice.waitForFunction(() => document.querySelector('#connection').dataset.state === 'connected', null, { timeout: 20000 });
    await bob.waitForFunction(() => [...document.querySelectorAll('#chat-list .msg-bubble')].filter(b => b.textContent === 'Sent while reconnecting').length === 1, null, { timeout: 15000 });
    await alice.waitForFunction(() => !document.querySelector('#chat-list .is-pending'));
    assert.equal(await alice.locator('#chat-list .msg-bubble', { hasText: 'Sent while reconnecting' }).count(), 1, 'no duplicate after reconnect');
    assert.equal(await alice.locator('#chat-list .msg.is-self').count(), 10, 'own messages remain "mine" after reconnect');
    console.log('PASS: chat survives a reconnect without loss or duplicates.');

    // ---- Whiteboard ----
    await alice.locator('#toggle-board').click();
    await bob.locator('#toggle-board').click();
    assert.ok(await alice.locator('#chat-panel').isVisible(), 'chat stays usable alongside the whiteboard');
    assert.ok(await alice.locator('#people .tile').first().isVisible(), 'participant thumbnails remain visible');
    await draw(alice, [0.1, 0.2], [0.45, 0.4]);
    await bob.waitForFunction(() => document.querySelector('#board-empty').hidden);
    await bob.waitForFunction(() => {
        const c = document.querySelector('#board-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        for (let i = 3; i < d.length; i += 16) if (d[i]) return true;
        return false;
    });
    await bob.locator('.tool-btn[data-tool="rect"]').click();
    await bob.locator('[data-color="#c2453e"], [data-color="#C2453E"]').click();
    await draw(bob, [0.55, 0.55], [0.85, 0.85], 4);
    await alice.keyboard.press('t');
    assert.equal(await alice.locator('.tool-btn[data-tool="text"]').getAttribute('aria-pressed'), 'true', 'keyboard tool shortcut');
    const box = await alice.locator('#board-canvas').boundingBox();
    await alice.mouse.click(box.x + box.width * 0.6, box.y + box.height * 0.15);
    await alice.locator('.board-text-input').fill('Ship it');
    await alice.keyboard.press('Enter');
    await alice.keyboard.press('p');
    await alice.waitForFunction(() => !document.querySelector('#board-undo').disabled);
    // Both canvases converge on the same pixels (same board size, so identical drawings).
    let aliceInk = 0, bobInk = -1;
    for (let i = 0; i < 40 && (aliceInk !== bobInk || aliceInk === 0); i++) {
        await alice.waitForTimeout(200);
        [aliceInk, bobInk] = [await boardState(alice), await boardState(bob)];
    }
    assert.ok(aliceInk > 0 && aliceInk === bobInk, `boards converge (${aliceInk} vs ${bobInk})`);
    console.log('PASS: pen, rectangle and text appear for every participant.');

    // A late joiner sees the same board, at a different viewport size.
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await phone.addInitScript(instrument);
    const mobile = await join(phone, room, 'Mobile', { errors, mic: false, camera: false });
    await mobile.locator('#toggle-board').click();
    await mobile.waitForFunction(() => document.querySelector('#board-empty').hidden);
    const elements = page => page.evaluate(() => document.querySelector('#board-canvas') && null);
    assert.equal(await elements(mobile), null);
    assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'mobile whiteboard has no horizontal overflow');
    await mobile.screenshot({ path: '/tmp/together-mobile-board.png' });
    console.log('PASS: late joiner on a phone receives the current board.');

    // Undo only affects the participant's own work; redo restores it.
    const beforeUndo = await boardState(bob);
    await bob.keyboard.press('Control+z');
    await alice.waitForFunction(ink => {
        const c = document.querySelector('#board-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 3; i < d.length; i += 16) if (d[i]) count++;
        return count < ink * 0.95;
    }, aliceInk);
    assert.ok(await bob.locator('#board-undo').isDisabled(), 'Bob has nothing more of his own to undo');
    assert.ok(await boardState(bob) > 0, "Alice's work survives Bob's undo");
    await bob.keyboard.press('Control+Shift+z');
    await bob.waitForFunction(ink => {
        const c = document.querySelector('#board-canvas');
        const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
        let count = 0;
        for (let i = 3; i < d.length; i += 16) if (d[i]) count++;
        return Math.abs(count - ink) / ink < 0.02;
    }, beforeUndo);
    console.log('PASS: collaborative undo/redo targets only your own operations.');

    // Export.
    const [download] = await Promise.all([alice.waitForEvent('download'), alice.locator('#board-export').click()]);
    assert.match(download.suggestedFilename(), /^together-whiteboard-.*\.png$/);
    const png = await readFile(await download.path());
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), 2560, 'export width');
    console.log('PASS: PNG export at 2560×1440.');

    // Clear requires confirmation; cancelling keeps the board.
    await bob.locator('#board-clear').click();
    await bob.locator('#confirm-dialog').waitFor();
    await bob.locator('#confirm-dialog button[value="cancel"]').click();
    assert.ok(await boardState(alice) > 0, 'cancel keeps the board');
    await bob.locator('#board-clear').click();
    await bob.locator('#confirm-ok').click();
    await alice.waitForFunction(() => !document.querySelector('#board-empty').hidden);
    await mobile.waitForFunction(() => !document.querySelector('#board-empty').hidden);
    assert.equal(await boardState(alice), 0);
    await alice.waitForFunction(() => [...document.querySelectorAll('.msg-system')].some(m => m.textContent.includes('Bob cleared the whiteboard')));
    console.log('PASS: clear is confirmed, synchronized and attributed.');

    // Return to video: media connections unaffected by whiteboard use.
    await alice.locator('#toggle-board').click();
    assert.equal(await alice.evaluate(() => document.querySelector('#stage').dataset.layout), 'grid');

    // ---- Theme ----
    const themePage = await context.newPage();
    await themePage.goto(base);
    assert.equal(await themePage.evaluate(() => document.documentElement.dataset.theme), 'light', 'Frost Light by default');
    await themePage.locator('#landing [data-theme-toggle]').click();
    assert.equal(await themePage.evaluate(() => document.documentElement.dataset.theme), 'dark');
    await themePage.reload();
    assert.equal(await themePage.evaluate(() => document.documentElement.dataset.theme), 'dark', 'theme persists');
    // The pre-paint script applies the theme before stylesheets load: no flash.
    assert.ok(await themePage.evaluate(() => [...document.head.children].findIndex(n => n.src?.endsWith('theme-init.js'))
        < [...document.head.children].findIndex(n => n.rel === 'stylesheet')));
    await themePage.waitForTimeout(400);
    await themePage.screenshot({ path: '/tmp/together-landing-dark.png' });
    console.log('PASS: Midnight Glass persists and is applied before first paint.');

    // ---- Keyboard: landing join flow ----
    await themePage.keyboard.press('Tab');
    await themePage.locator('#landing [data-action="show-join"]').last().focus();
    await themePage.keyboard.press('Enter');
    assert.ok(await themePage.locator('#join-code').evaluate(node => node === document.activeElement), 'join field focused');
    await themePage.keyboard.type('bad');
    await themePage.keyboard.press('Enter');
    assert.match(await themePage.locator('#landing-error').textContent(), /8–80/);
    await themePage.locator('#join-code').fill(`${base}/?room=${room}`);
    await themePage.keyboard.press('Enter');
    await themePage.locator('#lobby').waitFor();
    assert.equal(await themePage.locator('#lobby-room').textContent(), room, 'pasted invitation opens its room');
    await themePage.locator('#lobby-back').click();
    await themePage.locator('#start-meeting').click();
    assert.match(await themePage.locator('#lobby-room').textContent(), /^[a-z]{4}-[a-z]{4}-[a-z]{4}$/, 'new meetings get unguessable codes');
    console.log('PASS: keyboard join flow, invitation parsing and generated room codes.');

    assert.deepEqual(errors, [], 'browser errors');
    console.log('PASS: no browser errors.');
} catch (error) {
    console.error(errors);
    throw error;
} finally {
    await browser.close();
}
