// Frost Light is the default; the choice persists in localStorage. theme-init.js applies it pre-paint.
const KEY = 'together-theme';
const META_COLORS = { light: '#EDF3F7', dark: '#091626' };
const NAMES = { light: 'Frost Light', dark: 'Midnight Glass' };

export function currentTheme() {
    return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function setTheme(theme) {
    const next = theme === 'dark' ? 'dark' : 'light';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch { /* Not persisted when storage is blocked. */ }
    syncThemeControls();
}

export function toggleTheme() {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
}

export function syncThemeControls() {
    const theme = currentTheme();
    const other = theme === 'dark' ? 'light' : 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', META_COLORS[theme]);
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
        button.setAttribute('aria-label', `Switch to ${NAMES[other]} theme`);
        button.dataset.tooltip = NAMES[other];
    }
    for (const label of document.querySelectorAll('[data-theme-label]')) label.textContent = NAMES[other];
}

export function bindThemeToggles() {
    for (const button of document.querySelectorAll('[data-theme-toggle]')) button.addEventListener('click', toggleTheme);
    syncThemeControls();
}
