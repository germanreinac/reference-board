// The 3D mannequin pane.
//
//   Drag            orbit around the figure
//   Right-drag      move the view
//   Scroll          zoom
//   Click a part    select its joint; rotation rings appear. Drag a ring to bend the joint.
//   Click empty     deselect
//
// The top bar has ready-made poses, Mirror, Reset and "Add to board" (a picture of
// the current view goes onto the board). Below it you can type a pose for Claude to
// make (see src/ai-pose.js). The bottom bar has the light, lens and material.

import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { TransformControls } from '../vendor/three/TransformControls.js';
import {
  buildFigure, applyPose, readRotations, writeRotations, mirror, standOnFloor,
  rotationsToPose, targetRotations, PRESETS, JOINT_NAMES,
} from './mannequin.js';
import { poseFromDescription } from './ai-pose.js';
import { loadKeys, saveKeys } from './sources.js';

const KEY_ICON = '<svg viewBox="0 0 16 16"><circle cx="5" cy="10.5" r="2.8"/><path d="M7 8.5l6-6M11 4.5l1.8 1.8M9.5 6l1.5 1.5"/></svg>';

const BACKGROUND = 0x232327;
const MATERIALS = {
  clay: { color: 0xb9b6b0, roughness: 0.75, metalness: 0 },
  wood: { color: 0xc49a6c, roughness: 0.55, metalness: 0 },
  white: { color: 0xeeeeee, roughness: 0.6, metalness: 0 },
};
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

    this.el = document.createElement('div');
    this.el.className = 'mannequin-pane';
    this.el.innerHTML = `
      <div class="mq-bar mq-top">
        <select class="mq-presets" title="Ready-made poses"><option value="">Poses…</option></select>
        <button class="text-button mq-mirror" title="Swap left and right">Mirror</button>
        <button class="text-button mq-reset" title="Back to standing">Reset</button>
        <span class="mq-flex"></span>
        <button class="text-button primary mq-add" title="Put a picture of this view on the board">Add to board</button>
      </div>
      <form class="mq-ai" autocomplete="off">
        <input class="mq-ai-input" placeholder="Describe a pose… e.g. sitting on the floor hugging knees, looking left" spellcheck="false">
        <button class="text-button mq-ai-go" type="submit" title="Ask Claude to pose the mannequin">Pose it</button>
        <button class="text-button mq-ai-key" type="button" title="Your Anthropic API key">${KEY_ICON}</button>
      </form>
      <div class="mq-ai-status" hidden></div>
      <div class="mq-ai-settings" hidden>
        <p>Typed poses use Claude with your own Anthropic API key. It stays in this browser and is only sent to Anthropic. Each pose costs a few cents on your Anthropic account.</p>
        <label class="key-row"><span>Anthropic API key · <a href="https://platform.claude.com/" target="_blank" rel="noopener">get one</a></span>
          <input class="mq-ai-key-input" type="password" placeholder="sk-ant-…" autocomplete="off"></label>
        <button class="text-button mq-ai-done" type="button">Done</button>
      </div>
      <div class="mq-selected" hidden></div>
      <div class="mq-bar mq-bottom">
        <label title="Turn the light around the figure">Light <input class="mq-light-turn" type="range" min="0" max="360"></label>
        <label title="How high the light is">Height <input class="mq-light-height" type="range" min="5" max="88"></label>
        <label>Lens <select class="mq-lens">${LENSES.map((l) => `<option value="${l}">${l} mm</option>`).join('')}</select></label>
        <label>Look <select class="mq-material"><option value="clay">Clay</option><option value="wood">Wood</option><option value="white">White</option></select></label>
      </div>
      <div class="mq-hint">Click a body part to pose it · drag to orbit · right-drag to move · scroll to zoom</div>`;
    host.appendChild(this.el);

    this.setupScene();
    this.setupUI();
    this.setupAI();

    // Bring back the saved pose and view, or start standing.
    if (s.rotations) writeRotations(this.figure, s.rotations);
    else applyPose(this.figure, PRESETS.Standing);
    if (s.camera) {
      this.camera.position.fromArray(s.camera.position);
      this.orbit.target.fromArray(s.camera.target);
      this.orbit.update();
    }
    standOnFloor(this.figure);
    this.render();
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
    Object.assign(this.key.shadow.camera, { left: -2, right: 2, top: 2.5, bottom: -1, near: 0.5, far: 20 });
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    scene.add(this.key, this.key.target);

    // The floor, which catches the shadow.
    const floor = new THREE.Mesh(
      new THREE.CircleGeometry(6, 64),
      new THREE.MeshStandardMaterial({ color: 0x2e2e33, roughness: 1 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    scene.add(floor);
    const grid = new THREE.GridHelper(6, 24, 0x3a3a40, 0x323237);
    grid.position.y = 0.001;
    scene.add(grid);

    this.material = new THREE.MeshStandardMaterial(MATERIALS[this.settings.material]);
    this.highlight = new THREE.MeshStandardMaterial({ ...MATERIALS[this.settings.material], emissive: 0x2a5d9a, emissiveIntensity: 0.6 });
    this.figure = buildFigure(this.material);
    scene.add(this.figure.root);

    // Camera controls: orbit, pan and zoom around the figure's middle.
    this.orbit = new OrbitControls(this.camera, renderer.domElement);
    this.orbit.target.set(0, 0.95, 0);
    this.orbit.enableDamping = false;
    this.orbit.minDistance = 0.4;
    this.orbit.maxDistance = 15;
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

    // Click (without dragging) to select a body part.
    const canvas = renderer.domElement;
    const down = { x: 0, y: 0 };
    this.onPointerDown = (e) => { down.x = e.clientX; down.y = e.clientY; };
    this.onPointerUp = (e) => {
      if (e.button !== 0 || this.gizmo.dragging) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;  // that was an orbit drag
      if (this.gizmo.axis) return;  // clicked the rings themselves
      this.select(this.pick(e));
    };
    canvas.addEventListener('pointerdown', this.onPointerDown);
    canvas.addEventListener('pointerup', this.onPointerUp);
    this.onKey = (e) => {
      if (e.key === 'Escape' && this.selected && this.el.matches(':hover')) this.select(null);
    };
    window.addEventListener('keydown', this.onKey);
  }

  pick(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.figure.parts, false)[0];
    return hit ? hit.object.userData.joint : null;
  }

  select(jointName) {
    this.selected = jointName;
    for (const p of this.figure.parts) p.material = p.userData.joint === jointName ? this.highlight : this.material;
    if (jointName) this.gizmo.attach(this.figure.joints[jointName]);
    else this.gizmo.detach();
    const label = this.el.querySelector('.mq-selected');
    label.hidden = !jointName;
    label.textContent = jointName ? `${JOINT_NAMES[jointName]} · drag the rings to bend · Esc to deselect` : '';
    this.el.classList.toggle('has-selection', !!jointName);
    this.render();
  }

  placeLight() {
    const turn = THREE.MathUtils.degToRad(this.settings.lightTurn);
    const height = THREE.MathUtils.degToRad(this.settings.lightHeight);
    const d = 6;
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
    this.el.classList.toggle('compact', rect.w < 520);
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
      this.material.color.setHex(m.color);
      this.material.roughness = m.roughness;
      this.highlight.color.setHex(m.color);
      this.render();
      this.saveSoon();
    });

    // Keep clicks inside the pane's controls from reaching the 3D view.
    for (const bar of this.el.querySelectorAll('.mq-bar, .mq-ai, .mq-ai-settings')) bar.addEventListener('pointerdown', (e) => e.stopPropagation());
  }

  // Change lens but keep the figure about the same size on screen
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

  // Put the figure in a plain-language pose (see src/mannequin.js), moving smoothly into it.
  setPose(pose, { animate = true } = {}) {
    cancelAnimationFrame(this.tween);
    if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      applyPose(this.figure, pose);
      this.poseChanged();
      return;
    }
    const to = targetRotations(pose);
    const from = {};
    for (const [name, j] of Object.entries(this.figure.joints)) from[name] = j.quaternion.clone();
    const fromTurn = this.figure.root.rotation.y;
    const start = performance.now();
    const step = (now) => {
      const t = Math.min(1, (now - start) / 450);
      const k = t * t * (3 - 2 * t);  // ease in and out
      for (const [name, j] of Object.entries(this.figure.joints)) j.quaternion.slerpQuaternions(from[name], to[name], k);
      this.figure.root.rotation.y = fromTurn + (to.turn - fromTurn) * k;
      standOnFloor(this.figure);
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

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const description = input.value.trim();
      if (!description || this.asking) return;
      const key = loadKeys().anthropic;
      if (!key) {
        showStatus('Add your Anthropic API key first (the key button).', 'error');
        openSettings(true);
        return;
      }
      this.asking = true;
      go.disabled = true;
      showStatus('Claude is posing the mannequin…', 'busy');
      try {
        const { pose, summary } = await poseFromDescription(description, rotationsToPose(this.figure), key);
        if (!this.renderer) return;  // the pane was closed meanwhile
        this.setPose(pose);
        showStatus(summary ? `${summary}. Click a body part to adjust it.` : 'Done. Click a body part to adjust it.');
        setTimeout(() => { if (status.dataset.kind === '') showStatus(''); }, 6000);
      } catch (err) {
        showStatus(err.message, 'error');
      } finally {
        this.asking = false;
        go.disabled = false;
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
    this.select(null);
    const helper = this.gizmo.getHelper();
    helper.visible = false;
    const ratio = this.renderer.getPixelRatio();
    this.renderer.setPixelRatio(Math.min(4, ratio * 2));
    this.renderer.setSize(this.rect.w, this.rect.h, true);
    this.renderer.render(this.scene, this.camera);
    const blob = await new Promise((resolve) => this.renderer.domElement.toBlob(resolve, 'image/png'));
    this.renderer.setPixelRatio(ratio);
    this.renderer.setSize(this.rect.w, this.rect.h, true);
    helper.visible = true;
    this.select(selected);
    if (blob) this.actions.addImage(blob, 'Mannequin pose');
  }

  // ---------- Saving ----------

  saveSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.save(), 400);
  }

  save() {
    this.pane.state = {
      ...this.settings,
      rotations: readRotations(this.figure),
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
    this.gizmo.detach();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.scene.traverse((o) => { o.geometry?.dispose?.(); });
    this.material.dispose();
    this.highlight.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.el.remove();
    this.renderer = null;
  }
}
