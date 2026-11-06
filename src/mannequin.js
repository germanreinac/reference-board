// The 3D mannequin: a wooden art figure made of simple shapes, with joints you can bend.
//
// Each joint is an invisible pivot point. Body parts hang off the joints, so
// bending the shoulder swings the whole arm, bending the elbow swings the
// forearm and hand, and so on.
//
// Poses are written in plain terms, in degrees, for example
//   { elbowL: { bend: 90 }, shoulderR: { forward: 45, out: 10 }, head: { twist: 20 } }
// and turned into joint rotations by poseToRotations(). The figure faces +Z,
// and "L" / "R" are the figure's own left and right.

import * as THREE from '../vendor/three/three.module.min.js';

// ---------- Joints and what each plain-language angle means ----------

// [axis, sign]: which way each named angle turns the joint. Right-side joints
// mirror the left side, so the same numbers give a mirror-image pose.
const SPINE = { bend: ['x', 1], side: ['z', -1], twist: ['y', 1] };
const LIMB = { forward: ['x', -1], out: ['z', 1], twist: ['y', 1] };
export const JOINTS = {
  hips: SPINE, spine: SPINE, chest: SPINE, neck: SPINE, head: SPINE,
  shoulderL: LIMB, shoulderR: LIMB,
  elbowL: { bend: ['x', -1] }, elbowR: { bend: ['x', -1] },
  wristL: { bend: ['x', -1], side: ['z', 1] }, wristR: { bend: ['x', -1], side: ['z', 1] },
  hipL: LIMB, hipR: LIMB,
  kneeL: { bend: ['x', 1] }, kneeR: { bend: ['x', 1] },
  ankleL: { bend: ['x', -1] }, ankleR: { bend: ['x', -1] },
};
const MIRRORED_AXES = ['y', 'z'];  // on the right side these two flip

export const JOINT_NAMES = {
  hips: 'Hips', spine: 'Waist', chest: 'Chest', neck: 'Neck', head: 'Head',
  shoulderL: 'Left shoulder', shoulderR: 'Right shoulder', elbowL: 'Left elbow', elbowR: 'Right elbow',
  wristL: 'Left wrist', wristR: 'Right wrist', hipL: 'Left hip', hipR: 'Right hip',
  kneeL: 'Left knee', kneeR: 'Right knee', ankleL: 'Left ankle', ankleR: 'Right ankle',
};

// A plain-language pose -> a rotation (Euler angles in radians) for every joint.
export function poseToRotations(pose) {
  const out = {};
  for (const [joint, axes] of Object.entries(JOINTS)) {
    const values = pose[joint] || {};
    const e = { x: 0, y: 0, z: 0 };
    const right = joint.endsWith('R');
    for (const [name, [axis, sign]] of Object.entries(axes)) {
      const deg = Number(values[name]) || 0;
      const flip = right && MIRRORED_AXES.includes(axis) ? -1 : 1;
      e[axis] += THREE.MathUtils.degToRad(deg) * sign * flip;
    }
    out[joint] = e;
  }
  return out;
}

// ---------- Ready-made poses ----------

