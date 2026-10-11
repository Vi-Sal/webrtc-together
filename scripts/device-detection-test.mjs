import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = await readFile(new URL('../src/main/resources/static/device.js', import.meta.url), 'utf8');
function detect(navigator) {
    const context = { navigator, window: {} };
    vm.runInNewContext(source, context);
    return context.window.callDevice;
}
for (const [ua, os, type, browser] of [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0 Safari/537.36', 'Windows', 'Desktop / laptop', 'Chrome'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1', 'macOS', 'Desktop / laptop', 'Safari'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) Version/26.0 Mobile Safari/605.1', 'iOS', 'Phone', 'Safari'],
    ['Mozilla/5.0 (Linux; Android 10; K) Chrome/140.0 Mobile Safari/537.36', 'Android', 'Phone', 'Chrome'],
    ['Mozilla/5.0 (Linux; Android 14; SM-X710 Build/UP1A) SamsungBrowser/27.0 Chrome/125.0 Safari/537.36', 'Android', 'Tablet', 'Samsung Internet'],
    ['Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36 Edg/140.0', 'Windows', 'Desktop / laptop', 'Edge'],
    ['Mozilla/5.0 (X11; Linux x86_64) Gecko/20100101 Firefox/140.0', 'Linux', 'Desktop / laptop', 'Firefox'],
    ['', 'Unknown', 'Unknown', 'Unknown']
]) {
    const d = detect({ userAgent: ua }).snapshot();
    assert.equal(d.os, os); assert.equal(d.type, type); assert.equal(d.browser, browser);
}
const iphone = detect({ userAgent: 'iPhone Safari/605.1' }).snapshot();
assert.equal(iphone.model, 'iPhone (exact model unavailable)');
const ipad = detect({ userAgent: 'Macintosh Safari/605.1', platform: 'MacIntel', maxTouchPoints: 5 }).snapshot();
assert.equal(ipad.os, 'iPadOS'); assert.equal(ipad.type, 'Tablet');
assert.equal(detect({ userAgent: 'Android 10; K) Mobile Chrome/140.0' }).snapshot().model, 'Not provided by browser');
assert.equal(detect({ userAgent: 'Android 14; SM-S938B Build/ABC) Mobile Chrome/140.0' }).snapshot().model, 'SM-S938B');
const withHints = detect({ userAgent: 'Android 10; K) Mobile Chrome/140.0', userAgentData: {
    platform: 'Android', mobile: true, getHighEntropyValues: async () => ({ model: 'SM-S938B' })
} });
await new Promise(resolve => setImmediate(resolve));
assert.equal(withHints.snapshot().model, 'SM-S938B');
for (const getHighEntropyValues of [() => new Promise(() => {}), () => Promise.reject(new Error('denied')), () => { throw new Error('unsupported'); }]) {
    const d = detect({ userAgent: 'Android 10; K) Mobile', userAgentData: { getHighEntropyValues } });
    assert.equal(d.snapshot().os, 'Android'); // Snapshot returns immediately even if hints never resolve.
}
await new Promise(resolve => setImmediate(resolve));
console.log('PASS: desktop, phone, tablet, browser, optional model hints, and unavailable/blocked hints.');
