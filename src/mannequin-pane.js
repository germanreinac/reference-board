// The 3D mannequin pane.
//
//   Drag empty space      orbit around the scene
//   Right-drag            move the view
//   Scroll                zoom
//   Drag a hand or foot   move it; the arm or leg bends to follow
//   Drag the hips         move that figure across the floor
//   Click a body part     select its joint; rotation rings appear for fine-tuning
//   Click empty space     deselect
//
// There can be several figures (Add figure), each with its own height. Poses, typed
// poses, Mirror and Reset act on the figure you last clicked.
//
// The top bar has ready-made poses, the figure buttons and "Add to board" (a picture of
// the current view goes onto the board). Below it you can type a pose. The bottom bar
// has the light, lens and look.

import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { TransformControls } from '../vendor/three/TransformControls.js';
import {
  buildFigure, applyPose, readRotations, writeRotations, mirror, standOnFloor,
  rotationsToPose, targetRotations, reachFor, DRAGGABLE_ENDS, PRESETS, JOINT_NAMES,
} from './mannequin.js';
import { poseFromDescription } from './ai-pose.js';
import { poseFromWords, EXAMPLE_WORDS } from './pose-words.js';
import { loadKeys, saveKeys } from './sources.js';

const KEY_ICON = '<svg viewBox="0 0 16 16"><circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5l6-6M11 4.5l1.8 1.8M9.5 6l1.5 1.5"/></svg>';

const BACKGROUND = 0x232327;
const MATERIALS = {
  clay: { color: 0xb9b6b0, roughness: 0.75, metalness: 0 },
  wood: { color: 0xc49a6c, roughness: 0.55, metalness: 0 },
  white: { color: 0xeeeeee, roughness: 0.6, metalness: 0 },
};
// Each extra figure is a slightly different shade, so they're easy to tell apart.
const SHADES = [[0, 0, 0], [0.03, 0.02, -0.1], [-0.04, 0.03, -0.04], [0.07, 0.04, -0.16], [-0.08, 0.02, -0.12], [0.12, 0.05, -0.06]];
const HEIGHTS = [['child', 'Child', 0.62], ['teen', 'Teen', 0.86], ['short', 'Short', 0.93], ['average', 'Average', 1], ['tall', 'Tall', 1.08]];
const MAX_FIGURES = 6;
const LENSES = [24, 35, 50, 85];
// A camera lens in mm (for a full-frame camera) -> vertical field of view in degrees.
const lensToFov = (mm) => THREE.MathUtils.radToDeg(2 * Math.atan(12 / mm));

