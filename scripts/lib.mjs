// Shared Playwright helpers for the browser suites. Test tooling only, never deployed.
// Run with PLAYWRIGHT_MODULE=/abs/path/to/playwright/index.mjs; see README.md.
export const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
export const base = process.env.TEST_URL || 'http://localhost:8081';

export const MEDIA_ARGS = ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--auto-select-desktop-capture-source=Entire screen', '--enable-usermedia-screen-capturing',
    '--allow-http-screen-capture', '--autoplay-policy=no-user-gesture-required'];

export function launch(args = MEDIA_ARGS) {
    return chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args });
}

/** Records peer connections, sockets and captured streams so tests can inspect real state. */
export function instrument() {
    window.testConnections = [];
    window.testSockets = [];
    window.testStreams = [];
    const PC = window.RTCPeerConnection;
    window.RTCPeerConnection = class extends PC {
        constructor(config) { super(config); window.testConnections.push(this); }
    };
    const WS = window.WebSocket;
    window.WebSocket = class extends WS {
        constructor(...args) { super(...args); window.testSockets.push(this); }
    };
    const original = navigator.mediaDevices?.getUserMedia?.bind(navigator.mediaDevices);
    if (original) {
        navigator.mediaDevices.getUserMedia = async options => {
            const stream = await original(options);
            window.testStreams.push(stream);
            return stream;
        };
    }
}

export function track(page, errors, label) {
    page.on('pageerror', error => errors.push(`${label}: ${error.message}`));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${label}: ${message.text()}`); });
    return page;
}

/** Opens an invitation link and joins from the lobby. */
export async function join(context, room, name, { errors = [], mic = true, camera = true } = {}) {
    const page = track(await context.newPage(), errors, name);
    await page.goto(`${base}/?room=${room}`);
    await page.locator('#lobby').waitFor();
    if (!mic) await page.locator('#lobby-mic').click();
    if (!camera) await page.locator('#lobby-camera').click();
    await page.locator('#display-name').fill(name);
    await page.locator('#join-button').click();
    await page.locator('#meeting').waitFor({ state: 'visible', timeout: 15000 });
    return page;
}

export const liveConnections = page => page.evaluate(() => window.testConnections.filter(pc => pc.connectionState === 'connected').length);

export async function waitForPeers(page, count) {
    await page.waitForFunction(n => window.testConnections.filter(pc => pc.connectionState === 'connected').length === n
        && [...document.querySelectorAll('#people video')].filter(video => video.videoWidth > 0).length === n + 1, count, { timeout: 20000 });
}

export function tileOf(page, name) {
    return page.locator('#people .tile', { hasText: name });
}

export const roomCode = prefix => `${prefix}-${Date.now().toString(36)}`;