export const PRESETS = {
  'Standing': {
    shoulderL: { out: 8 }, shoulderR: { out: 8 }, elbowL: { bend: 10 }, elbowR: { bend: 10 },
  },
  'T-pose': { shoulderL: { out: 90 }, shoulderR: { out: 90 } },
  'A-pose': { shoulderL: { out: 45 }, shoulderR: { out: 45 } },
  'Contrapposto': {
    hips: { side: -6, twist: 4 }, spine: { side: 3 }, chest: { side: 5, twist: -4 }, head: { side: -4, twist: 12 },
    hipR: { out: 4 }, hipL: { forward: 10, out: 4, twist: -8 }, kneeL: { bend: 18 }, ankleL: { bend: -6 },
    shoulderL: { out: 9, forward: -4 }, shoulderR: { out: 6, forward: 4 }, elbowL: { bend: 12 }, elbowR: { bend: 22 },
  },
  'Walking': {
    chest: { twist: 8 }, head: { twist: -6 },
    hipL: { forward: 25 }, kneeL: { bend: 8 }, ankleL: { bend: 8 },
    hipR: { forward: -18 }, kneeR: { bend: 22 }, ankleR: { bend: -12 },
    shoulderL: { forward: -22, out: 6 }, shoulderR: { forward: 24, out: 6 }, elbowL: { bend: 18 }, elbowR: { bend: 32 },
  },
  'Running': {
    spine: { bend: 10 }, chest: { bend: 6, twist: 12 }, head: { bend: -12, twist: -10 },
    hipL: { forward: 65 }, kneeL: { bend: 85 }, ankleL: { bend: 10 },
    hipR: { forward: -28 }, kneeR: { bend: 105 }, ankleR: { bend: -25 },
    shoulderL: { forward: -50, out: 10 }, shoulderR: { forward: 55, out: 8 }, elbowL: { bend: 85 }, elbowR: { bend: 95 },
  },
  'Sitting on a chair': {
    spine: { bend: 4 }, head: { bend: 6 },
    hipL: { forward: 88, out: 6 }, hipR: { forward: 88, out: 6 }, kneeL: { bend: 88 }, kneeR: { bend: 88 },
    shoulderL: { forward: 22, out: 10 }, shoulderR: { forward: 22, out: 10 }, elbowL: { bend: 55 }, elbowR: { bend: 55 },
  },
  'Sitting, knees up': {
    spine: { bend: 22 }, chest: { bend: 10 }, head: { bend: -10 },
    hipL: { forward: 105, out: 14 }, hipR: { forward: 105, out: 14 }, kneeL: { bend: 125 }, kneeR: { bend: 125 },
    ankleL: { bend: 10 }, ankleR: { bend: 10 },
    shoulderL: { forward: 45, out: 8 }, shoulderR: { forward: 45, out: 8 }, elbowL: { bend: 35 }, elbowR: { bend: 35 },
  },
  'Crouching': {
    spine: { bend: 28 }, chest: { bend: 12 }, head: { bend: -25 },
    hipL: { forward: 115, out: 18 }, hipR: { forward: 115, out: 18 }, kneeL: { bend: 140 }, kneeR: { bend: 140 },
    ankleL: { bend: 28 }, ankleR: { bend: 28 },
    shoulderL: { forward: 50, out: 6 }, shoulderR: { forward: 50, out: 6 }, elbowL: { bend: 40 }, elbowR: { bend: 40 },
  },
  'Kneeling on one knee': {
    spine: { bend: 4 },
    hipL: { forward: 85, out: 4 }, kneeL: { bend: 90 },
    hipR: { forward: -8, out: 4 }, kneeR: { bend: 92 }, ankleR: { bend: -35 },
    shoulderL: { forward: 30, out: 6 }, shoulderR: { forward: 10, out: 8 }, elbowL: { bend: 70 }, elbowR: { bend: 15 },
  },
  'Reaching up': {
    chest: { bend: -8, side: 6 }, head: { bend: -22 },
    shoulderR: { forward: 168, out: 8 }, elbowR: { bend: 8 }, shoulderL: { out: 12 }, elbowL: { bend: 15 },
    ankleL: { bend: -18 }, ankleR: { bend: -18 },
  },
  'Fighting stance': {
    hips: { twist: 25 }, spine: { bend: 6 }, chest: { twist: -18, bend: 4 }, head: { twist: -10, bend: 8 },
    hipL: { forward: 22, out: 10 }, kneeL: { bend: 25 }, hipR: { forward: -16, out: 12, twist: 20 }, kneeR: { bend: 30 },
    shoulderL: { forward: 65, out: 22, twist: 10 }, elbowL: { bend: 115 },
    shoulderR: { forward: 45, out: 28, twist: 10 }, elbowR: { bend: 135 },
  },
  'Pointing': {
    hips: { twist: -10 }, chest: { twist: 12 }, head: { twist: 15 },
    shoulderR: { forward: 85, out: 10 }, elbowR: { bend: 4 }, shoulderL: { out: 8 }, elbowL: { bend: 12 },
    hipL: { forward: 6 }, kneeL: { bend: 8 },
  },
  'Thinking': {
    head: { bend: 12, side: 4 }, chest: { bend: 4 },
    shoulderR: { forward: 38, out: -6 }, elbowR: { bend: 145 }, wristR: { bend: -20 },
    shoulderL: { forward: 22, out: -4, twist: 30 }, elbowL: { bend: 95 },
  },
  // The pelvis tips forward; the hip joints turn the other way so the legs stay upright.
  'Bending over': {
    hips: { bend: 55 }, spine: { bend: 18 }, chest: { bend: 14 }, head: { bend: -30 },
    hipL: { forward: 50 }, hipR: { forward: 50 }, kneeL: { bend: 10 }, kneeR: { bend: 10 },
    shoulderL: { forward: 20, out: 6 }, shoulderR: { forward: 20, out: 6 }, elbowL: { bend: 10 }, elbowR: { bend: 10 },
  },
  'Arms up, cheering': {
    chest: { bend: -6 }, head: { bend: -15 },
    shoulderL: { out: 150, forward: 15 }, shoulderR: { out: 150, forward: 15 }, elbowL: { bend: 20 }, elbowR: { bend: 20 },
  },
};

// ---------- Building the figure ----------

// Measurements in metres for a figure about 1.8 m tall.
const BODY = {
  hipsY: 0.96,
};

