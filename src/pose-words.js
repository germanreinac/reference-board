// Free typed poses: turns a description like "kneeling on one knee, looking left,
// arms crossed" into a mannequin pose, entirely in the browser (no AI, no cost).
//
// How it reads a description:
//   1. A base pose: the first activity word it recognises (sitting, running, lunge, ...).
//      With no activity word, it starts from the current pose, so "now look up" works.
//   2. Changes on top, for each body part it recognises (looking left, arms crossed, ...).
//   3. Strength: "slightly" / "a bit" halves a change, "very" / "a lot" makes it bigger.
//
// Left and right for body parts are the figure's own ("left arm up").
// "Facing left" means turned toward the left of the screen.

import { PRESETS } from './mannequin.js';

// ---------- Small helpers for building poses ----------

const clone = (p) => JSON.parse(JSON.stringify(p || {}));
const SIDES = { L: 'L', R: 'R' };

// Swap left and right, so a pose becomes its mirror image.
export function mirrorPose(pose) {
  const out = {};
  for (const [k, v] of Object.entries(pose)) {
    if (k === 'turn') { out.turn = -(v || 0); continue; }
    const other = k.endsWith('L') ? k.slice(0, -1) + 'R' : k.endsWith('R') ? k.slice(0, -1) + 'L' : k;
    const val = { ...v };
    // Spine joints are shared by both sides: their sideways tilt and twist flip.
    if (other === k) { if ('side' in val) val.side = -val.side; if ('twist' in val) val.twist = -val.twist; }
    out[other] = val;
  }
  return out;
}

const set = (pose, joint, values) => { pose[joint] = { ...(pose[joint] || {}), ...values }; };
const add = (pose, joint, values, k = 1) => {
  pose[joint] = { ...(pose[joint] || {}) };
  for (const [n, v] of Object.entries(values)) pose[joint][n] = (pose[joint][n] || 0) + v * k;
};
const scale = (values, k) => Object.fromEntries(Object.entries(values).map(([n, v]) => [n, v * k]));
const sidesOf = (side) => (side === 'both' ? ['L', 'R'] : [side]);

// ---------- Base poses ----------
// words: what to look for. side: which side the one-sided version uses by default,
// so "kneeling on the left knee" can mirror it. priority: 2 for very specific poses that
// should win over general ones ("hugging knees" over "sitting"), 0 for the most general.
// arms: an arm action (pointing, waving...)
// that only changes the arms and head, on top of whatever the body is doing.