export class MannequinPane {
  // actions: { addImage(blob, name), changed(), toast(message) }
  constructor(pane, host, actions) {
    this.type = 'mannequin';
    this.pane = pane;
    this.actions = actions;
    const s = pane.state || {};
    this.settings = {
      lens: LENSES.includes(s.lens) ? s.lens : 50,
      lightTurn: s.lightTurn ?? 40,
      lightHeight: s.lightHeight ?? 45,
      material: MATERIALS[s.material] ? s.material : 'clay',
    };
    this.figures = [];     // { figure, material, highlight, height }
    this.current = 0;      // the figure poses act on
    this.selected = null;  // the joint with rotation rings, if any

    this.el = document.createElement('div');
    this.el.className = 'mannequin-pane';
    this.el.innerHTML = `
      <div class="mq-bar mq-top">
        <select class="mq-presets" title="Ready-made poses"><option value="">Poses…</option></select>
        <button class="text-button mq-mirror" title="Swap left and right">Mirror</button>
        <button class="text-button mq-reset" title="Back to standing">Reset</button>
        <span class="mq-sep"></span>
        <button class="text-button mq-add-figure" title="Add another figure to the scene">+ Figure</button>
        <select class="mq-height" title="How tall this figure is">${HEIGHTS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
        <button class="text-button mq-remove-figure" title="Remove this figure">Remove</button>
        <span class="mq-flex"></span>
        <button class="text-button primary mq-add" title="Put a picture of this view on the board">Add to board</button>
      </div>
      <form class="mq-ai" autocomplete="off">
        <input class="mq-ai-input" placeholder="Type a pose… e.g. kneeling on one knee, looking left, arms crossed" spellcheck="false">
        <button class="text-button primary mq-ai-go" type="submit" title="Pose the figure (free, works offline)">Pose it</button>
        <button class="text-button mq-ai-claude" type="button" title="Ask Claude instead: better with unusual descriptions (needs your Anthropic key, a few cents each)">Ask Claude</button>
        <button class="text-button mq-ai-key" type="button" title="Your Anthropic API key, for Ask Claude">${KEY_ICON}</button>
      </form>
      <div class="mq-ai-status" hidden></div>
      <div class="mq-ai-settings" hidden>
        <p><strong>Pose it</strong> is free and works offline: it recognises activities (sitting, kneeling, running, lunge, sword swing…) and body-part words (arms crossed, looking left, leaning forward, weight on the right leg…). Left and right mean the figure's own; "facing left" means toward the left of the screen.</p>
        <p><strong>Ask Claude</strong> understands any description, using your own Anthropic API key. The key stays in this browser and is only sent to Anthropic. Each pose costs a few cents on your Anthropic account.</p>
        <label class="key-row"><span>Anthropic API key · <a href="https://platform.claude.com/" target="_blank" rel="noopener">get one</a></span>
          <input class="mq-ai-key-input" type="password" placeholder="sk-ant-…" autocomplete="off"></label>
        <button class="text-button mq-ai-done" type="button">Done</button>
      </div>
      <div class="mq-selected" hidden></div>
      <div class="mq-bar mq-bottom">
        <label title="Turn the light around the scene">Light <input class="mq-light-turn" type="range" min="0" max="360"></label>
        <label title="How high the light is">Height <input class="mq-light-height" type="range" min="5" max="88"></label>
        <label>Lens <select class="mq-lens">${LENSES.map((l) => `<option value="${l}">${l} mm</option>`).join('')}</select></label>
        <label>Look <select class="mq-material"><option value="clay">Clay</option><option value="wood">Wood</option><option value="white">White</option></select></label>
      </div>
      <div class="mq-hint">Drag a hand or foot to move it · drag the hips to move the figure · click a body part for rotation rings · drag empty space to orbit</div>`;
    host.appendChild(this.el);

    this.setupScene();
    this.setupUI();
    this.setupAI();

    // Bring back the saved figures and view, or start with one standing figure.
    const saved = Array.isArray(s.figures) && s.figures.length ? s.figures
      : [{ rotations: s.rotations || null, x: 0, z: 0, height: 'average' }];
    for (const f of saved.slice(0, MAX_FIGURES)) this.addFigure(f, { quiet: true });
    this.current = Math.min(this.figures.length - 1, Math.max(0, s.current || 0));
    if (s.camera) {
      this.camera.position.fromArray(s.camera.position);
      this.orbit.target.fromArray(s.camera.target);
      this.orbit.update();
    }
    this.figureChanged();
    this.render();
  }

  // The figure poses act on.
  get figure() {
    return this.figures[this.current].figure;
  }

  // ---------- 3D scene ----------

  setupScene() {
    const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.className = 'mq-canvas';
    this.el.prepend(renderer.domElement);
    this.renderer = renderer;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(BACKGROUND);
    this.scene = scene;

    this.camera = new THREE.PerspectiveCamera(lensToFov(this.settings.lens), 1, 0.05, 100);
    this.camera.position.set(1.4, 1.35, 4.2);

    // Soft light from the sky and ground, so shadows are never pitch black.
    this.fill = new THREE.HemisphereLight(0xffffff, 0x444448, 0.9);
    scene.add(this.fill);
    // The main light, which casts shadows. You can move it with the sliders.
    this.key = new THREE.DirectionalLight(0xffffff, 2.4);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    Object.assign(this.key.shadow.camera, { left: -3.2, right: 3.2, top: 3, bottom: -1.5, near: 0.5, far: 20 });
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);

