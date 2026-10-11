import { $ } from './utils/dom.js';
import { bindThemeToggles } from './core/theme.js';
import { roomFromLocation } from './core/room.js';
import { Landing } from './components/landing.js';
import { Lobby } from './components/lobby.js';
import { Meeting } from './components/meeting.js';

const screens = ['landing', 'lobby', 'meeting'];
let meeting = null;

function showScreen(name, room = null) {
    for (const screen of screens) $(screen).hidden = screen !== name;
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    if (room) url.searchParams.set('room', room);
    if (url.href !== location.href) history.replaceState(null, '', url);
    document.title = name === 'meeting' ? `${room} · Together` : name === 'lobby' ? 'Join meeting · Together' : 'Together · Meet. Talk. Create.';
    window.scrollTo(0, 0);
}

const lobby = new Lobby({
    onBack() {
        lobby.exit();
        showScreen('landing');
    },
    async onJoin({ room, name, media, iceConfig }) {
        const session = new Meeting({
            room, name, media, iceConfig,
            onExit({ message, error }) {
                if (meeting === session) meeting = null;
                if (!message) return; // Page is unloading.
                showScreen('lobby', room);
                lobby.enter(room, { message, error });
            }
        });
        meeting = session;
        try {
            await session.start();
        } catch (error) {
            meeting = null;
            showScreen('lobby', room);
            lobby.enter(room, { message: error.message, error: true });
            return;
        }
        showScreen('meeting', room);
    }
});

new Landing({
    onEnterRoom(room) {
        showScreen('lobby', room);
        lobby.enter(room, { autoPreview: true });
    }
});

bindThemeToggles();

// Invitation links open the lobby directly; devices start only after the user acts.
const invited = roomFromLocation(location);
if (invited) {
    showScreen('lobby', invited);
    lobby.enter(invited);
} else {
    showScreen('landing');
}
