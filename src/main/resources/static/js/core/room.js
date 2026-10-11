// Room codes and invitation links. Compatible with existing `/?room=CODE` invitations.
export const ROOM_PATTERN = /^[a-zA-Z0-9_-]{8,80}$/;
const CODE_ALPHABET = 'abcdefghijkmnpqrstuvwxyz'; // 24 letters without l/o: easy to read aloud.

/** A new unguessable meeting code such as `kmrt-vhqa-bzne` (55 bits of entropy). */
export function generateRoomCode(random = globalThis.crypto) {
    const chars = [];
    while (chars.length < 12) {
        for (const byte of random.getRandomValues(new Uint8Array(16))) {
            // 240 is the largest multiple of 24 below 256: rejecting the rest keeps letters uniform.
            if (byte < 240 && chars.length < 12) chars.push(CODE_ALPHABET[byte % 24]);
        }
    }
    return `${chars.slice(0, 4).join('')}-${chars.slice(4, 8).join('')}-${chars.slice(8).join('')}`;
}

/** Accepts a room code or a full invitation link from this same server. */
export function parseRoomInput(raw, origin) {
    const value = (raw ?? '').trim();
    if (!value) throw new Error('Enter a meeting code or paste an invitation link.');
    if (/^https?:\/\//i.test(value)) {
        let link;
        try { link = new URL(value); } catch { throw new Error('That invitation link is not valid.'); }
        if (link.origin !== origin) {
            throw new Error(`This invitation is for ${link.origin}. Open that link directly — everyone must use the same server.`);
        }
        const room = link.searchParams.get('room') ?? '';
        if (!ROOM_PATTERN.test(room)) throw new Error('That link has no valid meeting code. Ask for a new invitation.');
        return room;
    }
    if (!ROOM_PATTERN.test(value)) {
        throw new Error('Meeting codes are 8–80 letters, numbers, dashes or underscores.');
    }
    return value;
}

export function roomFromLocation(location) {
    const room = new URL(location.href).searchParams.get('room') ?? '';
    return ROOM_PATTERN.test(room) ? room : null;
}

export function inviteUrl(room, origin) {
    const url = new URL('/', origin);
    url.searchParams.set('room', room);
    return url.href;
}