const BASES = [
  { name: 'Lying on the back', words: ['lying on (?:his |her |their |the )?back', 'lying down', 'laying down', 'on (?:his |her |their |the )?back', 'lying face up'],
    pose: { hips: { bend: -90 }, shoulderL: { out: 12 }, shoulderR: { out: 12 }, head: { bend: 8 } } },
  { name: 'Lying on the front', words: ['lying on (?:his |her |their |the )?(?:front|stomach|belly)', 'face down', 'prone'],
    pose: { hips: { bend: 90 }, head: { bend: -25 }, shoulderL: { forward: 30, out: 40 }, shoulderR: { forward: 30, out: 40 }, elbowL: { bend: 60 }, elbowR: { bend: 60 } } },
  { name: 'Lying on the side', words: ['lying on (?:his |her |their |the |one )?side', 'sleeping', 'curled up', 'fetal'], side: 'L',
    pose: { hips: { side: 90 }, hipL: { forward: 50 }, hipR: { forward: 40 }, kneeL: { bend: 70 }, kneeR: { bend: 60 }, shoulderL: { forward: 80 }, shoulderR: { forward: 50 }, elbowL: { bend: 60 }, elbowR: { bend: 80 }, head: { side: -20 } } },
  { name: 'Cross-legged', priority: 2, words: ['cross[- ]?legged', 'lotus', 'meditat\\w*', 'indian style'],
    pose: { spine: { bend: 6 }, hipL: { forward: 95, out: 40, twist: 85 }, hipR: { forward: 95, out: 40, twist: 85 }, kneeL: { bend: 155 }, kneeR: { bend: 155 }, shoulderL: { forward: 25, out: 8 }, shoulderR: { forward: 25, out: 8 }, elbowL: { bend: 45 }, elbowR: { bend: 45 } } },
  { name: 'Hugging knees', priority: 2, words: ['hugging (?:his |her |their |the )?knees', 'knees to (?:the )?chest', 'arms around (?:his |her |their |the )?(?:knees|legs)'],
    pose: { spine: { bend: 28 }, chest: { bend: 14 }, head: { bend: -6 }, hipL: { forward: 120, out: 6 }, hipR: { forward: 120, out: 6 }, kneeL: { bend: 145 }, kneeR: { bend: 145 }, ankleL: { bend: 10 }, ankleR: { bend: 10 }, shoulderL: { forward: 70, out: -6, twist: -30 }, shoulderR: { forward: 70, out: -6, twist: -30 }, elbowL: { bend: 75 }, elbowR: { bend: 75 } } },
  { name: 'Sitting on the floor', words: ['sitting on the (?:floor|ground)', 'seated on the (?:floor|ground)', 'sitting, knees up', 'knees up'],
    pose: PRESETS['Sitting, knees up'] },
  { name: 'Sitting on the heels', priority: 2, words: ['sitting on (?:his |her |their |the )?heels', 'seiza', 'kneeling sitting'],
    pose: { kneeL: { bend: 155 }, kneeR: { bend: 155 }, hipL: { forward: 20 }, hipR: { forward: 20 }, ankleL: { bend: -40 }, ankleR: { bend: -40 }, shoulderL: { forward: 25 }, shoulderR: { forward: 25 }, elbowL: { bend: 55 }, elbowR: { bend: 55 } } },
  { name: 'Sitting', priority: 0, words: ['sitting', 'seated', 'sits', 'sit down', 'on a chair'], pose: PRESETS['Sitting on a chair'] },
  { name: 'Kneeling on one knee', words: ['on one knee', 'kneeling on (?:his |her |their |the )?(?:left|right) knee', 'proposing', 'taking a knee'], side: 'R',
    pose: PRESETS['Kneeling on one knee'] },
  { name: 'Superhero landing', priority: 2, words: ['superhero landing', 'hero landing', 'landing'], side: 'R',
    pose: { spine: { bend: 30 }, chest: { bend: 12 }, head: { bend: -30 }, hipL: { forward: 95, out: 10 }, kneeL: { bend: 120 }, hipR: { forward: -10, out: 15 }, kneeR: { bend: 100 }, ankleR: { bend: -30 },
      shoulderR: { forward: 75, out: 10 }, elbowR: { bend: 5 }, shoulderL: { forward: -20, out: 40 }, elbowL: { bend: 20 } } },
  { name: 'Kneeling', words: ['kneeling', 'kneels', 'on (?:his |her |their |the |both )?knees'],
    pose: { kneeL: { bend: 90 }, kneeR: { bend: 90 }, ankleL: { bend: -35 }, ankleR: { bend: -35 }, shoulderL: { out: 8 }, shoulderR: { out: 8 }, elbowL: { bend: 15 }, elbowR: { bend: 15 } } },
  { name: 'Crouching', words: ['crouch\\w*', 'squat\\w*', 'hunker\\w*'], pose: PRESETS.Crouching },
  { name: 'Sneaking', words: ['sneak\\w*', 'creep\\w*', 'stealth\\w*', 'tiptoe\\w*'], side: 'L',
    pose: { spine: { bend: 20 }, chest: { bend: 10 }, head: { bend: -15 }, hipL: { forward: 40 }, kneeL: { bend: 50 }, hipR: { forward: -5 }, kneeR: { bend: 45 }, ankleR: { bend: -20 },
      shoulderL: { forward: 30, out: 20 }, shoulderR: { forward: 30, out: 20 }, elbowL: { bend: 80 }, elbowR: { bend: 80 }, wristL: { bend: 30 }, wristR: { bend: 30 } } },
  { name: 'Lunge', words: ['lung(?:e|es|ing)'], side: 'L',
    pose: { spine: { bend: 4 }, hipL: { forward: 75 }, kneeL: { bend: 85 }, ankleL: { bend: 10 }, hipR: { forward: -35 }, kneeR: { bend: 12 }, ankleR: { bend: -15 },
      shoulderL: { out: 10 }, shoulderR: { out: 10 }, elbowL: { bend: 20 }, elbowR: { bend: 20 } } },
  { name: 'Running', words: ['run\\w*', 'sprint\\w*', 'jog\\w*', 'dash\\w*', 'chas\\w*'], side: 'L', pose: PRESETS.Running },
  { name: 'Jumping', words: ['jump\\w*', 'leap\\w*', 'hop(?:s|ping)?'],
    pose: { spine: { bend: 6 }, head: { bend: -12 }, hipL: { forward: 50, out: 6 }, hipR: { forward: 30, out: 6 }, kneeL: { bend: 85 }, kneeR: { bend: 60 }, ankleL: { bend: -30 }, ankleR: { bend: -30 },
      shoulderL: { forward: 150, out: 25 }, shoulderR: { forward: 150, out: 25 }, elbowL: { bend: 15 }, elbowR: { bend: 15 } } },
  { name: 'Walking', words: ['walk\\w*', 'stroll\\w*', 'step(?:ping)? forward', 'striding', 'stride'], side: 'L', pose: PRESETS.Walking },
  { name: 'Kicking', words: ['kick\\w*'], side: 'R',
    pose: { spine: { bend: -12 }, chest: { bend: -6 }, head: { bend: 6 }, hipR: { forward: 95 }, kneeR: { bend: 10 }, ankleR: { bend: -20 }, hipL: { out: 4 }, kneeL: { bend: 12 },
      shoulderL: { forward: 45, out: 30 }, elbowL: { bend: 100 }, shoulderR: { forward: -20, out: 45 }, elbowR: { bend: 60 } } },
  { name: 'Punching', words: ['punch\\w*', 'jab\\w*', 'strik(?:e|ing)', 'boxing', 'boxer'], side: 'R',
    pose: { hips: { twist: 15 }, chest: { twist: 20 }, head: { twist: -25 }, hipL: { forward: 22, out: 8 }, kneeL: { bend: 25 }, hipR: { forward: -15, out: 10 }, kneeR: { bend: 20 }, ankleR: { bend: -15 },
      shoulderR: { forward: 85, out: 5, twist: -10 }, elbowR: { bend: 3 }, shoulderL: { forward: 55, out: 20, twist: 10 }, elbowL: { bend: 125 } } },
  { name: 'Sword swing', words: ['sword swing', 'swing(?:ing)? (?:a |the |his |her |their )?(?:sword|axe|bat|hammer|weapon)', 'slash\\w*', 'chopping'],
    pose: { hips: { twist: 20 }, chest: { twist: 35, side: 8 }, spine: { bend: 6 }, head: { twist: -30 }, hipL: { forward: 25, out: 12 }, kneeL: { bend: 25 }, hipR: { forward: -15, out: 14 }, kneeR: { bend: 20 },
      shoulderL: { forward: 150, out: -10, twist: -20 }, elbowL: { bend: 30 }, shoulderR: { forward: 150, out: -15, twist: -20 }, elbowR: { bend: 40 } } },
  { name: 'Holding a sword', words: ['holding (?:a |the |his |her |their )?(?:sword|katana|spear|staff|weapon)', 'en garde', 'guard stance'],
    pose: { hips: { twist: 15 }, chest: { twist: -10 }, hipL: { forward: 20, out: 10 }, kneeL: { bend: 22 }, hipR: { forward: -12, out: 12 }, kneeR: { bend: 22 },
      shoulderL: { forward: 50, out: -10, twist: -30 }, elbowL: { bend: 70 }, shoulderR: { forward: 45, out: -14, twist: -35 }, elbowR: { bend: 75 } } },
  { name: 'Drawing a bow', words: ['bow and arrow', 'archer\\w*', 'drawing (?:a |the )?bow', 'shooting (?:a |an )?(?:bow|arrow)'],
    pose: { turn: -70, chest: { twist: 70 }, head: { twist: 75 }, hipL: { out: 12 }, hipR: { out: 12 },
      shoulderL: { out: 90, forward: 0 }, elbowL: { bend: 0 }, shoulderR: { out: 90, forward: 0, twist: 90 }, elbowR: { bend: 150 } } },
  { name: 'Throwing', words: ['throw\\w*', 'pitch(?:ing|er)', 'toss\\w*'], side: 'R',
    pose: { hips: { twist: -20 }, chest: { twist: -30, bend: -6 }, head: { twist: 25 }, hipL: { forward: 35, out: 6 }, kneeL: { bend: 15 }, hipR: { forward: -15 }, kneeR: { bend: 25 },
      shoulderR: { out: 100, forward: -20, twist: 80 }, elbowR: { bend: 95 }, shoulderL: { forward: 70, out: 20 }, elbowL: { bend: 20 } } },
  { name: 'Fighting stance', words: ['fight\\w*', 'combat', 'martial arts?', 'ready to fight', 'battle'], pose: PRESETS['Fighting stance'] },
  { name: 'Bending over', words: ['bend(?:ing)? over', 'bent over', 'picking (?:something )?up', 'pick(?:ing)? up', 'touching (?:his |her |their |the )?toes'], pose: PRESETS['Bending over'] },
  { name: 'Pushing', words: ['push\\w*', 'shov\\w*'],
    pose: { spine: { bend: 20 }, chest: { bend: 6 }, head: { bend: -15 }, hipL: { forward: 35 }, kneeL: { bend: 35 }, hipR: { forward: -30 }, kneeR: { bend: 5 }, ankleR: { bend: -10 },
      shoulderL: { forward: 85, out: 8 }, shoulderR: { forward: 85, out: 8 }, elbowL: { bend: 25 }, elbowR: { bend: 25 }, wristL: { bend: -60 }, wristR: { bend: -60 } } },
  { name: 'Pulling', words: ['pull\\w*', 'tug\\w*', 'hauling'],
    pose: { spine: { bend: -12 }, chest: { bend: -6 }, hipL: { forward: 25 }, kneeL: { bend: 30 }, hipR: { forward: -5 }, kneeR: { bend: 25 },
      shoulderL: { forward: 75, out: 5 }, shoulderR: { forward: 75, out: 5 }, elbowL: { bend: 35 }, elbowR: { bend: 35 } } },
  { name: 'Carrying', arms: true, words: ['carry\\w*', 'holding (?:a |an |the )?(?:box|baby|bag|something heavy|load)', 'lifting (?:a |an |the |something)'],
    pose: { spine: { bend: -6 }, chest: { bend: -4 }, shoulderL: { forward: 35, out: 6, twist: -15 }, shoulderR: { forward: 35, out: 6, twist: -15 }, elbowL: { bend: 85 }, elbowR: { bend: 85 }, kneeL: { bend: 8 }, kneeR: { bend: 8 } } },
  { name: 'Dancing', words: ['danc\\w*', 'ballet', 'twirl\\w*'], side: 'L',
    pose: { hips: { side: -6, twist: 10 }, chest: { side: 8, twist: -10 }, head: { side: 8, bend: -10 }, hipL: { forward: 30, out: 25, twist: 40 }, kneeL: { bend: 60 }, ankleL: { bend: -35 }, ankleR: { bend: -25 },
      shoulderL: { out: 150, forward: 10 }, elbowL: { bend: 30 }, shoulderR: { out: 70, forward: 20 }, elbowR: { bend: 40 } } },
  { name: 'Tree pose', words: ['tree pose', 'standing on one leg', 'one leg', 'flamingo', 'yoga'], side: 'L',
    pose: { hipL: { forward: 20, out: 55, twist: 60 }, kneeL: { bend: 140 }, shoulderL: { forward: 175, out: 5 }, shoulderR: { forward: 175, out: 5 }, elbowL: { bend: 10 }, elbowR: { bend: 10 } } },
  { name: 'Stretching', words: ['stretch\\w*', 'yawn\\w*'],
    pose: { chest: { bend: -10 }, head: { bend: -20 }, shoulderL: { forward: 170, out: 15 }, shoulderR: { forward: 170, out: 15 }, elbowL: { bend: 15 }, elbowR: { bend: 15 }, ankleL: { bend: -15 }, ankleR: { bend: -15 } } },
  { name: 'Cheering', arms: true, words: ['cheer\\w*', 'celebrat\\w*', 'victory', 'triumph\\w*', 'winning'], pose: PRESETS['Arms up, cheering'] },
  { name: 'Reaching up', arms: true, words: ['reach(?:ing)? up', 'reaching for', 'reaching high'], side: 'R', pose: PRESETS['Reaching up'] },
  { name: 'Pointing', arms: true, words: ['point(?:s|ing)?'], side: 'R', pose: PRESETS.Pointing },
  { name: 'Waving', arms: true, words: ['wav(?:e|es|ing)', 'saying (?:hi|hello|goodbye)', 'greeting'], side: 'R',
    pose: { head: { side: -5 }, shoulderR: { out: 80, forward: 10, twist: 90 }, elbowR: { bend: 100 }, shoulderL: { out: 8 }, elbowL: { bend: 10 } } },
  { name: 'Praying', arms: true, words: ['pray\\w*', 'hands together', 'palms together'],
    pose: { head: { bend: 15 }, shoulderL: { forward: 30, out: -6, twist: -50 }, shoulderR: { forward: 30, out: -6, twist: -50 }, elbowL: { bend: 120 }, elbowR: { bend: 120 } } },
  { name: 'Thinking', arms: true, words: ['think\\w*', 'ponder\\w*', 'hand on (?:his |her |their |the )?chin', 'contemplat\\w*'], side: 'R', pose: PRESETS.Thinking },
  { name: 'Contrapposto', priority: 0, words: ['contrapposto', 'relaxed', 'casual', 'weight shift\\w*', 'hip out'], side: 'R', pose: PRESETS.Contrapposto },
  { name: 'T-pose', words: ['t[- ]pose'], pose: PRESETS['T-pose'] },
  { name: 'A-pose', words: ['a[- ]pose'], pose: PRESETS['A-pose'] },
  { name: 'Standing', priority: 0, words: ['stand\\w*', 'idle', 'upright', 'neutral'], pose: PRESETS.Standing },
];

