const URL_SAFE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpredictable URL-safe identifier (64-symbol alphabet, so no modulo bias). */
export function randomId(length = 16, random = globalThis.crypto) {
    const bytes = random.getRandomValues(new Uint8Array(length));
    let id = '';
    for (const byte of bytes) id += URL_SAFE[byte & 63];
    return id;
}
