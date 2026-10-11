import { $ } from '../utils/dom.js';
import { generateRoomCode, parseRoomInput } from '../core/room.js';

/** Landing page: start a new meeting or join one by code or invitation link. */
export class Landing {
    constructor({ onEnterRoom }) {
        this.onEnterRoom = onEnterRoom;
        $('start-meeting').addEventListener('click', () => onEnterRoom(generateRoomCode()));
        for (const button of document.querySelectorAll('#landing [data-action="show-join"]')) {
            button.addEventListener('click', () => this.showJoin());
        }
        const input = $('join-code');
        input.addEventListener('input', () => this.#error(''));
        $('join-form').addEventListener('submit', event => {
            event.preventDefault();
            try {
                onEnterRoom(parseRoomInput(input.value, location.origin));
            } catch (error) {
                this.#error(error.message);
                input.focus();
            }
        });
    }

    showJoin() {
        $('join-form').hidden = false;
        for (const button of document.querySelectorAll('#landing [aria-controls="join-form"]')) button.setAttribute('aria-expanded', 'true');
        $('join-code').focus();
    }

    #error(message) {
        $('landing-error').textContent = message;
        $('join-code').setAttribute('aria-invalid', String(!!message));
    }
}
