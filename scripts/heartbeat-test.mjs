// Joined clients send keepalives; leaving stops them.
import assert from 'node:assert/strict';
import { launch, base, roomCode } from './lib.mjs';

const browser = await launch([]);
try {
    const page = await browser.newPage();
    let pings = 0, pongs = 0;
    page.on('websocket', socket => {
        socket.on('framesent', frame => { if (JSON.parse(frame.payload).type === 'ping') pings++; });
        socket.on('framereceived', frame => { if (JSON.parse(frame.payload).type === 'pong') pongs++; });
    });
    await page.goto(`${base}/?room=${roomCode('heartbeat')}`);
    await page.clock.install();
    await page.locator('#lobby-mic').click();
    await page.locator('#lobby-camera').click();
    await page.locator('#display-name').fill('Heartbeat test');
    await page.locator('#join-button').click();
    await page.locator('#meeting').waitFor({ state: 'visible' });
    await page.clock.runFor(25000);
    for (let i = 0; i < 50 && pongs === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(pings, 1);
    assert.equal(pongs, 1);
    await page.locator('#leave').click();
    await page.clock.runFor(50000);
    assert.equal(pings, 1, 'leaving stops heartbeats');
    console.log('PASS: joined clients exchange heartbeats; leaving clears the timer.');
} finally {
    await browser.close();
}
