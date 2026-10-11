export const $ = id => document.getElementById(id);

/** Creates an element. Text is always assigned with textContent, never parsed as HTML. */
export function el(tag, options = {}, children = []) {
    const node = document.createElement(tag);
    const { className, text, attrs, dataset } = options;
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    for (const [name, value] of Object.entries(attrs ?? {})) {
        if (value !== undefined && value !== null && value !== false) node.setAttribute(name, value === true ? '' : value);
    }
    Object.assign(node.dataset, dataset ?? {});
    for (const child of [].concat(children)) if (child) node.append(child);
    return node;
}

const SVG = 'http://www.w3.org/2000/svg';
export function icon(name, className = 'icon') {
    const svg = document.createElementNS(SVG, 'svg');
    svg.setAttribute('class', className);
    svg.setAttribute('aria-hidden', 'true');
    const use = document.createElementNS(SVG, 'use');
    use.setAttribute('href', `#i-${name}`);
    svg.append(use);
    return svg;
}

export function show(node, visible) {
    node.hidden = !visible;
}

export function throttle(fn, wait) {
    let last = 0, timer = null, pendingArgs = null;
    const run = () => { last = performance.now(); timer = null; fn(...pendingArgs); pendingArgs = null; };
    const throttled = (...args) => {
        pendingArgs = args;
        const remaining = wait - (performance.now() - last);
        if (remaining <= 0) { clearTimeout(timer); run(); }
        else if (!timer) timer = setTimeout(run, remaining);
    };
    throttled.flush = () => { if (timer) { clearTimeout(timer); run(); } };
    throttled.cancel = () => { clearTimeout(timer); timer = null; pendingArgs = null; };
    return throttled;
}

export async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}