// ---------- Body-part changes ----------
// Each looks for its words; `side` is which body side it applies to (worked out
// from "left" / "right" / "both" next to the words), `k` is the strength.

const ARM_SIDE = 'R';  // when someone says "arm up" without a side, use the right arm

const CHANGES = [
  // Head
  { name: 'looking over the shoulder', words: ['(?:looking|look|glancing) (?:back )?over (?:his |her |their |the )?(left|right) shoulder'], side: 'captured',
    apply: (p, side, k) => { const s = side === 'R' ? -1 : 1; set(p, 'head', { twist: 70 * s * k, bend: 5 }); set(p, 'neck', { twist: 25 * s * k }); add(p, 'chest', { twist: 15 * s }, k); } },
  { name: 'looking left', words: ['(?:looking|look|looks|glancing|turning (?:his |her |their |the )?head|head turned) (?:to (?:the |his |her |their )?)?left'],
    apply: (p, _s, k) => { set(p, 'head', { twist: 40 * k }); set(p, 'neck', { twist: 15 * k }); } },
  { name: 'looking right', words: ['(?:looking|look|looks|glancing|turning (?:his |her |their |the )?head|head turned) (?:to (?:the |his |her |their )?)?right'],
    apply: (p, _s, k) => { set(p, 'head', { twist: -40 * k }); set(p, 'neck', { twist: -15 * k }); } },
  { name: 'looking up', words: ['(?:looking|look|looks|gazing|staring) up', 'head (?:up|back|tilted back)', 'chin up', 'up at the sky'],
    apply: (p, _s, k) => { set(p, 'head', { bend: -30 * k }); set(p, 'neck', { bend: -12 * k }); } },
  { name: 'looking down', words: ['(?:looking|look|looks|gazing|staring) down', 'head down', 'head bowed', 'chin down', 'at (?:the |his |her |their )?(?:floor|ground|feet)'],
    apply: (p, _s, k) => { set(p, 'head', { bend: 30 * k }); set(p, 'neck', { bend: 15 * k }); } },
  { name: 'head tilted', words: ['head tilt(?:ed)?(?: to the)?(?: (left|right))?', 'tilt(?:ing|ed)? (?:his |her |their |the )?head(?: to the)?(?: (left|right))?', 'curious'], side: 'captured',
    apply: (p, side, k) => set(p, 'head', { side: (side === 'R' ? -15 : 15) * k }) },

  // Arms (most specific first)
  { name: 'arms crossed', words: ['arms? (?:are )?(?:crossed|folded)', '(?:crossed|folded|crossing|folding) (?:his |her |their |the )?arms'],
    apply: (p) => { for (const s of ['L', 'R']) { set(p, `shoulder${s}`, { forward: 28, out: -4, twist: -65 }); set(p, `elbow${s}`, { bend: 115 }); } } },
  { name: 'hands on hips', words: ['hands? on (?:his |her |their |the )?(?:hips?|waist)', 'akimbo'], side: 'near-both',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { out: 42, forward: -12, twist: -95 }); set(p, `elbow${s}`, { bend: 95 }); } } },
  { name: 'hands behind the head', words: ['hands? behind (?:his |her |their |the )?head', 'hands? on (?:his |her |their |the )?head'], side: 'near-both',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { out: 130, forward: 15, twist: 100 }); set(p, `elbow${s}`, { bend: 150 }); } } },
  { name: 'arms behind the back', words: ['(?:arms?|hands?) behind (?:his |her |their |the )?back', 'hands clasped behind'],
    apply: (p) => { for (const s of ['L', 'R']) { set(p, `shoulder${s}`, { forward: -25, out: 8, twist: -40 }); set(p, `elbow${s}`, { bend: 70 }); } } },
  { name: 'hand on the chest', words: ['hand on (?:his |her |their |the )?(?:chest|heart)'], side: 'near',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { forward: 35, out: -8, twist: -45 }); set(p, `elbow${s}`, { bend: 125 }); } } },
  { name: 'shielding the eyes', words: ['shield(?:ing)? (?:his |her |their |the )?eyes', 'hand (?:over|above) (?:his |her |their |the )?eyes', 'looking into the distance'], side: 'near',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { forward: 80, out: 30, twist: 10 }); set(p, `elbow${s}`, { bend: 135 }); set(p, `wrist${s}`, { bend: 20 }); } } },
  { name: 'arm up', words: ['(?:arms?|hands?) (?:up|raised|in the air|overhead|above (?:his |her |their |the )?head)', '(?:raising|raised|raise|lifting|lift|holding up) (?:his |her |their |the |one |both )?(?:left |right )?(?:arms?|hands?)'], side: 'near',
    apply: (p, side, k) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { forward: 165 * k, out: 12 }); set(p, `elbow${s}`, { bend: 12 }); } } },
  { name: 'arms out', words: ['arms? (?:out|outstretched|spread|wide|open)', '(?:outstretched|open|spread) arms?', 'arms? to the sides?'], side: 'near-both',
    apply: (p, side, k) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { out: 88 * k, forward: 5 }); set(p, `elbow${s}`, { bend: 5 }); } } },
  { name: 'reaching forward', words: ['reach(?:ing)? (?:forward|out)', '(?:arms?|hands?) (?:forward|in front)', 'offering'], side: 'near',
    apply: (p, side, k) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { forward: 85 * k, out: 5 }); set(p, `elbow${s}`, { bend: 10 }); } } },
  { name: 'arms down', words: ['arms? (?:down|at (?:his |her |their |the )?sides?|hanging)'], side: 'near-both',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { forward: 0, out: 6, twist: 0 }); set(p, `elbow${s}`, { bend: 8 }); } } },
  { name: 'hands in pockets', words: ['hands? in (?:his |her |their |the )?pockets?'], side: 'near-both',
    apply: (p, side) => { for (const s of sidesOf(side)) { set(p, `shoulder${s}`, { out: 14, forward: -8, twist: -20 }); set(p, `elbow${s}`, { bend: 30 }); } } },

  // Torso
  { name: 'leaning forward', words: ['lean(?:ing|s)? (?:in|forward)', 'bending forward', 'hunched forward'],
    apply: (p, _s, k) => { add(p, 'spine', { bend: 14 }, k); add(p, 'chest', { bend: 10 }, k); add(p, 'head', { bend: -10 }, k); } },
  { name: 'leaning back', words: ['lean(?:ing|s)? back(?:ward)?', 'arching (?:his |her |their |the )?back', 'arched back'],
    apply: (p, _s, k) => { add(p, 'spine', { bend: -14 }, k); add(p, 'chest', { bend: -10 }, k); add(p, 'head', { bend: 6 }, k); } },
  { name: 'leaning to one side', words: ['lean(?:ing|s)? (?:to (?:the |his |her |their )?)?(left|right)', 'bend(?:ing)? (?:to (?:the |his |her |their )?)?(left|right)'], side: 'captured',
    apply: (p, side, k) => { const s = side === 'R' ? -1 : 1; add(p, 'spine', { side: 12 * s }, k); add(p, 'chest', { side: 10 * s }, k); add(p, 'head', { side: -8 * s }, k); } },
  { name: 'twisting', words: ['twist(?:ing|ed)?(?: (?:to (?:the |his |her |their )?)?(left|right))?', 'turning (?:his |her |their |the )?(?:body|torso|waist)(?: (?:to (?:the )?)?(left|right))?'], side: 'captured',
    apply: (p, side, k) => { const s = side === 'R' ? -1 : 1; add(p, 'spine', { twist: 15 * s }, k); add(p, 'chest', { twist: 22 * s }, k); } },
  { name: 'slouching', words: ['slouch\\w*', 'hunched', 'tired', 'sad', 'depressed', 'defeated', 'exhausted'],
    apply: (p, _s, k) => { add(p, 'spine', { bend: 12 }, k); add(p, 'chest', { bend: 14 }, k); add(p, 'neck', { bend: 15 }, k); add(p, 'head', { bend: 10 }, k); for (const s of ['L', 'R']) add(p, `shoulder${s}`, { forward: 8 }, k); } },
  { name: 'proud', words: ['proud', 'confident', 'heroic', 'chest out', 'puffed up'],
    apply: (p, _s, k) => { add(p, 'chest', { bend: -10 }, k); add(p, 'head', { bend: -8 }, k); for (const s of ['L', 'R']) add(p, `shoulder${s}`, { forward: -6, out: 6 }, k); } },

  // Legs
  { name: 'weight on one leg', words: ['weight on (?:the |his |her |their )?(left|right)(?: leg| foot)?', 'standing on (?:the |his |her |their )?(left|right) (?:leg|foot)'], side: 'captured',
    apply: (p, side) => { const pose = clone(PRESETS.Contrapposto); const use = side === 'L' ? mirrorPose(pose) : pose;
      for (const j of ['hips', 'hipL', 'hipR', 'kneeL', 'kneeR', 'ankleL', 'ankleR']) p[j] = { ...use[j] }; } },
  { name: 'knee up', words: ['(left|right)? ?knee (?:up|raised|lifted)', 'lifting (?:his |her |their |the |one )?(left |right )?(?:knee|leg)', 'leg (?:up|raised)'], side: 'captured-or-L',
    apply: (p, side, k) => { const s = side === 'R' ? 'R' : 'L'; set(p, `hip${s}`, { forward: 85 * k, out: 4 }); set(p, `knee${s}`, { bend: 95 * k }); set(p, `ankle${s}`, { bend: -15 }); } },
  { name: 'wide stance', words: ['wide stance', 'legs? (?:apart|wide|spread)', 'feet (?:apart|wide)', 'power stance'],
    apply: (p, _s, k) => { for (const s of ['L', 'R']) add(p, `hip${s}`, { out: 16 }, k); } },
  { name: 'feet together', words: ['feet together', 'legs together', 'at attention'],
    apply: (p) => { for (const s of ['L', 'R']) set(p, `hip${s}`, { out: 0, twist: 0 }); } },
  { name: 'on tiptoe', words: ['on (?:his |her |their )?(?:tip ?toes?|toes)', 'tiptoe'],
    apply: (p) => { for (const s of ['L', 'R']) set(p, `ankle${s}`, { bend: -30 }); } },

  // Facing (relative to the screen)
  { name: 'facing away', words: ['facing away', 'from behind', 'back view', 'seen from (?:the )?back', 'back to (?:the )?(?:viewer|camera)', 'rear view'],
    apply: (p) => { p.turn = 180; } },
  { name: 'facing left', words: ['facing (?:to (?:the )?)?left', 'profile (?:to the )?left', 'side view', 'in profile', 'profile'],
    apply: (p) => { p.turn = -90; } },
  { name: 'facing right', words: ['facing (?:to (?:the )?)?right', 'profile (?:to the )?right'],
    apply: (p) => { p.turn = 90; } },
  { name: 'three-quarter view', words: ['three[- ]quarters?(?: view)?', '3/4(?: view)?'],
    apply: (p) => { p.turn = 35; } },
  { name: 'facing the viewer', words: ['front view', 'facing forward', 'from the front'],
    apply: (p) => { p.turn = 0; } },

  // Last, so it can undo whatever turn the body has.
  { name: 'looking at the viewer', words: ['looking at (?:the )?(?:viewer|camera|us|me)', 'facing (?:the )?(?:viewer|camera)'],
    apply: (p) => { const t = -(p.turn || 0) - (p.chest?.twist || 0) - (p.spine?.twist || 0) - (p.hips?.twist || 0); set(p, 'head', { twist: Math.max(-70, Math.min(70, t)) }); } },
];

