import { toPixels } from './geometry.js';

const TEXT_FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, Arial, sans-serif';

/** Draws one element in pixel space. The eraser cuts through ink to the paper beneath. */
export function drawElement(ctx, element, width, height) {
    const unit = width / 1000;
    const points = toPixels(element.points, width, height);
    ctx.save();
    ctx.globalCompositeOperation = element.kind === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = ctx.fillStyle = element.kind === 'eraser' ? '#000000' : element.color;
    ctx.lineWidth = Math.max(0.75, element.size * unit);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    switch (element.kind) {
        case 'pen':
        case 'eraser':
            drawStroke(ctx, points);
            break;
        case 'line':
            ctx.beginPath();
            ctx.moveTo(points[0], points[1]);
            ctx.lineTo(points[2], points[3]);
            ctx.stroke();
            break;
        case 'rect': {
            const x = Math.min(points[0], points[2]), y = Math.min(points[1], points[3]);
            ctx.beginPath();
            ctx.roundRect ? ctx.roundRect(x, y, Math.abs(points[2] - points[0]), Math.abs(points[3] - points[1]), 2 * unit)
                : ctx.rect(x, y, Math.abs(points[2] - points[0]), Math.abs(points[3] - points[1]));
            ctx.stroke();
            break;
        }
        case 'ellipse': {
            const rx = Math.abs(points[2] - points[0]) / 2, ry = Math.abs(points[3] - points[1]) / 2;
            ctx.beginPath();
            ctx.ellipse(Math.min(points[0], points[2]) + rx, Math.min(points[1], points[3]) + ry, Math.max(rx, 0.5), Math.max(ry, 0.5), 0, 0, Math.PI * 2);
            ctx.stroke();
            break;
        }
        case 'text':
            ctx.font = `560 ${element.size * unit}px ${TEXT_FONT}`;
            ctx.textBaseline = 'top';
            ctx.fillText(element.text ?? '', points[0], points[1]);
            break;
    }
    ctx.restore();
}

/** Smooth freehand path through midpoints; a single point becomes a dot. */
function drawStroke(ctx, points) {
    if (points.length < 4) {
        ctx.beginPath();
        ctx.arc(points[0], points[1], ctx.lineWidth / 2, 0, Math.PI * 2);
        ctx.fill();
        return;
    }
    ctx.beginPath();
    ctx.moveTo(points[0], points[1]);
    for (let i = 2; i < points.length - 2; i += 2) {
        const midX = (points[i] + points[i + 2]) / 2, midY = (points[i + 1] + points[i + 3]) / 2;
        ctx.quadraticCurveTo(points[i], points[i + 1], midX, midY);
    }
    ctx.lineTo(points[points.length - 2], points[points.length - 1]);
    ctx.stroke();
}

/**
 * Two layers: a cached canvas of confirmed elements (redrawn only on undo/clear/resize) and the
 * visible canvas, which composites that cache with pending and in-progress strokes per frame.
 */
export class BoardRenderer {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.base = document.createElement('canvas');
        this.baseCtx = this.base.getContext('2d');
        this.width = 0;
        this.height = 0;
        this.dpr = 1;
    }

    resize(width, height, dpr) {
        this.width = width;
        this.height = height;
        this.dpr = dpr;
        for (const canvas of [this.canvas, this.base]) {
            canvas.width = Math.max(1, Math.round(width * dpr));
            canvas.height = Math.max(1, Math.round(height * dpr));
        }
    }

    rebuild(elements) {
        const ctx = this.baseCtx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.base.width, this.base.height);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (const element of elements) drawElement(ctx, element, this.width, this.height);
    }

    append(element) {
        drawElement(this.baseCtx, element, this.width, this.height);
    }

    compose(overlays) {
        const ctx = this.ctx;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.base, 0, 0);
        ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
        for (const element of overlays) if (element.points.length >= 2) drawElement(ctx, element, this.width, this.height);
    }
}

/** Renders the board at a fixed resolution on paper, for PNG export. */
export function renderExport(elements, width = 2560, height = 1440, paper = '#FFFFFF') {
    const ink = document.createElement('canvas');
    ink.width = width;
    ink.height = height;
    const inkCtx = ink.getContext('2d');
    for (const element of elements) drawElement(inkCtx, element, width, height);
    const out = document.createElement('canvas');
    out.width = width;
    out.height = height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = paper;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(ink, 0, 0);
    return out;
}
