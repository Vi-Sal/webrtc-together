import assert from 'node:assert/strict';
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true });
try {
    for (const mode of ['android', 'iphone', 'blocked']) {
        const page = await browser.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(mode => {
            Object.defineProperty(navigator, 'userAgent', { value: mode === 'iphone'
                ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Version/26.0 Mobile Safari/605.1'
                : 'Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0 Mobile Safari/537.36' });
            Object.defineProperty(navigator, 'userAgentData', { value: mode === 'iphone' ? undefined : {
                platform: 'Android', mobile: true,
                getHighEntropyValues: () => mode === 'blocked' ? new Promise(() => {}) : Promise.resolve({ model: 'SM-S938B' })
            } });
        }, mode);
        const joins = [];
        page.on('websocket', socket => socket.on('framesent', frame => {
            const message = JSON.parse(frame.payload);
            if (message.type === 'join') joins.push(message);
        }));
        await page.goto(process.env.TEST_URL || 'http://localhost:8081');
        await page.locator('#name').fill('Device check');
        await page.locator('#room-input').fill(`device-${mode}-${Date.now()}`);
        await page.locator('#start-mic').uncheck();
        await page.locator('#start-camera').uncheck();
        await page.locator('#join').click();
        await page.locator('#call').waitFor({ state: 'visible', timeout: 5000 });
        assert.equal(joins.length, 1);
        assert.equal(joins[0].device.type, 'Phone');
        assert.equal(joins[0].device.os, mode === 'iphone' ? 'iOS' : 'Android');
        assert.equal(joins[0].device.model, mode === 'android' ? 'SM-S938B'
            : mode === 'iphone' ? 'iPhone (exact model unavailable)' : 'Not provided by browser');
        await page.locator('#leave').click();
        assert.deepEqual(errors, []);
        await page.close();
    }
    console.log('PASS: real join signaling includes optional device hints, including when model lookup never resolves.');
} finally { await browser.close(); }