// ---------- Reading a description ----------

const SOFT = /\b(slightly|a (?:little|bit|touch)|subtly|gently|barely|somewhat|kind of)\b/;
const STRONG = /\b(very|a lot|really|fully|extremely|dramatically|far|deeply|all the way|way)\b/;

// Words near a match that say which side: "left arm", "the right knee", "both hands".
function sideNear(text, start, end) {
  const before = text.slice(Math.max(0, start - 24), start);
  const inside = text.slice(start, end);
  const after = text.slice(end, end + 18);
  const find = (s) => (/\bboth\b/.test(s) ? 'both' : /\bleft\b/.test(s) ? 'L' : /\bright\b/.test(s) ? 'R' : null);
  return find(inside) || find(before.split(/[,.;]/).pop()) || find(after.split(/[,.;]/)[0]) || null;
}

// How strong a change should be, from the words just before it.
function strengthNear(text, start) {
  const before = text.slice(Math.max(0, start - 22), start);
  if (SOFT.test(before)) return 0.5;
  if (STRONG.test(before)) return 1.35;
  return 1;
}

function normalise(description) {
  return ` ${String(description).toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9/\s,.;-]/g, ' ')
    .replace(/\bhes\b|\bshes\b|\btheyre\b/g, ' ')
    .replace(/\s+/g, ' ')} `;
}

