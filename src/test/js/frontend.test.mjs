// Unit tests for DOM-free frontend modules. Run: node --test src/test/js/
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateRoomCode, parseRoomInput, inviteUrl, ROOM_PATTERN } from '../../main/resources/static/js/core/room.js';
import { ChatModel, TypingTracker, validateDraft } from '../../main/resources/static/js/core/chat-model.js';
import { BoardModel } from '../../main/resources/static/js/whiteboard/model.js';
import { fitBoard, normalize, quantize, farEnough, toPixels } from '../../main/resources/static/js/whiteboard/geometry.js';
import { bestGrid } from '../../main/resources/static/js/components/tiles.js';

const origin = 'https://together-webrtc.onrender.com';

test('generated room codes are valid, readable and distinct', () => {
    const codes = new Set(Array.from({ length: 500 }, () => generateRoomCode()));
    assert.equal(codes.size, 500);
    for (const code of codes) {
        assert.match(code, /^[a-z]{4}-[a-z]{4}-[a-z]{4}$/);
        assert.ok(ROOM_PATTERN.test(code));
        assert.ok(!/[lo]/.test(code), 'ambiguous letters excluded');
    }
});

test('room input accepts codes and same-origin invitations only', () => {
    assert.equal(parseRoomInput('  team-sync-01 ', origin), 'team-sync-01');
    assert.equal(parseRoomInput(`${origin}/?room=abcd-efgh-ijkm`, origin), 'abcd-efgh-ijkm');
    assert.throws(() => parseRoomInput('', origin), /Enter a meeting code/);
    assert.throws(() => parseRoomInput('short', origin), /8–80/);
    assert.throws(() => parseRoomInput('<script>alert(1)</script>', origin), /8–80/);
    assert.throws(() => parseRoomInput('https://evil.example/?room=abcd-efgh-ijkm', origin), /same server/);
    assert.throws(() => parseRoomInput(`${origin}/?nothing=1`, origin), /no valid meeting code/);
    assert.equal(inviteUrl('abcd-efgh-ijkm', origin), `${origin}/?room=abcd-efgh-ijkm`);
});

test('chat drafts are trimmed and length-limited', () => {
    assert.deepEqual(validateDraft('  \n '), { ok: false, reason: 'empty' });
    assert.deepEqual(validateDraft(' hi '), { ok: true, text: 'hi' });
    assert.equal(validateDraft('é'.repeat(1000)).ok, true);
    assert.deepEqual(validateDraft('x'.repeat(1001)), { ok: false, reason: 'too-long' });
});

test('chat model confirms pending messages and ignores duplicates', () => {
    const chat = new ChatModel();
    chat.selfId = 'me';
    const pending = chat.addPending('c1', 'Hello');
    const message = { id: 'me-c1', from: 'me', name: 'Me', text: 'Hello', ts: 1 };
    assert.deepEqual(chat.receive(message), { added: true, confirmed: pending });
    assert.equal(chat.pending.size, 0);
    assert.deepEqual(chat.receive(message), { added: false, confirmed: null }, 'replayed history is skipped');
    chat.receive({ id: 'you-1', from: 'you', name: 'You', text: 'Hi', ts: 2 }, { countUnread: true });
    chat.receive({ id: 'me-c2', from: 'me', name: 'Me', text: 'Mine', ts: 3 }, { countUnread: true });
    assert.equal(chat.unread, 1, 'own messages never count as unread');
    chat.markRead();
    assert.equal(chat.unread, 0);
});

test('failed chat messages can be retried', () => {
    const chat = new ChatModel();
    chat.selfId = 'me';
    chat.addPending('c9', 'Retry me');
    assert.equal(chat.fail('c9', 'Too fast').status, 'failed');
    assert.equal(chat.sending().length, 0);
    chat.retry('c9');
    assert.equal(chat.sending().length, 1);
});

test('typing indicators expire automatically', () => {
    const typing = new TypingTracker(4000);
    typing.touch('a', 'Alex', 0);
    typing.touch('b', 'Sam', 3000);
    assert.deepEqual(typing.names(1000), ['Alex', 'Sam']);
    assert.deepEqual(typing.names(4500), ['Sam']);
    assert.deepEqual(typing.names(8000), []);
});

const stroke = (id, author) => ({ id, author, kind: 'pen', color: '#243341', size: 4, points: [0.1, 0.1, 0.2, 0.2] });

