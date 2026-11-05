// The board is the shared infinite canvas: every image (and later drawings and notes)
// lives here, in "world" coordinates. Cameras only decide how it is shown.
//
// Keeping the board separate from the cameras is what will let several split panes
// show the same board at once in step 2.

import { Container, Sprite, Texture, ImageSource, Graphics } from '../vendor/pixi.min.mjs';

let nextId = 1;

export class Board {
  constructor() {
    this.world = new Container();       // everything on the board
    this.imageLayer = new Container();  // the images, back to front
    this.overlay = new Graphics();      // selection outline, drawn on top
    this.world.addChild(this.imageLayer, this.overlay);

    this.items = [];       // one entry per image, back to front
    this.selected = null;  // the image that is currently selected, if any
  }

  // Put a decoded image on the board, centred on (x, y).
  // `blob` is the original image file; we keep it so the board can be saved.
  addImage(bitmap, x, y, { name = '', sourceUrl = '', blob = null, id, scaleX = 1, scaleY = 1, rotation = 0, alpha = 1 } = {}) {
    // Mipmaps are smaller pre-shrunk copies of the image. They keep big photos
    // looking smooth (not sparkly or jagged) when you zoom far out.
    const source = new ImageSource({ resource: bitmap, autoGenerateMipmaps: true });
    const sprite = new Sprite(new Texture({ source }));
    sprite.anchor.set(0.5);  // position, scale and rotation all work from the centre
    sprite.position.set(x, y);
    sprite.scale.set(scaleX, scaleY);
    sprite.rotation = rotation;
    sprite.alpha = alpha;
    this.imageLayer.addChild(sprite);

    if (id === undefined) id = nextId++;
    else nextId = Math.max(nextId, id + 1);

    const item = {
      id,
      sprite,
      width: bitmap.width,   // original pixel size of the image
      height: bitmap.height,
      name,
      sourceUrl,             // where the image came from, when we know it
      blob,
    };
    this.items.push(item);
    return item;
  }

  // Remove everything (used for "New board" and before opening a file).
  clear() {
    for (const item of [...this.items]) this.remove(item);
    this.selected = null;
  }

  // Where each image is and how it's placed, for saving. Images are saved separately.
  toJSON() {
    return this.items.map((item) => {
      const s = item.sprite;
      return {
        id: item.id,
        name: item.name,
        sourceUrl: item.sourceUrl,
        x: s.x, y: s.y,
        scaleX: s.scale.x, scaleY: s.scale.y,
        rotation: s.rotation,
        alpha: s.alpha,
      };
    });
  }

  remove(item) {
    const i = this.items.indexOf(item);
    if (i === -1) return;
    this.items.splice(i, 1);
    if (this.selected === item) this.selected = null;
    // Also free the image from graphics memory.
    item.sprite.destroy({ texture: true, textureSource: true });
  }

  // Draw the image above all the others.
  bringToFront(item) {
    const i = this.items.indexOf(item);
    if (i === -1 || i === this.items.length - 1) return;
    this.items.splice(i, 1);
    this.items.push(item);
    this.imageLayer.setChildIndex(item.sprite, this.imageLayer.children.length - 1);
  }

  // Which image is at this board position? Checks the top image first.
  // Written to also work once images can be rotated, scaled and flipped.
  hitTest(wx, wy) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const item = this.items[i];
      const s = item.sprite;
      // Undo the image's position, rotation and scale to get a point inside the image.
      const dx = wx - s.x;
      const dy = wy - s.y;
      const cos = Math.cos(-s.rotation);
      const sin = Math.sin(-s.rotation);
      const lx = (dx * cos - dy * sin) / s.scale.x;
      const ly = (dx * sin + dy * cos) / s.scale.y;
      if (Math.abs(lx) <= item.width / 2 && Math.abs(ly) <= item.height / 2) return item;
    }
    return null;
  }

  // The four corners of an image on the board, after rotation and scale.
  corners(item) {
    const s = item.sprite;
    const hw = (item.width / 2) * s.scale.x;
    const hh = (item.height / 2) * s.scale.y;
    const cos = Math.cos(s.rotation);
    const sin = Math.sin(s.rotation);
    return [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => ({
      x: s.x + x * cos - y * sin,
      y: s.y + x * sin + y * cos,
    }));
  }

  // A rectangle around the given images (all of them by default).
  bounds(items = this.items) {
    if (items.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const item of items) {
      for (const p of this.corners(item)) {
        minX = Math.min(minX, p.x); minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y);
      }
    }
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  // Redraw the blue outline around the selected image.
  // The line width is divided by zoom so it always looks 2 pixels thick on screen.
  drawOverlay(zoom) {
    this.overlay.clear();
    if (!this.selected) return;
    const pts = this.corners(this.selected).flatMap((p) => [p.x, p.y]);
    this.overlay.poly(pts).stroke({ width: 2 / zoom, color: 0x4da3ff, alignment: 0 });
  }
}
