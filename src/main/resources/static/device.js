'use strict';
// Best-effort browser hints, not verified hardware identity. Never delay joining.
window.callDevice = (() => {
    const ua = navigator.userAgent || '';
    const hints = navigator.userAgentData;
    const ipad = /iPad/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const iphone = /iPhone|iPod/i.test(ua);
    const android = /Android/i.test(ua) || hints?.platform === 'Android';
    let os = ipad ? 'iPadOS' : iphone ? 'iOS' : android ? 'Android'
        : /Windows/i.test(ua) ? 'Windows' : /CrOS/i.test(ua) ? 'ChromeOS'
        : /Mac/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : 'Unknown';
    if (os === 'Unknown' && hints?.platform) os = hints.platform;
    const type = ipad ? 'Tablet' : iphone ? 'Phone'
        : android ? (/Mobile/i.test(ua) || hints?.mobile ? 'Phone' : 'Tablet')
        : hints?.mobile ? 'Phone' : os === 'Unknown' ? 'Unknown' : 'Desktop / laptop';
    const browser = /Edg(?:e|A|iOS)?\//i.test(ua) ? 'Edge'
        : /SamsungBrowser\//i.test(ua) ? 'Samsung Internet'
        : /OPR\/|Opera|OPiOS\//i.test(ua) ? 'Opera'
        : /Firefox\/|FxiOS\//i.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\//i.test(ua) ? 'Chrome'
        : /Safari\//i.test(ua) ? 'Safari' : 'Unknown';
    const info = { type, os, browser, model: 'Not provided by browser' };
    if (iphone) info.model = 'iPhone (exact model unavailable)';
    if (ipad) info.model = 'iPad (exact model unavailable)';
    // Older Android browsers sometimes expose a model in their UA. Ignore the
    // reduced Chromium placeholder K and generic values rather than inventing a model.
    const legacyModel = android && ua.match(/Android[^;)]*;\s*(?:[a-z]{2}[-_][A-Z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?\)/)?.[1]?.trim();
    if (legacyModel && !/^(K|Android|Mobile|wv)$/i.test(legacyModel)) info.model = legacyModel;
    if (typeof hints?.getHighEntropyValues === 'function') {
        try {
            Promise.resolve(hints.getHighEntropyValues(['model'])).then(values => {
                const model = typeof values.model === 'string' ? values.model.trim() : '';
                if (model && model !== 'K') info.model = model.slice(0, 100);
            }).catch(() => {}); // Restricted hints must never prevent a call.
        } catch { /* Some embedded browsers throw synchronously. */ }
    }
    return { snapshot: () => ({ ...info }) };
})();
