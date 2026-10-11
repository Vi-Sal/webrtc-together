// Runs before first paint so a saved theme never flashes the default.
(function () {
    try {
        var saved = localStorage.getItem('together-theme');
        if (saved === 'dark' || saved === 'light') document.documentElement.setAttribute('data-theme', saved);
    } catch (e) { /* Storage can be blocked; Frost Light remains the default. */ }
}());