export function buildFigure(material) {
  const root = new THREE.Group();     // stands on the floor; turning it turns the whole figure
  const joints = {};
  const parts = [];                   // every visible piece, for clicking and highlighting

  const joint = (name, parent, x, y, z) => {
    const g = new THREE.Group();
    g.name = name;
    g.position.set(x, y, z);
    g.rotation.order = 'ZXY';
    parent.add(g);
    joints[name] = g;
    return g;
  };
  // A body piece belonging to a joint (clicking it selects that joint).
  const part = (jointName, geometry, x, y, z, sx = 1, sy = 1, sz = 1) => {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.joint = jointName;
    joints[jointName].add(m);
    parts.push(m);
    return m;
  };
  const ball = (r) => new THREE.SphereGeometry(r, 24, 16);
  const capsule = (r, len) => new THREE.CapsuleGeometry(r, len, 6, 16);

  const hips = joint('hips', root, 0, BODY.hipsY, 0);
  part('hips', ball(1), 0, 0, 0, 0.165, 0.11, 0.11);

  const spine = joint('spine', hips, 0, 0.07, 0);
  part('spine', capsule(0.1, 0.1), 0, 0.09, 0, 1, 1, 0.85);

  const chest = joint('chest', spine, 0, 0.18, 0);
  part('chest', ball(1), 0, 0.14, 0, 0.17, 0.18, 0.11);

  const neck = joint('neck', chest, 0, 0.3, 0);
  part('neck', capsule(0.042, 0.06), 0, 0.04, 0);

  const head = joint('head', neck, 0, 0.09, 0);
  part('head', ball(1), 0, 0.1, 0.005, 0.088, 0.115, 0.102);
  part('head', ball(1), 0, 0.075, 0.098, 0.018, 0.026, 0.02);  // a small nose, to show which way it faces

  for (const [side, sx] of [['L', 1], ['R', -1]]) {
    const shoulder = joint(`shoulder${side}`, chest, 0.19 * sx, 0.245, 0);
    part(`shoulder${side}`, ball(0.055), 0, 0, 0);
    part(`shoulder${side}`, capsule(0.045, 0.2), 0, -0.15, 0);
    const elbow = joint(`elbow${side}`, shoulder, 0, -0.3, 0);
    part(`elbow${side}`, ball(0.04), 0, 0, 0);
    part(`elbow${side}`, capsule(0.038, 0.17), 0, -0.13, 0);
    const wrist = joint(`wrist${side}`, elbow, 0, -0.265, 0);
    part(`wrist${side}`, ball(1), 0, -0.075, 0.005, 0.024, 0.075, 0.045);

    const hip = joint(`hip${side}`, hips, 0.095 * sx, -0.07, 0);
    part(`hip${side}`, ball(0.068), 0, 0, 0);
    part(`hip${side}`, capsule(0.064, 0.28), 0, -0.22, 0);
    const knee = joint(`knee${side}`, hip, 0, -0.44, 0);
    part(`knee${side}`, ball(0.052), 0, 0, 0);
    part(`knee${side}`, capsule(0.05, 0.3), 0, -0.21, 0);
    const ankle = joint(`ankle${side}`, knee, 0, -0.43, 0);
    part(`ankle${side}`, ball(1), 0, -0.035, 0.055, 0.045, 0.035, 0.12);
  }

  return { root, joints, parts };
}

// Put every joint into a plain-language pose.
export function applyPose(figure, pose) {
  const rotations = poseToRotations(pose);
  for (const [name, e] of Object.entries(rotations)) figure.joints[name].rotation.set(e.x, e.y, e.z, 'ZXY');
  figure.root.rotation.y = THREE.MathUtils.degToRad(Number(pose.turn) || 0);
}

// Joint rotations as plain numbers (for saving), and back.
export function readRotations(figure) {
  const out = {};
  for (const [name, j] of Object.entries(figure.joints)) out[name] = j.quaternion.toArray().map((v) => Math.round(v * 1e5) / 1e5);
  out.turn = Math.round(figure.root.rotation.y * 1e5) / 1e5;
  return out;
}
export function writeRotations(figure, data) {
  for (const [name, j] of Object.entries(figure.joints)) if (Array.isArray(data[name])) j.quaternion.fromArray(data[name]);
  figure.root.rotation.y = Number(data.turn) || 0;
}

// Swap left and right, so the pose becomes its mirror image.
export function mirror(figure) {
  const flip = (q) => new THREE.Quaternion(q.x, -q.y, -q.z, q.w);
  const qs = {};
  for (const [name, j] of Object.entries(figure.joints)) qs[name] = j.quaternion.clone();
  for (const name of Object.keys(figure.joints)) {
    const other = name.endsWith('L') ? name.slice(0, -1) + 'R' : name.endsWith('R') ? name.slice(0, -1) + 'L' : name;
    figure.joints[name].quaternion.copy(flip(qs[other]));
  }
  figure.root.rotation.y = -figure.root.rotation.y;
}

// Keep the figure standing on the floor: move it up or down so its lowest point touches y = 0.
const box = new THREE.Box3();
export function standOnFloor(figure) {
  figure.root.position.y = 0;
  figure.root.updateMatrixWorld(true);
  box.makeEmpty();
  for (const p of figure.parts) box.expandByObject(p, true);
  figure.root.position.y = -box.min.y;
  figure.root.updateMatrixWorld(true);
}