// Returns { pose, understood: [what it recognised] } or null if it recognised nothing.
export function poseFromWords(description, currentPose) {
  const text = normalise(description);
  const understood = [];

  // 1. Base pose: the most specific body activity mentioned (by priority, then the
  //    longest match; if two are as long, the one mentioned first).
  let base = null;
  for (const b of BASES) {
    if (b.arms) continue;
    for (const w of b.words) {
      const m = new RegExp(`\\b(?:${w})\\b`).exec(text);
      if (!m) continue;
      const rank = (b.priority ?? 1) * 1000 + m[0].length;
      if (!base || rank > base.rank || (rank === base.rank && m.index < base.index)) {
        base = { b, index: m.index, match: m[0], rank };
      }
    }
  }
  let pose;
  if (base) {
    pose = clone(base.b.pose);
    // "kneeling on the left knee", "kicking with the left leg": mirror one-sided poses.
    if (base.b.side) {
      const side = sideNear(text, base.index, base.index + base.match.length + 14);
      if (side && side !== 'both' && side !== base.b.side) pose = mirrorPose(pose);
    }
    understood.push(base.b.name.toLowerCase());
  } else {
    pose = clone(currentPose || PRESETS.Standing);
  }

  // Arm actions (pointing, waving, praying...) change only the arms and head.
  for (const b of BASES) {
    if (!b.arms) continue;
    const m = b.words.map((w) => new RegExp(`\\b(?:${w})\\b`).exec(text)).find(Boolean);
    if (!m) continue;
    let arms = clone(b.pose);
    const side = sideNear(text, m.index, m.index + m[0].length + 14);
    if (b.side && side && side !== 'both' && side !== b.side) arms = mirrorPose(arms);
    for (const j of Object.keys(PRESETS.Standing).concat(['shoulderL', 'shoulderR', 'elbowL', 'elbowR', 'wristL', 'wristR', 'head', 'neck'])) {
      if (/^(shoulder|elbow|wrist|head|neck)/.test(j)) pose[j] = { ...(arms[j] || {}) };
    }
    understood.push(b.name.toLowerCase());
  }

  // 2. Changes on top.
  for (const c of CHANGES) {
    for (const w of c.words) {
      const re = new RegExp(`\\b(?:${w})\\b`, 'g');
      let m;
      let hit = false;
      while ((m = re.exec(text))) {
        let side;
        const captured = m.slice(1).find((g) => g && /left|right/.test(g));
        const capturedSide = captured ? (/left/.test(captured) ? 'L' : 'R') : null;
        if (c.side === 'captured') side = capturedSide || sideNear(text, m.index, m.index + m[0].length) || 'L';
        else if (c.side === 'captured-or-L') side = capturedSide || sideNear(text, m.index, m.index + m[0].length) || 'L';
        else if (c.side === 'near') side = sideNear(text, m.index, m.index + m[0].length) || (/\b(?:arms|hands|both)\b/.test(m[0]) ? 'both' : ARM_SIDE);
        else if (c.side === 'near-both') side = sideNear(text, m.index, m.index + m[0].length) || 'both';
        const k = strengthNear(text, m.index);
        c.apply(pose, side, k);
        if (!hit) {
          const oneSide = side && side !== 'both' && ['near', 'near-both'].includes(c.side);
          const label = oneSide ? `${side === 'L' ? 'left' : 'right'} ${c.name.replace(/^arms? /, 'arm ')}`
            : side === 'both' ? c.name.replace(/^arm /, 'arms ') : c.name;
          understood.push(k < 1 ? `${label} (a little)` : k > 1 ? `${label} (a lot)` : label);
          hit = true;
        }
        if (!re.global) break;
      }
      if (hit) break;
    }
  }

  if (!understood.length) return null;
  return { pose, understood };
}

// Some words it knows, for the "didn't understand" message.
export const EXAMPLE_WORDS = [
  'sitting', 'kneeling', 'on one knee', 'crouching', 'lying on the back', 'running', 'jumping', 'lunge', 'sword swing',
  'punching', 'archery', 'arms crossed', 'hands on hips', 'left arm up', 'looking left', 'looking over the right shoulder',
  'leaning forward', 'weight on the right leg', 'facing away', 'three-quarter view', 'slightly', 'a lot',
];
