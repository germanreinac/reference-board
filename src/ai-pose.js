// Typing a pose: Claude turns a description such as "sitting on the floor
// hugging her knees, looking left" into joint angles for the mannequin.
//
// It uses your own Anthropic API key, which is kept only in this browser and
// sent only to Anthropic. Each request costs a few cents on your Anthropic account.
//
// The reply is forced into a fixed JSON shape (every joint, every angle), so it
// can be applied straight to the figure. Angles are then kept within what a
// body can do (see limitPose in src/mannequin.js).

import { JOINTS, limitPose } from './mannequin.js';

const MODEL = 'claude-opus-5-5';

// The Anthropic SDK is only downloaded the first time you type a pose.
let sdk;
const loadSdk = () => (sdk ??= import('../vendor/anthropic-sdk.mjs'));

// The exact JSON shape Claude must answer with.
function poseSchema() {
  const properties = {
    summary: { type: 'string', description: 'A few words naming the pose, e.g. "Sitting, hugging knees"' },
    turn: { type: 'number', description: 'Whole-body turn in degrees; positive turns to the figure\'s left' },
  };
  for (const [joint, axes] of Object.entries(JOINTS)) {
    const names = Object.keys(axes);
    properties[joint] = {
      type: 'object',
      properties: Object.fromEntries(names.map((n) => [n, { type: 'number' }])),
      required: names,
      additionalProperties: false,
    };
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false };
}

const SYSTEM = `You pose a 3D wooden artist's mannequin for an artist's reference board.
The artist describes a pose; you answer with joint angles in degrees.

The figure:
- Stands on a floor and faces the viewer at turn 0. "L" and "R" are the figure's own left and right.
- It is kept standing on the floor automatically (its lowest point touches the floor), so you never set height.
- Angle 0 everywhere is standing straight with arms hanging at the sides.

Joints and their angles (all in degrees):
- hips: the pelvis, which carries the legs AND the upper body. bend (+ tips forward), side (+ tilts toward the figure's left), twist (+ turns toward the figure's left).
  Tilting the hips also tilts both legs. To bend over at the waist with straight legs, bend the hips forward and give both hipL and hipR the same "forward" value so the legs stay vertical.
- spine (waist), chest, neck, head: bend (+ forward, - leans back), side (+ toward the figure's left), twist (+ turns toward the figure's left). Spread big bends across spine, chest and neck.
- shoulderL / shoulderR: forward (+ raises the arm in front, 90 = pointing straight ahead, 180 = straight up), out (+ raises the arm out to the side, 90 = T-pose; negative swings it across the body), twist (+ rotates the arm outward).
- elbowL / elbowR: bend, 0 to 150 (0 = straight; the forearm comes forward and up).
- wristL / wristR: bend (+ toward the palm), side.
- hipL / hipR: forward (+ lifts the leg in front, 90 = thigh horizontal as when sitting; negative swings it back), out (+ moves the leg out to the side), twist (+ turns the knee outward).
- kneeL / kneeR: bend, 0 to 150 (0 = straight; the shin swings back).
- ankleL / ankleR: bend (+ toes up, - toes pointing down as on tiptoe).
- turn: turns the whole figure; positive turns toward the figure's left. Leave it at 0 unless the description asks which way the figure faces.

Examples:
- Sitting on a chair: hipL/hipR forward 88, kneeL/kneeR bend 88, shoulders forward 22, elbows bend 55.
- Walking: hipL forward 25, kneeL bend 8, hipR forward -18, kneeR bend 22, shoulderL forward -22, shoulderR forward 24, elbows bend 20-30, chest twist 8.
- Crouching: hips forward 115 with out 18, knees bend 140, ankles bend 28, spine bend 28, shoulders forward 50.

You are also given the current pose. If the description asks for a change ("raise the arm more", "now look left", "same but kneeling"), start from the current pose and change only what is asked. Otherwise make the pose from scratch.
Give natural, balanced poses with the weight believable over the feet, and add small asymmetries that make a pose feel alive, unless the artist asks for something stiff or symmetrical.
Answer with every joint and every angle, using 0 for anything that does not move.`;

// Ask Claude for a pose. Returns { pose, summary } or throws an Error with a friendly message.
export async function poseFromDescription(description, currentPose, apiKey) {
  const { default: Anthropic, AuthenticationError, PermissionDeniedError, RateLimitError, BadRequestError, APIConnectionError, APIError } = await loadSdk();
  // The key belongs to the person using the page and never leaves their browser
  // except to go to Anthropic, which is why browser use is allowed here.
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });

  let response;
  try {
    response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: `Current pose:\n${JSON.stringify(currentPose)}\n\nThe artist asks for: ${description}`,
      }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: poseSchema() } },
      // If a safety check declines the request, Anthropic retries it on a suitable model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
  } catch (err) {
    if (err instanceof AuthenticationError) throw new Error('Anthropic rejected the API key. Check it with the key button.');
    if (err instanceof PermissionDeniedError) throw new Error("This API key isn't allowed to use that model. Check your Anthropic account.");
    if (err instanceof RateLimitError) throw new Error('Too many requests right now. Wait a moment and try again.');
    if (err instanceof BadRequestError) throw new Error(`Anthropic couldn't process that request: ${err.message}`);
    if (err instanceof APIConnectionError) throw new Error("Couldn't reach Anthropic. Check your internet connection.");
    if (err instanceof APIError) throw new Error(`Anthropic had a problem (error ${err.status ?? '?'}). Try again in a moment.`);
    throw err;
  }

  if (response.stop_reason === 'refusal') throw new Error("Claude couldn't make that pose. Try describing it differently.");
  if (response.stop_reason === 'max_tokens') throw new Error('The answer was cut off. Try a shorter description.');
  const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("Claude's answer couldn't be read. Try again.");
  }
  return { pose: limitPose(data), summary: String(data.summary || '').slice(0, 80) };
}
