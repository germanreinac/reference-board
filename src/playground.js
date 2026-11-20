// Playground: a play mat and a box of toys, in 3D.
//
// Not a 3D editor. A carpet with roads on it, and simple toys to put on top: blocks,
// cardboard-box buildings, cars, trees, peg people, letter blocks. Pick a toy and it
// plops onto the mat; drag it around (toys stack on each other), turn it, resize it,
// give it a colour. Drag the empty floor to look around. "Put on board" adds a picture
// of what you see to the board. Each board keeps its own playground (in this browser).
//
// openPlayground({ boardId, addImage(blob, name), toast(message) })

import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

// Primary colours, leaning on Melti's own pink and blue.
const COLOURS = ['#ff3fa9', '#3d7bff', '#ffd23f', '#ff5a4f', '#3ecf8e', '#ff9a3d', '#f6f3ff', '#24222e'];
const ROAD = '#3b3850', LINE = '#f6f3ff';
const MAT_W = 18, MAT_D = 12;   // the carpet, in toy units (a block is 1)

const KEY = (boardId) => `refboard.playground.${boardId}`;

// ---------- The carpet ----------

function carpetTexture(style) {
  const c = document.createElement('canvas');
  c.width = 1800; c.height = 1200;
  const g = c.getContext('2d');
  const u = 100;   // pixels per toy unit
  if (style === 'plain') {
    g.fillStyle = '#3ecf8e'; g.fillRect(0, 0, c.width, c.height);
  } else if (style === 'grid') {
    for (let y = 0; y < 12; y++) for (let x = 0; x < 18; x++) { g.fillStyle = (x + y) % 2 ? '#f6f3ff' : '#ffd0ea'; g.fillRect(x * u, y * u, u, u); }
  } else {
    // A little town: grass, a ring road with a crossroads, a pond, a car park, building plots.
    g.fillStyle = '#58d6a0'; g.fillRect(0, 0, c.width, c.height);
    const road = (draw) => { g.strokeStyle = ROAD; g.lineWidth = 150; g.lineCap = 'round'; g.lineJoin = 'round'; g.setLineDash([]); g.beginPath(); draw(); g.stroke(); };
    const dashes = (draw) => { g.strokeStyle = LINE; g.lineWidth = 8; g.setLineDash([46, 40]); g.beginPath(); draw(); g.stroke(); g.setLineDash([]); };
    const ring = () => { g.roundRect(170, 170, c.width - 340, c.height - 340, 220); };
    const cross = () => { g.moveTo(900, 170); g.lineTo(900, 1030); g.moveTo(170, 600); g.lineTo(1630, 600); };
    road(ring); road(cross);
    dashes(ring); dashes(cross);
    // The roundabout in the middle.
    g.fillStyle = ROAD; g.beginPath(); g.arc(900, 600, 170, 0, 7); g.fill();
    g.fillStyle = '#ff3fa9'; g.beginPath(); g.arc(900, 600, 78, 0, 7); g.fill();
    g.strokeStyle = LINE; g.lineWidth = 8; g.beginPath(); g.arc(900, 600, 124, 0, 7); g.setLineDash([40, 34]); g.stroke(); g.setLineDash([]);
    // Zebra crossings.
    g.fillStyle = LINE;
    for (const [x, y, vertical] of [[520, 600, true], [1280, 600, true], [900, 330, false], [900, 870, false]]) {
      for (let i = -3; i <= 3; i++) vertical ? g.fillRect(x - 12, y + i * 20 - 6, 60, 12) : g.fillRect(x + i * 20 - 6, y - 12, 12, 60);
    }
    // A pond, a car park and plots to build on.
    g.fillStyle = '#3d7bff'; g.beginPath(); g.ellipse(520, 370, 150, 92, -0.2, 0, 7); g.fill();
    g.fillStyle = '#8fb6ff'; g.beginPath(); g.ellipse(490, 350, 60, 26, -0.2, 0, 7); g.fill();
    g.fillStyle = '#4a4763'; g.beginPath(); g.roundRect(1040, 690, 440, 230, 26); g.fill();
    g.strokeStyle = LINE; g.lineWidth = 6;
    for (let i = 1; i < 6; i++) { g.beginPath(); g.moveTo(1040 + i * 73, 700); g.lineTo(1040 + i * 73, 790); g.moveTo(1040 + i * 73, 820); g.lineTo(1040 + i * 73, 910); g.stroke(); }
    for (const [x, y, w, h, col] of [[1050, 290, 180, 180, '#ffd23f'], [1280, 290, 200, 180, '#ff9a3d'], [330, 700, 200, 200, '#ffd0ea'], [590, 700, 170, 200, '#ffd23f']]) {
      g.fillStyle = col; g.globalAlpha = 0.55; g.beginPath(); g.roundRect(x, y, w, h, 22); g.fill(); g.globalAlpha = 1;
    }
    // A stitched border, like a real play mat.
    g.strokeStyle = '#2f9f73'; g.lineWidth = 10; g.setLineDash([26, 20]); g.strokeRect(34, 34, c.width - 68, c.height - 68); g.setLineDash([]);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ---------- The toys ----------
// Every toy is a group standing on y = 0, with one main material (toy.userData.paint)
// that takes its colour.

const lambert = (color) => new THREE.MeshLambertMaterial({ color });
const part = (geo, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };
const wheelMat = lambert('#24222e'), hubMat = lambert('#f6f3ff'), skin = lambert('#ffe0c2'), trunk = lambert('#a86b3c'), glass = lambert('#bfe3ff'), roof = lambert('#ff5a4f');

function wheels(g, xs, z, r = 0.2) {
  const geo = new THREE.CylinderGeometry(r, r, 0.14, 18);
  for (const x of xs) for (const s of [-1, 1]) {
    const w = part(geo, wheelMat, x, r, s * z);
    w.rotation.x = Math.PI / 2;
    g.add(w, part(new THREE.CylinderGeometry(r * 0.45, r * 0.45, 0.16, 12), hubMat, x, r, s * z).rotateX(Math.PI / 2));
  }
}
function windowTexture() {
  const c = document.createElement('canvas'); c.width = 128; c.height = 192;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 192);
  g.fillStyle = 'rgba(40,36,60,0.55)';
  for (let y = 0; y < 3; y++) for (let x = 0; x < 2; x++) g.fillRect(20 + x * 52, 22 + y * 56, 36, 38);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}
function letterTexture(ch) {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(40,36,60,0.35)'; g.lineWidth = 8; g.strokeRect(8, 8, 112, 112);
  g.fillStyle = 'rgba(30,26,50,0.85)'; g.font = '700 86px Fredoka, system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(ch, 64, 70);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; return t;
}

const TOYS = {
  block: { label: 'Block', colour: '#ff3fa9', make: (m) => [part(new THREE.BoxGeometry(1, 1, 1), m, 0, 0.5, 0)] },
  brick: { label: 'Brick', colour: '#3d7bff', make: (m) => [part(new THREE.BoxGeometry(2, 0.6, 1), m, 0, 0.3, 0)] },
  box: { label: 'Box building', colour: '#ff9a3d', make: (m) => { m.map = windowTexture(); return [part(new THREE.BoxGeometry(1.6, 2.4, 1.6), m, 0, 1.2, 0)]; } },
  tube: { label: 'Tube', colour: '#ffd23f', make: (m) => [part(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 28), m, 0, 0.6, 0)] },
  cone: { label: 'Cone', colour: '#ff5a4f', make: (m) => [part(new THREE.ConeGeometry(0.55, 1.2, 28), m, 0, 0.6, 0)] },
  ball: { label: 'Ball', colour: '#3ecf8e', make: (m) => [part(new THREE.SphereGeometry(0.5, 28, 18), m, 0, 0.5, 0)] },
  arch: { label: 'Arch', colour: '#3d7bff', make: (m) => [part(new THREE.BoxGeometry(0.4, 1.3, 0.8), m, -0.8, 0.65, 0), part(new THREE.BoxGeometry(0.4, 1.3, 0.8), m, 0.8, 0.65, 0), part(new THREE.BoxGeometry(2, 0.4, 0.8), m, 0, 1.5, 0)] },
  ramp: { label: 'Ramp', colour: '#ffd23f', make: (m) => {
    const s = new THREE.Shape(); s.moveTo(-1, 0); s.lineTo(1, 0); s.lineTo(1, 0.8); s.closePath();
    const geo = new THREE.ExtrudeGeometry(s, { depth: 1, bevelEnabled: false }); geo.translate(0, 0, -0.5);
    return [part(geo, m)];
  } },
  car: { label: 'Car', colour: '#ff3fa9', make: (m, g) => { wheels(g, [-0.5, 0.5], 0.42); return [part(new THREE.BoxGeometry(1.6, 0.36, 0.8), m, 0, 0.38, 0), part(new THREE.BoxGeometry(0.8, 0.34, 0.7), m, -0.05, 0.72, 0), part(new THREE.BoxGeometry(0.82, 0.2, 0.62), glass, -0.05, 0.74, 0)]; } },
  truck: { label: 'Truck', colour: '#3d7bff', make: (m, g) => { wheels(g, [-0.7, 0.1, 0.75], 0.46, 0.22); return [part(new THREE.BoxGeometry(0.6, 0.8, 0.86), m, 0.8, 0.62, 0), part(new THREE.BoxGeometry(0.3, 0.3, 0.7), glass, 0.98, 0.78, 0), part(new THREE.BoxGeometry(1.5, 0.95, 0.9), lambert('#f6f3ff'), -0.3, 0.7, 0)]; } },
  bus: { label: 'Bus', colour: '#ffd23f', make: (m, g) => { wheels(g, [-0.8, 0.8], 0.44, 0.22); return [part(new THREE.BoxGeometry(2.4, 0.95, 0.86), m, 0, 0.7, 0), part(new THREE.BoxGeometry(2.1, 0.3, 0.88), glass, 0, 0.86, 0)]; } },
  tree: { label: 'Tree', colour: '#3ecf8e', make: (m) => [part(new THREE.CylinderGeometry(0.12, 0.16, 0.7, 12), trunk, 0, 0.35, 0), part(new THREE.SphereGeometry(0.62, 22, 14), m, 0, 1.15, 0)] },
  pine: { label: 'Pine', colour: '#3ecf8e', make: (m) => [part(new THREE.CylinderGeometry(0.1, 0.14, 0.5, 12), trunk, 0, 0.25, 0), part(new THREE.ConeGeometry(0.6, 1.5, 20), m, 0, 1.2, 0)] },
  house: { label: 'House', colour: '#f6f3ff', make: (m) => { const r = part(new THREE.ConeGeometry(1.15, 0.8, 4), roof, 0, 1.5, 0); r.rotation.y = Math.PI / 4; return [part(new THREE.BoxGeometry(1.5, 1.1, 1.5), m, 0, 0.55, 0), r, part(new THREE.BoxGeometry(0.32, 0.56, 0.06), lambert('#24222e'), 0, 0.28, 0.76)]; } },
  person: { label: 'Person', colour: '#3d7bff', make: (m) => [part(new THREE.CylinderGeometry(0.2, 0.3, 0.8, 20), m, 0, 0.4, 0), part(new THREE.SphereGeometry(0.24, 20, 14), skin, 0, 1.02, 0)] },
  letter: { label: 'Letter', colour: '#ffd23f', make: (m, g, opts) => { m.map = letterTexture(opts.letter || 'A'); return [part(new THREE.BoxGeometry(0.9, 0.9, 0.9), m, 0, 0.45, 0)]; } },
};

