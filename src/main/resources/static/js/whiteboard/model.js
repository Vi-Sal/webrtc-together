/**
 * Whiteboard state shared by every participant.
 *
 * The server is the single sequencer: it assigns each accepted change the next `seq`, and every
 * client applies changes in that order, so all boards converge. Local strokes are drawn
 * immediately as "pending" and replaced when the server echoes them back.
 *
 * Undo/redo only target the participant's own operations. Undo hides an element rather than
 * deleting it, so redo restores it at its original stacking position regardless of what others
 * drew meanwhile. Clear removes everything for everyone and resets undo history.
 */
export class BoardModel {
    constructor() {
        this.selfId = null;
        this.seq = 0;
        this.elements = new Map(); // id → element (with `hidden`), in server order
        this.pending = new Map();  // id → element awaiting server confirmation
        this.undoStack = [];
        this.redoStack = [];
    }

    loadSnapshot({ seq = 0, elements = [] } = {}) {
        this.seq = seq;
        this.elements = new Map(elements.map(element => [element.id, { ...element, hidden: !!element.hidden }]));
        for (const id of this.pending.keys()) if (this.elements.has(id)) this.pending.delete(id);
        const exists = id => this.elements.has(id) || this.pending.has(id);
        this.undoStack = this.undoStack.filter(exists);
        this.redoStack = this.redoStack.filter(id => this.elements.get(id)?.hidden);
    }

    /**
     * Applies a server event. Returns { render: 'append' | 'full' | null, element?, gap } — `gap`
     * means an event was missed and the caller should request a fresh snapshot.
     */
    apply(event) {
        if (event.type === 'board-ack') {
            const element = this.pending.get(event.id);
            this.pending.delete(event.id);
            return { render: element ? 'full' : null, gap: false };
        }
        if (typeof event.seq !== 'number') return { render: null, gap: false };
        if (event.seq <= this.seq) return { render: null, gap: false }; // Already applied.
        if (event.seq !== this.seq + 1) return { render: null, gap: true };
        this.seq = event.seq;
        switch (event.type) {
            case 'board-add': {
                const element = { ...event.element, hidden: false };
                this.elements.set(element.id, element);
                const wasPending = this.pending.delete(element.id);
                return { render: wasPending ? 'full' : 'append', element, gap: false };
            }
            case 'board-undo':
            case 'board-redo': {
                const element = this.elements.get(event.id);
                if (element) element.hidden = event.type === 'board-undo';
                return { render: 'full', gap: false };
            }
            case 'board-clear':
                this.elements.clear();
                this.undoStack = this.undoStack.filter(id => this.pending.has(id));
                this.redoStack = [];
                return { render: 'full', gap: false };
            default:
                return { render: null, gap: false };
        }
    }

    addLocal(element) {
        this.pending.set(element.id, element);
        this.undoStack.push(element.id);
        this.redoStack = [];
    }

    /** Pending operations the server has not confirmed (resent after a reconnect). */
    unconfirmed() {
        return [...this.pending.values()];
    }

    dropPending(id) {
        this.pending.delete(id);
        this.undoStack = this.undoStack.filter(other => other !== id);
    }

    canUndo() {
        return this.undoStack.some(id => this.#visibleOwn(id));
    }

    canRedo() {
        return this.redoStack.some(id => this.elements.get(id)?.hidden);
    }

    /** ID of the participant's most recent visible operation to undo, or null. */
    takeUndo() {
        while (this.undoStack.length) {
            // The newest stroke is still on its way to the server; it becomes undoable once confirmed.
            if (this.pending.has(this.undoStack.at(-1))) return null;
            const id = this.undoStack.pop();
            if (this.#visibleOwn(id)) {
                this.redoStack.push(id);
                return id;
            }
        }
        return null;
    }

    takeRedo() {
        while (this.redoStack.length) {
            const id = this.redoStack.pop();
            if (this.elements.get(id)?.hidden) {
                this.undoStack.push(id);
                return id;
            }
        }
        return null;
    }

    visible() {
        return [...this.elements.values()].filter(element => !element.hidden);
    }

    isEmpty() {
        return !this.pending.size && !this.visible().length;
    }

    #visibleOwn(id) {
        const element = this.elements.get(id);
        return !!element && !element.hidden && element.author === this.selfId;
    }
}
