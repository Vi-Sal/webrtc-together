export function formatDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const seconds = total % 60;
    const mm = String(minutes).padStart(2, '0');
    const ss = String(seconds).padStart(2, '0');
    return hours ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}

export function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function initial(name) {
    const first = [...(name || '?').trim()][0] || '?';
    return first.toLocaleUpperCase();
}

/** Stable palette tone (0–4) for a name, so a person keeps the same avatar everywhere. */
export function toneFor(value) {
    let hash = 0;
    for (const char of value || '') hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return hash % 5;
}

/** Cursor/marker colors that stay legible on the white board in either theme. */
const CURSOR_COLORS = ['#2F6F92', '#243341', '#5E8197', '#3E7C6B', '#8A5A7A', '#B0683A'];
export function cursorColor(value) {
    let hash = 7;
    for (const char of value || '') hash = (hash * 33 + char.codePointAt(0)) >>> 0;
    return CURSOR_COLORS[hash % CURSOR_COLORS.length];
}

export function listNames(names) {
    if (names.length <= 1) return names.join('');
    if (names.length === 2) return `${names[0]} and ${names[1]}`;
    return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