function makeToy(kind, opts = {}) {
  const def = TOYS[kind];
  if (!def) return null;
  const g = new THREE.Group();
  const paint = lambert(opts.color || def.colour);
  g.add(...def.make(paint, g, opts));
  g.userData = { kind, paint, letter: opts.letter || (kind === 'letter' ? 'A' : undefined) };
  g.position.set(opts.x || 0, opts.y || 0, opts.z || 0);
  g.rotation.y = opts.r || 0;
  g.scale.setScalar(opts.s || 1);
  return g;
}

// ---------- The playground itself ----------

let open = null;

export function playgroundOpen() { return !!open; }

export function openPlayground({ boardId, addImage, toast }) {
  if (open) return;
  const el = document.createElement('div');
  el.id = 'playground';
  el.innerHTML = `
    <div class="pg-top">
      <strong>Playground</strong>
      <span class="pg-hint">Pick a toy. Drag toys to move them (they stack). Drag the floor to look around.</span>
      <span class="pg-space"></span>
      <select data-a="carpet" title="The carpet"><option value="town">Town carpet</option><option value="grid">Checker carpet</option><option value="plain">Plain carpet</option></select>
      <button data-a="top">From above</button>
      <button data-a="clear">Clear</button>
      <button data-a="shot" class="primary">Put on board</button>
      <button data-a="close" title="Close (Esc)">✕</button>
    </div>
    <div class="pg-sel" hidden>
      <span class="pg-colours"></span>
      <button data-s="left" title="Turn left (Q)">⟲</button><button data-s="right" title="Turn right (E)">⟳</button>
      <button data-s="smaller" title="Smaller ([)">−</button><button data-s="bigger" title="Bigger (])">+</button>
      <button data-s="copy" title="Another one (Ctrl/⌘ + D)">Copy</button><button data-s="delete" title="Put it away (Delete)">Remove</button>
    </div>
    <div class="pg-box"></div>`;
  document.body.appendChild(el);

  const dark = document.body.dataset.tone !== 'light';
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(dark ? '#16151c' : '#f3f1f4');
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  const HOME = new THREE.Vector3(0, 13, 17);
  camera.position.copy(HOME);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(0, 0, 0.5);
  controls.maxPolarAngle = Math.PI / 2 - 0.08;
  controls.minDistance = 4; controls.maxDistance = 45;
  controls.enableDamping = true; controls.dampingFactor = 0.12;

  scene.add(new THREE.HemisphereLight('#ffffff', dark ? '#3a3560' : '#c9c2dd', 1.5));
  const sun = new THREE.DirectionalLight('#fff4e6', 2.1);
  sun.position.set(7, 14, 6);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -14, right: 14, top: 12, bottom: -12, near: 1, far: 40 });
  sun.shadow.bias = -0.0005;
  scene.add(sun);

  // The room's floor (so there's somewhere beyond the carpet), and the carpet on it.
  const room = new THREE.Mesh(new THREE.PlaneGeometry(120, 120), new THREE.MeshLambertMaterial({ color: dark ? '#221f2d' : '#e6e1ec' }));
  room.rotation.x = -Math.PI / 2; room.position.y = -0.06; room.receiveShadow = true;
  scene.add(room);
  const carpetMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
  const carpet = new THREE.Mesh(new THREE.BoxGeometry(MAT_W, 0.06, MAT_D), [lambert('#2f9f73'), lambert('#2f9f73'), carpetMat, lambert('#2f9f73'), lambert('#2f9f73'), lambert('#2f9f73')]);
  carpet.position.y = -0.03; carpet.receiveShadow = true;
  scene.add(carpet);

  const toys = [];
  let selected = null, drag = null, needs = true, raf = 0, nextLetter = 0;
  const state = { carpet: 'town' };
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.9, 1.02, 48), new THREE.MeshBasicMaterial({ color: '#ff3fa9', transparent: true, opacity: 0.95, depthTest: false }));
  ring.rotation.x = -Math.PI / 2; ring.visible = false; ring.renderOrder = 5;
  scene.add(ring);

  const setCarpet = (style) => { state.carpet = style; carpetMat.map?.dispose(); carpetMat.map = carpetTexture(style); carpetMat.needsUpdate = true; needs = true; };

  // --- saving: each board keeps its own playground
  const save = () => {
    const data = { carpet: state.carpet, toys: toys.map((t) => ({ kind: t.userData.kind, x: +t.position.x.toFixed(3), y: +t.position.y.toFixed(3), z: +t.position.z.toFixed(3), r: +t.rotation.y.toFixed(3), s: +t.scale.x.toFixed(3), color: `#${t.userData.paint.color.getHexString()}`, ...(t.userData.letter ? { letter: t.userData.letter } : {}) })) };
    try { localStorage.setItem(KEY(boardId), JSON.stringify(data)); } catch {}
  };

  // --- toys
  const boxOf = (t) => new THREE.Box3().setFromObject(t);
  // Where a toy rests at this spot: on the carpet, or on top of whatever is under it.
  const restingHeight = (toy, x, z) => {
    let y = 0;
    for (const o of toys) {
      if (o === toy) continue;
      const b = boxOf(o);
      if (x > b.min.x - 0.05 && x < b.max.x + 0.05 && z > b.min.z - 0.05 && z < b.max.z + 0.05) y = Math.max(y, b.max.y);
    }
    return y;
  };
  const select = (toy) => {
    selected = toy;
    ring.visible = !!toy;
    el.querySelector('.pg-sel').hidden = !toy;
    placeRing();
    needs = true;
  };
  const placeRing = () => {
    if (!selected) return;
    const b = boxOf(selected), r = Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.62 + 0.15;
    ring.position.set(selected.position.x, selected.position.y + 0.03, selected.position.z);
    ring.scale.setScalar(r);
  };
  // A toy lands with a little bounce.
  const plop = (toy) => {
    const s = toy.scale.x, t0 = performance.now();
    const step = () => {
      const t = Math.min(1, (performance.now() - t0) / 380);
      const k = 1 + Math.sin(t * Math.PI * 2.2) * 0.16 * (1 - t);
      toy.scale.set(s * (2 - k), s * k * (0.55 + 0.45 * Math.min(1, t * 2.4)), s * (2 - k));
      needs = true;
      if (t < 1) requestAnimationFrame(step); else { toy.scale.setScalar(s); placeRing(); }
    };
    step();
  };
  const addToy = (kind, opts = {}, { quiet = false } = {}) => {
    if (kind === 'letter' && !opts.letter) opts.letter = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'[nextLetter++ % 26];
    const toy = makeToy(kind, opts);
    if (!toy) return null;
    if (opts.x === undefined) {
      // Somewhere near what you're looking at, not on top of the last one.
      const a = toys.length * 2.4, r = 0.8 + (toys.length % 5) * 0.55;
      toy.position.set(controls.target.x + Math.cos(a) * r, 0, controls.target.z + Math.sin(a) * r);
      toy.position.y = restingHeight(toy, toy.position.x, toy.position.z);
    }
    scene.add(toy);
    toys.push(toy);
    if (!quiet) { select(toy); plop(toy); save(); }
    return toy;
  };
  const removeToy = (toy) => {
    scene.remove(toy);
    toys.splice(toys.indexOf(toy), 1);
    if (selected === toy) select(null);
    needs = true;
    save();
  };

  // --- the toy box
  const box = el.querySelector('.pg-box');
  for (const [kind, def] of Object.entries(TOYS)) {
    const b = document.createElement('button');
    b.innerHTML = `<i style="--c:${def.colour}" data-shape="${kind}"></i><span>${def.label}</span>`;
    b.addEventListener('click', () => addToy(kind));
    box.appendChild(b);
  }
  const swatches = el.querySelector('.pg-colours');
  for (const c of COLOURS) {
    const b = document.createElement('button');
    b.className = 'pg-swatch';
    b.style.background = c;
    b.title = 'Colour';
    b.addEventListener('click', () => { if (selected) { selected.userData.paint.color.set(c); needs = true; save(); } });
    swatches.appendChild(b);
  }
  const act = {
    left: () => { selected.rotation.y += Math.PI / 4; },
    right: () => { selected.rotation.y -= Math.PI / 4; },
    smaller: () => { selected.scale.setScalar(Math.max(0.3, selected.scale.x / 1.2)); },
    bigger: () => { selected.scale.setScalar(Math.min(6, selected.scale.x * 1.2)); },
    copy: () => { const t = selected; addToy(t.userData.kind, { color: `#${t.userData.paint.color.getHexString()}`, r: t.rotation.y, s: t.scale.x, letter: t.userData.letter, x: t.position.x + 1.2, z: t.position.z + 0.6, y: 0 }); selected.position.y = restingHeight(selected, selected.position.x, selected.position.z); },
    delete: () => removeToy(selected),
  };
  const run = (name) => { if (!selected) return; act[name](); placeRing(); needs = true; save(); };
  el.querySelectorAll('[data-s]').forEach((b) => b.addEventListener('click', () => run(b.dataset.s)));

  // --- moving toys with the mouse
  const ray = new THREE.Raycaster(), mouse = new THREE.Vector2(), floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
  const aim = (e) => {
    const r = renderer.domElement.getBoundingClientRect();
    mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(mouse, camera);
  };
  const toyAt = (e) => {
    aim(e);
    const found = ray.intersectObjects(toys, true)[0];
    let o = found?.object;
    while (o && !toys.includes(o)) o = o.parent;
    return o || null;
  };
  const cv = renderer.domElement;
  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const toy = toyAt(e);
    select(toy);
    if (!toy) return;
    // Slide it along the height it's standing at, keeping it under the mouse.
    floor.constant = -toy.position.y;
    ray.ray.intersectPlane(floor, hit);
    drag = { toy, dx: toy.position.x - hit.x, dz: toy.position.z - hit.z };
    controls.enabled = false;
    cv.setPointerCapture(e.pointerId);
  });
  cv.addEventListener('pointermove', (e) => {
    if (!drag) { cv.style.cursor = toyAt(e) ? 'grab' : ''; return; }
    aim(e);
    floor.constant = 0;
    if (!ray.ray.intersectPlane(floor, hit)) return;
    const x = Math.max(-30, Math.min(30, hit.x + drag.dx)), z = Math.max(-30, Math.min(30, hit.z + drag.dz));
    drag.toy.position.set(x, restingHeight(drag.toy, x, z), z);
    cv.style.cursor = 'grabbing';
    placeRing();
    needs = true;
  });
  const drop = () => {
    if (!drag) return;
    const toy = drag.toy;
    drag = null;
    controls.enabled = true;
    plop(toy);
    save();
  };
  cv.addEventListener('pointerup', drop);
  cv.addEventListener('pointercancel', drop);

  // --- keys (kept away from the board underneath)
  const onKey = (e) => {
    if (e.target.closest?.('select, input')) return;
    e.stopPropagation();
    const mod = e.metaKey || e.ctrlKey;
    if (e.key === 'Escape') { if (selected) select(null); else close(); return; }
    if (!selected) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); run('delete'); }
    else if (mod && e.code === 'KeyD') { e.preventDefault(); run('copy'); }
    else if (e.key === '[') run('smaller');
    else if (e.key === ']') run('bigger');
    else if (selected.userData.kind === 'letter' && !mod && /^[a-z0-9?!&]$/i.test(e.key)) {
      // A letter block shows whatever letter you type.
      selected.userData.letter = e.key.toUpperCase();
      selected.userData.paint.map?.dispose();
      selected.userData.paint.map = letterTexture(selected.userData.letter);
      selected.userData.paint.needsUpdate = true;
      needs = true; save();
    }
    else if (e.code === 'KeyQ') run('left');
    else if (e.code === 'KeyE') run('right');
    else if (e.key.startsWith('Arrow')) {
      e.preventDefault();
      selected.position.x += { ArrowLeft: -0.25, ArrowRight: 0.25 }[e.key] || 0;
      selected.position.z += { ArrowUp: -0.25, ArrowDown: 0.25 }[e.key] || 0;
      selected.position.y = restingHeight(selected, selected.position.x, selected.position.z);
      placeRing(); needs = true; save();
    }
  };
  window.addEventListener('keydown', onKey, true);

  // --- the buttons along the top
  el.querySelector('[data-a="carpet"]').addEventListener('change', (e) => { setCarpet(e.target.value); save(); });
  el.querySelector('[data-a="top"]').addEventListener('click', (e) => {
    const above = e.currentTarget.dataset.on !== '1';
    e.currentTarget.dataset.on = above ? '1' : '';
    e.currentTarget.textContent = above ? 'From the side' : 'From above';
    camera.position.copy(above ? new THREE.Vector3(0, 24, 0.01) : HOME);
    controls.target.set(0, 0, above ? 0 : 0.5);
    controls.update();
    needs = true;
  });
  el.querySelector('[data-a="clear"]').addEventListener('click', () => {
    if (!toys.length || !confirm('Put all the toys away?')) return;
    for (const t of [...toys]) scene.remove(t);
    toys.length = 0;
    select(null);
    save();
  });
  el.querySelector('[data-a="shot"]').addEventListener('click', () => {
    const was = ring.visible;
    ring.visible = false;
    renderer.render(scene, camera);
    cv.toBlob(async (blob) => {
      ring.visible = was; needs = true;
      if (!blob) return;
      await addImage(blob, 'Playground');
      toast('A picture of the playground is on your board.');
    }, 'image/png');
  });
  const close = () => {
    save();
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', size);
    controls.dispose();
    scene.traverse((o) => { o.geometry?.dispose?.(); });
    renderer.dispose();
    el.remove();
    open = null;
  };
  el.querySelector('[data-a="close"]').addEventListener('click', close);
  for (const t of ['pointerdown', 'wheel', 'dblclick', 'contextmenu']) el.addEventListener(t, (e) => e.stopPropagation());

  // --- start
  const size = () => {
    const w = el.clientWidth, h = el.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
    needs = true;
  };
  window.addEventListener('resize', size);
  controls.addEventListener('change', () => { needs = true; });
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(KEY(boardId)) || 'null'); } catch {}
  setCarpet(saved?.carpet || 'town');
  el.querySelector('[data-a="carpet"]').value = state.carpet;
  if (saved?.toys?.length) for (const t of saved.toys) addToy(t.kind, t, { quiet: true });
  else {
    // A first scene, so the mat isn't empty: a few things to push around.
    for (const [kind, x, z, r, color] of [['house', -4.6, 2.6, 0, null], ['box', 2.3, -2.4, 0, null], ['box', 4.6, -2.4, 0, '#3d7bff'], ['tree', -6.2, -3.6, 0, null], ['pine', -2.6, -3.9, 0, null], ['car', -1.2, 0, 0, null], ['bus', 4.2, 0, Math.PI, null], ['person', -3.2, 3.9, 0, null], ['person', -2.5, 4.1, 0, '#ff3fa9'], ['block', 6.6, 3.2, 0.4, null], ['letter', 5.4, 3.4, -0.2, null]]) {
      addToy(kind, { x, y: 0, z, r, ...(color ? { color } : {}) }, { quiet: true });
    }
  }
  size();
  const loop = () => {
    raf = requestAnimationFrame(loop);
    if (controls.update() || needs) { needs = false; renderer.render(scene, camera); }
  };
  loop();
  open = { close };
  // Letters use the display font once it's loaded.
  document.fonts?.load('700 40px Fredoka').then(() => { for (const t of toys) if (t.userData.kind === 'letter') { t.userData.paint.map = letterTexture(t.userData.letter); t.userData.paint.needsUpdate = true; } needs = true; }).catch(() => {});
}

export function closePlayground() { open?.close(); }