test('whiteboard applies server events in order and detects gaps', () => {
    const board = new BoardModel();
    board.selfId = 'me';
    assert.equal(board.apply({ type: 'board-add', seq: 1, element: stroke('a', 'you') }).render, 'append');
    assert.equal(board.apply({ type: 'board-add', seq: 1, element: stroke('a', 'you') }).render, null, 'duplicates ignored');
    assert.equal(board.apply({ type: 'board-add', seq: 3, element: stroke('c', 'you') }).gap, true, 'missing seq 2');
    assert.equal(board.visible().length, 1);
});

test('two clients converge regardless of local optimistic order', () => {
    const alice = new BoardModel(); alice.selfId = 'alice';
    const bob = new BoardModel(); bob.selfId = 'bob';
    alice.addLocal(stroke('a1', 'alice'));
    bob.addLocal(stroke('b1', 'bob'));
    // The server sequences Bob's stroke first; both receive the same order.
    const events = [
        { type: 'board-add', seq: 1, element: stroke('b1', 'bob') },
        { type: 'board-add', seq: 2, element: stroke('a1', 'alice') }
    ];
    for (const event of events) { alice.apply(event); bob.apply(event); }
    assert.deepEqual(alice.visible().map(e => e.id), ['b1', 'a1']);
    assert.deepEqual(bob.visible().map(e => e.id), ['b1', 'a1']);
    assert.equal(alice.pending.size + bob.pending.size, 0);
});

test('undo and redo only take your own confirmed operations', () => {
    const board = new BoardModel();
    board.selfId = 'me';
    board.addLocal(stroke('mine', 'me'));
    assert.equal(board.takeUndo(), null, 'unconfirmed work cannot be undone yet');
    board.apply({ type: 'board-add', seq: 1, element: stroke('mine', 'me') });
    board.apply({ type: 'board-add', seq: 2, element: stroke('theirs', 'you') });
    assert.ok(board.canUndo());
    assert.equal(board.takeUndo(), 'mine');
    board.apply({ type: 'board-undo', seq: 3, id: 'mine' });
    assert.deepEqual(board.visible().map(e => e.id), ['theirs']);
    assert.equal(board.takeUndo(), null, "other participants' work is never undone");
    assert.equal(board.takeRedo(), 'mine');
    board.apply({ type: 'board-redo', seq: 4, id: 'mine' });
    assert.deepEqual(board.visible().map(e => e.id), ['mine', 'theirs'], 'redo restores the original stacking order');
});

test('snapshots replace state, keep unsent work and clear resets history', () => {
    const board = new BoardModel();
    board.selfId = 'me';
    board.addLocal(stroke('offline', 'me'));
    board.loadSnapshot({ seq: 5, elements: [{ ...stroke('x', 'you'), hidden: true }, stroke('y', 'you')] });
    assert.equal(board.seq, 5);
    assert.deepEqual(board.visible().map(e => e.id), ['y']);
    assert.deepEqual(board.unconfirmed().map(e => e.id), ['offline'], 'resent after reconnect');
    board.apply({ type: 'board-clear', seq: 6 });
    assert.equal(board.visible().length, 0);
    assert.equal(board.canRedo(), false);
});

test('coordinates are normalized, quantized and resolution independent', () => {
    const rect = { left: 100, top: 50, width: 800, height: 450 };
    assert.deepEqual(normalize(500, 275, rect), [0.5, 0.5]);
    assert.deepEqual(normalize(-20, 900, rect), [0, 1], 'clamped to the board');
    assert.equal(quantize(0.123456789), 0.1235);
    assert.deepEqual(toPixels([0.5, 0.5], 1600, 900), [800, 450]);
    assert.deepEqual(toPixels([0.5, 0.5], 390, 219.375), [195, 109.6875]);
    assert.deepEqual(fitBoard(1600, 1600), { width: 1600, height: 900 });
    assert.deepEqual(fitBoard(1600, 450), { width: 800, height: 450 });
    assert.equal(farEnough([0.5, 0.5], 0.5001, 0.5), false);
    assert.equal(farEnough([0.5, 0.5], 0.51, 0.5), true);
});

test('video grid uses the space well on desktop and phones', () => {
    assert.equal(bestGrid(1, 1200, 700).cols, 1);
    assert.equal(bestGrid(2, 1200, 700).cols, 2);
    assert.equal(bestGrid(4, 1200, 700).cols, 2);
    assert.equal(bestGrid(6, 1200, 700).cols, 3);
    assert.equal(bestGrid(2, 380, 640).cols, 1, 'portrait phones stack two people');
    const wide = bestGrid(2, 1400, 720);
    assert.ok(wide.tileW / wide.tileH >= 4 / 3 - 1e-9, 'landscape tiles are never cropped narrower than 4:3');
});
