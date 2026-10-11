import { $, el, icon } from '../utils/dom.js';
import { initial, toneFor } from '../utils/format.js';

const MAX_TOASTS = 3;

/** Transient notification. `onClick` makes the whole toast an action (for example, open chat). */
export function toast({ title, body = '', error = false, person = null, onClick = null, duration = 4200 }) {
    const container = $('toasts');
    // The same news twice (for example after a peer reconnects) is noise.
    if ([...container.children].some(node => node.dataset.title === title && !node.classList.contains('is-leaving'))) return () => {};
    const tag = onClick ? 'button' : 'div';
    const node = el(tag, { className: `toast glass${error ? ' is-error' : ''}`, attrs: onClick ? { type: 'button' } : {}, dataset: { title } });
    if (person) node.append(el('div', { className: 'avatar avatar-sm', text: initial(person), dataset: { tone: String(toneFor(person)) } }));
    else if (error) node.append(icon('alert'));
    const content = el('div', { className: 'toast-body' }, [el('strong', { text: title })]);
    if (body) content.append(el('span', { text: body }));
    node.append(content);
    const dismiss = () => {
        if (!node.isConnected) return;
        node.classList.add('is-leaving');
        setTimeout(() => node.remove(), 160);
    };
    if (onClick) node.addEventListener('click', () => { onClick(); dismiss(); });
    container.append(node);
    while (container.children.length > MAX_TOASTS) container.firstElementChild.remove();
    setTimeout(dismiss, duration);
    return dismiss;
}

/** Glass confirmation dialog; resolves true only when the user confirms. */
export function confirmAction({ title, body, confirmLabel = 'Confirm' }) {
    const dialog = $('confirm-dialog');
    $('confirm-title').textContent = title;
    $('confirm-body').textContent = body;
    $('confirm-ok').textContent = confirmLabel;
    return new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true });
        dialog.returnValue = 'cancel';
        dialog.showModal();
    });
}

export function showInviteDialog(url) {
    const dialog = $('invite-dialog');
    $('invite-url').value = url;
    dialog.showModal();
    $('invite-url').select();
}
