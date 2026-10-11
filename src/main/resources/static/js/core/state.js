/**
 * Tiny observable store for UI state. Views (video/board), panels and the theme live here, kept
 * separate from media and peer connections so UI changes never touch WebRTC.
 */
export function createStore(initial) {
    let state = { ...initial };
    const subscribers = new Set();
    return {
        get: () => state,
        set(patch) {
            const previous = state;
            state = { ...state, ...patch };
            if (Object.keys(patch).some(key => previous[key] !== state[key])) {
                for (const subscriber of [...subscribers]) subscriber(state, previous);
            }
        },
        subscribe(subscriber) {
            subscribers.add(subscriber);
            return () => subscribers.delete(subscriber);
        }
    };
}
