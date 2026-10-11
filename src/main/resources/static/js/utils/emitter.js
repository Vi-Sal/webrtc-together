/** Minimal synchronous event emitter. */
export class Emitter {
    #listeners = new Map();

    on(type, listener) {
        if (!this.#listeners.has(type)) this.#listeners.set(type, new Set());
        this.#listeners.get(type).add(listener);
        return () => this.#listeners.get(type)?.delete(listener);
    }

    emit(type, ...args) {
        for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(...args);
    }

    removeAll() {
        this.#listeners.clear();
    }
}
