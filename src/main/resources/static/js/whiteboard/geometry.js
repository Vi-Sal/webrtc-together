// Resolution-independent board coordinates: x and y are 0–1 fractions of a 16:9 board, and
// sizes are thousandths of the board width. Every screen and pixel ratio draws the same result.
export const BOARD_ASPECT = 16 / 9;
export const MAX_STROKE_VALUES = 4000; // x,y numbers per committed stroke (server limit)
export const MAX_LIVE_VALUES = 800;

export function quantize(value) {
    return Math.round(Math.min(1, Math.max(0, value)) * 10000) / 10000;
}

/** Pointer position → normalized board point, clamped to the board. */
export function normalize(clientX, clientY, rect) {
    return [quantize((clientX - rect.left) / rect.width), quantize((clientY - rect.top) / rect.height)];
}

export function toPixels(points, width, height) {
    const pixels = new Array(points.length);
    for (let i = 0; i < points.length; i += 2) {
        pixels[i] = points[i] * width;
        pixels[i + 1] = points[i + 1] * height;
    }
    return pixels;
}

/** Largest 16:9 box that fits the available area. */
export function fitBoard(width, height, aspect = BOARD_ASPECT) {
    if (width <= 0 || height <= 0) return { width: 0, height: 0 };
    return width / height > aspect
        ? { width: Math.floor(height * aspect), height: Math.floor(height) }
        : { width: Math.floor(width), height: Math.floor(width / aspect) };
}

/** Whether a new point is far enough from the previous one to be worth sending. */
export function farEnough(points, x, y, minDistance = 0.0012) {
    if (points.length < 2) return true;
    const dx = x - points[points.length - 2];
    const dy = y - points[points.length - 1];
    return dx * dx + dy * dy >= minDistance * minDistance;
}

/** Text font size (board units) derived from the brush size. */
export function textSize(brush) {
    return Math.min(96, Math.max(14, Math.round(12 + brush * 2.5)));
}