    // The floor, which catches the shadows.
    this.floor = new THREE.Mesh(
      new THREE.CircleGeometry(8, 64),
      new THREE.MeshStandardMaterial({ color: 0x2e2e33, roughness: 1 }),
    );
    this.floor.rotation.x = -Math.PI / 2;
    this.floor.receiveShadow = true;
    scene.add(this.floor);
    const grid = new THREE.GridHelper(8, 32, 0x3a3a40, 0x323237);
    grid.position.y = 0.001;
    scene.add(grid);
    // A ring on the floor under the figure that poses act on (when there are several).
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.33, 48), new THREE.MeshBasicMaterial({ color: 0x4da3ff, transparent: true, opacity: 0.8 }));
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.003;
    scene.add(this.marker);

    // Camera controls: orbit, pan and zoom.
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.enableDamping = false;
    this.orbit.minDistance = 0.4;
    this.orbit.maxDistance = 18;
    this.orbit.update();
    this.orbit.addEventListener('change', () => {
      // Don't let the camera go below the floor.
      if (this.camera.position.y < 0.08 && !this.clamping) {
        this.clamping = true;
        this.camera.position.y = 0.08;
        this.orbit.update();
        this.clamping = false;
      }
      this.render();
      this.saveSoon();
    });

    // Rotation rings on the selected joint.
    this.gizmo = new TransformControls(this.camera, renderer.domElement);
    this.gizmo.setMode('rotate');
    this.gizmo.setSpace('local');
    this.gizmo.setSize(0.75);
    scene.add(this.gizmo.getHelper());
    this.gizmo.addEventListener('dragging-changed', (e) => { this.orbit.enabled = !e.value; });
    this.gizmo.addEventListener('change', () => this.render());
    this.gizmo.addEventListener('objectChange', () => {
      standOnFloor(this.figure);
      this.saveSoon();
    });

    this.placeLight();
    this.setupPointer();
  }

  // Clicking and dragging on the figures.
  setupPointer() {
    const canvas = this.renderer.domElement;
    this.press = null;  // what the current press is doing

    // This runs before the camera controls see the press (capture phase), so a press
    // on a hand, foot or hips can stop the camera from orbiting.
    this.onDown = (e) => {
      if (e.target !== canvas || e.button !== 0) return;
      if (this.gizmo.axis) return;  // the rotation rings handle this one
      const hit = this.pick(e);
      const press = { x: e.clientX, y: e.clientY, hit, moved: false, mode: null };
      if (hit && (DRAGGABLE_ENDS.includes(hit.joint) || hit.joint === 'hips')) {
        press.mode = hit.joint === 'hips' ? 'move' : 'reach';
        this.orbit.enabled = false;
        canvas.setPointerCapture(e.pointerId);
      }
      this.press = press;
    };
    this.onMove = (e) => {
      const p = this.press;
      if (!p) return;
      if (!p.moved && Math.hypot(e.clientX - p.x, e.clientY - p.y) > 4) {
        p.moved = true;
        if (p.mode) this.startDrag(p);
      }
      if (p.moved && p.mode) this.drag(p, e);
    };
    this.onUp = (e) => {
      const p = this.press;
      this.press = null;
      if (!p) return;
      if (p.mode) {
        this.orbit.enabled = true;
        try { canvas.releasePointerCapture(e.pointerId); } catch {}
      }
      if (p.moved) {
        if (p.mode) { standOnFloor(this.figures[p.hit.index].figure); this.render(); this.saveSoon(); }
        return;
      }
      // A click: select the part, or deselect when clicking empty space.
      if (p.hit) this.select(p.hit.index, p.hit.joint);
      else if (!this.gizmo.dragging) this.select(this.current, null);
    };
    this.el.addEventListener('pointerdown', this.onDown, true);
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onUp);

    this.onKey = (e) => {
      if (e.key === 'Escape' && this.selected && this.el.matches(':hover')) this.select(this.current, null);
    };
    window.addEventListener('keydown', this.onKey);
  }

  ray(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    return ray;
  }

  // Which figure and joint is under the mouse, and the exact point that was hit.
  pick(e) {
    const parts = this.figures.flatMap((f, index) => f.figure.parts.map((p) => { p.userData.figure = index; return p; }));
    const hit = this.ray(e).intersectObjects(parts, false)[0];
    return hit ? { index: hit.object.userData.figure, joint: hit.object.userData.joint, point: hit.point } : null;
  }

  startDrag(p) {
    const { figure } = this.figures[p.hit.index];
    if (this.current !== p.hit.index) { this.current = p.hit.index; this.figureChanged(); }
    if (p.mode === 'reach') {
      // Drag on a plane facing the camera, through the point that was grabbed.
      const end = figure.joints[p.hit.joint].getWorldPosition(new THREE.Vector3());
      p.offset = end.clone().sub(p.hit.point);
      p.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(this.camera.getWorldDirection(new THREE.Vector3()), p.hit.point);
    } else {
      // Moving the whole figure: drag across the floor.
      p.plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
      const onFloor = this.ray({ clientX: p.x, clientY: p.y }).ray.intersectPlane(p.plane, new THREE.Vector3());
      p.offset = onFloor ? figure.root.position.clone().sub(onFloor) : new THREE.Vector3();
    }
    if (this.selected) this.select(this.current, null);
  }

  drag(p, e) {
    const point = this.ray(e).ray.intersectPlane(p.plane, new THREE.Vector3());
    if (!point) return;
    const { figure } = this.figures[p.hit.index];
    if (p.mode === 'reach') {
      reachFor(figure, p.hit.joint, point.add(p.offset));
      standOnFloor(figure);
    } else {
      const to = point.add(p.offset);
      figure.root.position.x = THREE.MathUtils.clamp(to.x, -7, 7);
      figure.root.position.z = THREE.MathUtils.clamp(to.z, -7, 7);
      this.placeMarker();
    }
    this.render();
  }

  select(index, jointName) {
    if (index !== this.current) { this.current = index; this.figureChanged(); }
    this.selected = jointName;
    this.figures.forEach((f, i) => {
      for (const part of f.figure.parts) part.material = i === index && part.userData.joint === jointName ? f.highlight : f.material;
    });
    if (jointName) this.gizmo.attach(this.figure.joints[jointName]);
    else this.gizmo.detach();
    const label = this.el.querySelector('.mq-selected');
    label.hidden = !jointName;
    const which = this.figures.length > 1 ? `Figure ${index + 1} · ` : '';
    label.textContent = jointName ? `${which}${JOINT_NAMES[jointName]} · drag the rings to bend · Esc to deselect` : '';
    this.el.classList.toggle('has-selection', !!jointName);
    this.render();
  }

  // ---------- Figures ----------

  // Add a figure from saved data { rotations, x, z, height }, or a new standing one.
  addFigure(data = {}, { quiet = false } = {}) {
    if (this.figures.length >= MAX_FIGURES) {
      this.actions.toast(`There can be up to ${MAX_FIGURES} figures.`);
      return;
    }
    const i = this.figures.length;
    const material = new THREE.MeshStandardMaterial(MATERIALS[this.settings.material]);
    material.color.offsetHSL(...SHADES[i % SHADES.length]);
    const highlight = new THREE.MeshStandardMaterial({ ...MATERIALS[this.settings.material], emissive: 0x2a5d9a, emissiveIntensity: 0.6 });
    highlight.color.copy(material.color);
    const figure = buildFigure(material);
    const entry = { figure, material, highlight, height: HEIGHTS.some(([id]) => id === data.height) ? data.height : 'average' };
    this.figures.push(entry);
    this.scene.add(figure.root);
    if (data.rotations) writeRotations(figure, data.rotations);
    else applyPose(figure, PRESETS.Standing);
    if (data.x !== undefined) figure.root.position.set(data.x, 0, data.z || 0);
    else if (i > 0) {
      // Next to the current figure, a little to its right on screen.
      const near = this.figure.root.position;
      figure.root.position.set(near.x + 0.85, 0, near.z + 0.15);
      figure.root.rotation.y = this.figure.root.rotation.y;
    }
    this.applyHeight(entry);
    if (!quiet) {
      this.current = i;
      this.figureChanged();
      this.select(i, null);
      this.saveSoon();
    }
  }

  removeFigure() {
    if (this.figures.length < 2) return;
    const [gone] = this.figures.splice(this.current, 1);
    this.gizmo.detach();
    this.scene.remove(gone.figure.root);
    gone.material.dispose();
    gone.highlight.dispose();
    this.current = Math.max(0, this.current - 1);
    this.selected = null;
    this.figureChanged();
    this.select(this.current, null);
    this.saveSoon();
  }

  applyHeight(entry) {
    const scale = HEIGHTS.find(([id]) => id === entry.height)[2];
    entry.figure.root.scale.setScalar(scale);
    standOnFloor(entry.figure);
  }

  // Update the controls and floor ring for the figure poses now act on.
  figureChanged() {
    const several = this.figures.length > 1;
    this.el.querySelector('.mq-height').value = this.figures[this.current].height;
    this.el.querySelector('.mq-remove-figure').hidden = !several;
    this.el.querySelector('.mq-add-figure').disabled = this.figures.length >= MAX_FIGURES;
    this.marker.visible = several;
    this.placeMarker();
    this.render();
  }

  placeMarker() {
    const root = this.figure.root;
    this.marker.position.x = root.position.x;
    this.marker.position.z = root.position.z;
    this.marker.scale.setScalar(root.scale.x);
  }

  placeLight() {
    const turn = THREE.MathUtils.degToRad(this.settings.lightTurn);
    const height = THREE.MathUtils.degToRad(this.settings.lightHeight);
    const d = 7;
    this.key.position.set(Math.sin(turn) * Math.cos(height) * d, Math.sin(height) * d + 0.9, Math.cos(turn) * Math.cos(height) * d);
    this.key.target.position.set(0, 0.9, 0);
    this.render();
  }

  render() {
    if (!this.renderer || !this.rect) return;
    this.renderer.render(this.scene, this.camera);
  }

  layout(rect) {
    this.rect = rect;
    this.renderer.setSize(Math.max(1, rect.w), Math.max(1, rect.h), true);
    this.camera.aspect = rect.w / Math.max(1, rect.h);
    this.camera.updateProjectionMatrix();
    this.el.classList.toggle('compact', rect.w < 560);
    this.render();
  }

  // ---------- Buttons and sliders ----------

  setupUI() {
    const $ = (sel) => this.el.querySelector(sel);
    const presets = $('.mq-presets');
    for (const name of Object.keys(PRESETS)) presets.add(new Option(name, name));
    presets.addEventListener('change', () => {
      if (!presets.value) return;
      this.setPose(PRESETS[presets.value]);
      presets.value = '';
    });
    $('.mq-mirror').addEventListener('click', () => { mirror(this.figure); this.poseChanged(); });
    $('.mq-reset').addEventListener('click', () => this.setPose(PRESETS.Standing));
    $('.mq-add').addEventListener('click', () => this.addToBoard());
    $('.mq-add-figure').addEventListener('click', () => this.addFigure());
    $('.mq-remove-figure').addEventListener('click', () => this.removeFigure());
    $('.mq-height').addEventListener('change', (e) => {
      const entry = this.figures[this.current];
      entry.height = e.target.value;
      this.applyHeight(entry);
      this.placeMarker();
      if (this.selected) this.gizmo.attach(this.figure.joints[this.selected]);
      this.render();
      this.saveSoon();
    });

    const turn = $('.mq-light-turn');
    const height = $('.mq-light-height');
    turn.value = this.settings.lightTurn;
    height.value = this.settings.lightHeight;
    const lightChanged = () => {
      this.settings.lightTurn = Number(turn.value);
      this.settings.lightHeight = Number(height.value);
      this.placeLight();
      this.saveSoon();
    };
    turn.addEventListener('input', lightChanged);
    height.addEventListener('input', lightChanged);

    const lens = $('.mq-lens');
    lens.value = this.settings.lens;
    lens.addEventListener('change', () => this.setLens(Number(lens.value)));

    const material = $('.mq-material');
    material.value = this.settings.material;
    material.addEventListener('change', () => {
      this.settings.material = material.value;
      const m = MATERIALS[material.value];
      this.figures.forEach((f, i) => {
        f.material.color.setHex(m.color).offsetHSL(...SHADES[i % SHADES.length]);
        f.material.roughness = m.roughness;
        f.highlight.color.copy(f.material.color);
      });
      this.render();
      this.saveSoon();
    });

    // Keep clicks inside the pane's controls from reaching the 3D view.
    for (const bar of this.el.querySelectorAll('.mq-bar, .mq-ai, .mq-ai-settings')) bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Change lens but keep the scene about the same size on screen
  // (like a photographer stepping back with a longer lens).
  setLens(mm) {
    const offset = this.camera.position.clone().sub(this.orbit.target);
    offset.multiplyScalar(mm / this.settings.lens);
    this.camera.position.copy(this.orbit.target).add(offset);
    this.settings.lens = mm;
    this.camera.fov = lensToFov(mm);
    this.camera.updateProjectionMatrix();
    this.orbit.update();
    this.render();
    this.saveSoon();
  }

  // Put the current figure in a plain-language pose (see src/mannequin.js),
  // moving smoothly into it.
  setPose(pose, { animate = true } = {}) {
    cancelAnimationFrame(this.tween);
    const figure = this.figure;
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyPose(figure, pose);
      this.poseChanged();
      return;
    }
    const to = targetRotations(pose);
    const from = {};
    for (const [name, j] of Object.entries(figure.joints)) from[name] = j.quaternion.clone();
    const fromTurn = figure.root.rotation.y;
    const start = performance.now();
    const step = (now) => {
      if (!this.renderer) return;
      const t = Math.min(1, (now - start) / 450);
      const k = t * t * (3 - 2 * t);  // ease in and out
      for (const [name, j] of Object.entries(figure.joints)) j.quaternion.slerpQuaternions(from[name], to[name], k);
      figure.root.rotation.y = fromTurn + (to.turn - fromTurn) * k;
      standOnFloor(figure);
      if (this.selected) this.gizmo.attach(this.figure.joints[this.selected]);
      this.render();
      if (t < 1) this.tween = requestAnimationFrame(step);
      else this.poseChanged();
    };
    this.tween = requestAnimationFrame(step);
  }

  // ---------- Typing a pose ----------

  setupAI() {
    const $ = (sel) => this.el.querySelector(sel);
    const form = $('.mq-ai');
    const input = $('.mq-ai-input');
    const go = $('.mq-ai-go');
    const status = $('.mq-ai-status');
    const settings = $('.mq-ai-settings');
    const keyInput = $('.mq-ai-key-input');
    const showStatus = (text, kind = '') => {
      status.hidden = !text;
      status.textContent = text;
      status.dataset.kind = kind;
    };
    const openSettings = (open) => {
      settings.hidden = !open;
      if (open) { keyInput.value = loadKeys().anthropic || ''; keyInput.focus(); }
    };
    $('.mq-ai-key').addEventListener('click', () => openSettings(settings.hidden));
    $('.mq-ai-done').addEventListener('click', () => openSettings(false));
    keyInput.addEventListener('change', () => {
      const keys = loadKeys();
      if (keyInput.value.trim()) keys.anthropic = keyInput.value.trim();
      else delete keys.anthropic;
      saveKeys(keys);
    });
    // Typing in these boxes must not trigger board shortcuts.
    for (const el of [input, keyInput]) el.addEventListener('keydown', (e) => e.stopPropagation());

    // Pose it: the free word engine, right here in the browser.
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const description = input.value.trim();
      if (!description) return;
      const result = poseFromWords(description, rotationsToPose(this.figure));
      if (!result) {
        const some = [...EXAMPLE_WORDS].sort(() => Math.random() - 0.5).slice(0, 6).join(', ');
        showStatus(`Didn't recognise a pose there. Try words like: ${some}.${loadKeys().anthropic ? ' Or press Ask Claude.' : ''}`, 'error');
        return;
      }
      this.setPose(result.pose);
      showStatus(`Understood: ${result.understood.join(' · ')}. Drag a hand or foot to adjust it.`);
      clearTimeout(this.statusTimer);
      this.statusTimer = setTimeout(() => { if (status.dataset.kind === '') showStatus(''); }, 7000);
    });

    // Ask Claude: any description, with the person's own Anthropic key.
    $('.mq-ai-claude').addEventListener('click', async () => {
      const description = input.value.trim();
      if (!description) return input.focus();
      if (this.asking) return;
      const key = loadKeys().anthropic;
      if (!key) {
        showStatus('Add your Anthropic API key first (the key button).', 'error');
        openSettings(true);
        return;
      }
      this.asking = true;
      go.disabled = true;
      $('.mq-ai-claude').disabled = true;
      showStatus('Claude is posing the figure…', 'busy');
      try {
        const { pose, summary } = await poseFromDescription(description, rotationsToPose(this.figure), key);
        if (!this.renderer) return;  // the pane was closed meanwhile
        this.setPose(pose);
        showStatus(summary ? `${summary}. Drag a hand or foot to adjust it.` : 'Done. Drag a hand or foot to adjust it.');
        setTimeout(() => { if (status.dataset.kind === '') showStatus(''); }, 6000);
      } catch (err) {
        showStatus(err.message, 'error');
      } finally {
        this.asking = false;
        go.disabled = false;
        $('.mq-ai-claude').disabled = false;
      }
    });
  }

  poseChanged() {
    standOnFloor(this.figure);
    if (this.selected) this.gizmo.attach(this.figure.joints[this.selected]);
    this.render();
    this.saveSoon();
  }

  // A picture of the current view, twice the pane's resolution, onto the board.
  async addToBoard() {
    const selected = this.selected;
    this.select(this.current, null);
    const helper = this.gizmo.getHelper();
    helper.visible = false;
    const markerShown = this.marker.visible;
    this.marker.visible = false;
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(Math.min(4, ratio * 2));
    this.renderer.setSize(this.rect.w, this.rect.h, true);
    this.renderer.render(this.scene, this.camera);
    const blob = await new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.rect.w, this.rect.h, true);
    helper.visible = true;
    this.marker.visible = markerShown;
    this.select(this.current, selected);
    if (blob) this.actions.addImage(blob, this.figures.length > 1 ? 'Mannequin scene' : 'Mannequin pose');
  }

  // ---------- Saving ----------

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  save() {
    const round = (v) => Math.round(v * 1000) / 1000;
    this.pane.state = {
      ...this.settings,
      figures: this.figures.map((f) => ({
        rotations: readRotations(f.figure), x: round(f.figure.root.position.x), z: round(f.figure.root.position.z), height: f.height,
      })),
      current: this.current,
      camera: { position: this.camera.position.toArray(), target: this.orbit.target.toArray() },
    };
    this.actions.changed();
  }

  focus() {}

  destroy() {
    clearTimeout(this.saveTimer);
    cancelAnimationFrame(this.tween);
    if (this.pane.type === 'mannequin') this.save();  // not when the pane is switching to something else
    window.removeEventListener('keydown', this.onKey);
    this.el.removeEventListener('pointerdown', this.onDown, true);
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); });
    for (const f of this.figures) { f.material.dispose(); f.highlight.dispose(); }
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
    this.renderer = null;
  }
}
