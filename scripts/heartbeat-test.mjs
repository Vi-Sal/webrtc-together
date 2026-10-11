// Uses the same Playwright setup as browser-test.mjs.
import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
    const page = await browser.newPage();
    let pings = 0, pongs = 0;
    page.on('websocket', socket => {
        socket.on('framesent', frame => { if (JSON.parse(frame.payload).type === 'ping') pings++; });
        socket.on('framereceived', frame => { if (JSON.parse(frame.payload).type === 'pong') pongs++; });
    });
    await page.goto(process.env.TEST_URL || 'http://localhost:8081');
    await page.clock.install();
    await page.locator('#name').fill('Heartbeat test');
    await page.locator('#room-input').fill(`heartbeat-${Date.now()}`);
    await page.locator('#start-mic').uncheck();
    await page.locator('#start-camera').uncheck();
    await page.locator('#join').click();
    await page.locator('#call').waitFor({ state: 'visible' });
    await page.clock.runFor(25000);
    await page.waitForFunction(() => true);
    // Wait for the actual server reply, independent of the simulated browser clock.
    for (let i = 0; i < 50 && pongs === 0; i++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(pings, 1);
    assert.equal(pongs, 1);
    await page.locator('#leave').click();
    await page.clock.runFor(50000);
    assert.equal(pings, 1, 'Leaving must stop heartbeat traffic');
    console.log('PASS: joined clients exchange heartbeats; leaving clears the timer.');
} finally { await browser.close(); }
