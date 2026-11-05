// A camera is one "view" onto the board: where it is looking and how far it is zoomed in.
//
// Right now there is one camera for the whole window. In step 2 every split pane
// will get its own camera, all looking at the same board.
//
// The maths in one line:  screen position = world position * zoom + offset

export const MIN_ZOOM = 0.01;
export const MAX_ZOOM = 64;

export class Camera {
  constructor() {
    this.x = 0;     // screen offset, in pixels
    this.y = 0;
    this.zoom = 1;  // 1 = 100%, 2 = 200%, ...
  }

  // Convert a point on screen (e.g. the mouse) to a point on the board.
  toWorld(sx, sy) {
    return { x: (sx - this.x) / this.zoom, y: (sy - this.y) / this.zoom };
  }

  // Move the view by a number of screen pixels (used when dragging to pan).
  panBy(dx, dy) {
    this.x += dx;
    this.y += dy;
  }

  // Zoom in or out while keeping the point under the mouse in the same place.
  // That is what makes zooming feel like you are diving into the spot you point at.
  zoomAt(sx, sy, factor) {
    const before = this.toWorld(sx, sy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, this.zoom * factor));
    this.x = sx - before.x * this.zoom;
    this.y = sy - before.y * this.zoom;
  }

  // Zoom and move so a rectangle of the board fills the view (with a margin).
  frame(bounds, viewWidth, viewHeight, margin = 40) {
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const zx = (viewWidth - margin * 2) / bounds.width;
    const zy = (viewHeight - margin * 2) / bounds.height;
    this.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(zx, zy)));
    const cx = bounds.x + bounds.width / 2;
    const cy = bounds.y + bounds.height / 2;
    this.x = viewWidth / 2 - cx * this.zoom;
    this.y = viewHeight / 2 - cy * this.zoom;
  }

  // Push this camera's position onto a PixiJS container so it draws from this view.
  applyTo(container) {
    container.position.set(this.x, this.y);
    container.scale.set(this.zoom);
  }
}
