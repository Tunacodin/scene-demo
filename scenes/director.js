// director.js: automatic cutscene camera + acting for scene-kit episodes.
// Everything is a pure function of time t (no hidden state), so the same
// episode + seed renders the same frames in the browser and in a batch render.
import * as THREE from 'three';

const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const UP = V(0, 1, 0), DEG = Math.PI / 180;
const PRE = 1.8, GAP = 0.45, TAIL = 1.4, LEAD = 0.15;   // seconds

export function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const clamp01 = u => Math.min(1, Math.max(0, u));
const sine = u => 0.5 - 0.5 * Math.cos(Math.PI * clamp01(u));
const smooth = (a, b, x) => { const u = clamp01((x - a) / (b - a)); return u * u * (3 - 2 * u); };
const flat = v => { const r = v.clone(); r.y = 0; return r.normalize(); };
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const bone = (root, n) => { let b = null; root.traverse(o => { if (o.isBone && o.name === n) b = o; }); return b; };

// speech length estimate until real audio exists (slow A2 pace)
export const estDur = text => 0.75 + text.split(/\s+/).length * 0.4;

// Azure FacialExpression frame order (first 52 = ARKit names; 52..54 head/eye roll unused)
const AZ = ['eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
  'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut'];
const USE = AZ.map((n, i) => i).filter(i => !/eyeLook/.test(AZ[i]));   // eyes are aimed by bones instead
const J = { blinkL: 0, blinkR: 7, jaw: 17, smileL: 23, smileR: 24, browUp: 43, cheekL: 47, cheekR: 48, squintL: 5, squintR: 12 };
const hash = x => { const s = Math.sin(x * 12.9898) * 43758.5453; return s - Math.floor(s); };
const mod = (x, d) => ((x % d) + d) % d;

// Rigs disagree on how far a full-weight shape moves (Rocketbox smile ~3.5 mm, an ARKit face ~10 mm,
// one Rocketbox squint 19 mm vs 2.5 mm on the others). Measure each expression shape once and scale its
// weight so 1.0 means the same physical size on every character.
const NORM = { mouthSmileLeft: 10, mouthSmileRight: 10, cheekSquintLeft: 8, cheekSquintRight: 8, eyeSquintLeft: 4, eyeSquintRight: 4 };   // mm
function morphGains(o, d) {
  const g = new Array(52).fill(1), pos = o.geometry.morphAttributes.position;
  if (!pos) return g;
  o.updateWorldMatrix(true, false);
  const sc = o.getWorldScale(V()).x * 1000;   // geometry units -> mm
  for (const [n, mm] of Object.entries(NORM)) {
    const k = d[n], j = AZ.indexOf(n);
    if (k === undefined || !pos[k]) continue;
    const at = pos[k]; let m = 0;
    for (let i = 0; i < at.count; i++) m = Math.max(m, Math.hypot(at.getX(i), at.getY(i), at.getZ(i)));
    if (m * sc > 0.1) g[j] = Math.min(4, Math.max(0.25, mm / (m * sc)));
  }
  return g;
}

// ---------- actors ----------
function setupActor(obj, i) {
  const ud = obj.userData, mx = ud.mixer, pre = ud.mark.type === 'sit' ? 'sit_' : 'stand_';
  const clip = n => ud.clips.find(c => c.name === n);
  mx.stopAllAction();
  // idle2 = second copy of the idle clip, used to cross-fade a seamless loop
  const idle = mx.clipAction(clip(pre + 'idle')), talk = mx.clipAction(clip(pre + 'talk')), idle2 = mx.clipAction(clip(pre + 'idle').clone());
  idle.play(); talk.play(); idle2.play(); idle2.setEffectiveWeight(0);
  // calm body: every frame is pulled toward the idle's first frame. Seated legs are locked
  // there (the sit idle crosses its legs), the rest keeps a fraction of the clip's motion.
  const sit = ud.mark.type === 'sit';
  idle.setEffectiveWeight(1); talk.setEffectiveWeight(0); idle.time = 0; mx.update(0);
  const ref = [];
  obj.traverse(o => {
    if (!o.isBone) return;
    const k = /thigh|calf|foot|ball|toe/i.test(o.name) ? (sit ? 0 : 0.2) : /pelvis/i.test(o.name) ? (sit ? 0.1 : 0.25)
      // head/neck/spine nearly frozen: clip sway read as jitter; the look-at alone turns the head
      : /neck|head/i.test(o.name) ? 0.06 : /spine|clavicle/i.test(o.name) ? 0.12
      // arms/hands: clip swing read as fidgeting (user); keep only a trace of life
      : /arm|hand|finger/i.test(o.name) ? 0.08 : 0.35;
    ref.push({ b: o, q: o.quaternion.clone(), p: o.position.clone(), k });
  });
  let jaw = null;
  const faces = [];
  obj.traverse(o => {
    const d = o.morphTargetDictionary;
    if (!d) return;
    if (AZ.some(n => d[n] !== undefined)) faces.push({ inf: o.morphTargetInfluences, map: AZ.map(n => d[n]), gain: morphGains(o, d) });
    if (jaw) return;
    const k = ['jawOpen', 'JawOpen', 'jaw_open', 'mouthOpen'].find(n => d[n] !== undefined);
    if (k !== undefined) jaw = { mesh: o, idx: d[k] };
  });
  const a = {
    id: ud.id, obj, mx, idle, idle2, talk, jaw, faces, sit, ref,
    neck: bone(obj, 'neck_01'), head: bone(obj, 'head'), le: bone(obj, 'Bip01 LEye'), re: bone(obj, 'Bip01 REye'),
    fwd: V(Math.sin(obj.rotation.y), 0, Math.cos(obj.rotation.y)),
    phase: i * 2.37 + 0.6, speech: [],
  };
  // seated: hands rest on the thighs (the idle's arms hang beside the chair like a mannequin)
  a.pelvis = bone(obj, 'pelvis');
  a.arms = !sit ? [] : ['l', 'r'].map(s => ({
    s, ua: bone(obj, 'upperarm_' + s), la: bone(obj, 'lowerarm_' + s), h: bone(obj, 'hand_' + s),
    th: bone(obj, 'thigh_' + s), ca: bone(obj, 'calf_' + s),
    mid: bone(obj, 'middle_01_' + s), idx: bone(obj, 'index_01_' + s), pk: bone(obj, 'pinky_01_' + s),
  })).filter(r => r.ua && r.la && r.h && r.th && r.ca && r.mid && r.idx && r.pk && a.pelvis);
  if (a.arms.length) {
    obj.updateMatrixWorld(true);
    for (const r of a.arms) {
      // palm normal from the finger roots: left = dir x lat, right = -(dir x lat)
      const w = b => b.getWorldPosition(V());
      const n = V().crossVectors(w(r.mid).sub(w(r.h)), w(r.idx).sub(w(r.pk))).normalize();
      if (r.s === 'r') n.negate();
      r.palm = n.applyQuaternion(r.h.getWorldQuaternion(new THREE.Quaternion()).invert());
    }
  }
  // face direction in head-bone space, read from the bind pose (there the face looks along fwd)
  let sk = null; obj.traverse(o => { if (o.isSkinnedMesh && !sk) sk = o; });
  if (sk && a.head) {
    // pose() rewrites root bones the clips never touch, so save and restore every bone
    const saved = sk.skeleton.bones.map(b => [b.position.clone(), b.quaternion.clone(), b.scale.clone()]);
    sk.skeleton.pose(); obj.updateMatrixWorld(true);
    a.faceLocal = a.fwd.clone().applyQuaternion(a.head.getWorldQuaternion(new THREE.Quaternion()).invert());
    a.upLocal = V(0, 1, 0).applyQuaternion(a.head.getWorldQuaternion(new THREE.Quaternion()).invert());
    a.eyes = [a.le, a.re].filter(Boolean).map(b => ({ b, local: a.fwd.clone().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert()) }));
    sk.skeleton.bones.forEach((b, k) => { b.position.copy(saved[k][0]); b.quaternion.copy(saved[k][1]); b.scale.copy(saved[k][2]); });
    obj.updateMatrixWorld(true);
    for (const e of a.eyes) e.q0 = e.b.quaternion.clone();
  }
  return a;
}

function rotWorld(b, q) {   // apply world-space rotation q to bone b
  const pq = b.parent.getWorldQuaternion(new THREE.Quaternion());
  b.quaternion.premultiply(pq.clone().invert().multiply(q).multiply(pq));
}
const IDQ = new THREE.Quaternion();

// blink shape: 0.16 s close-open around x = 0.07
const blinkAt = x => clamp01(1 - Math.abs(x - 0.07) / 0.08);
function blinkVal(a, t, turn) {
  if (turn) { const u = t - turn.T0; return Math.max(blinkAt(u - 0.7), blinkAt(u - turn.TURN * 0.72)); }   // periodic in the loop
  const P = 3.4, k0 = Math.floor((t + a.phase) / P);
  let v = 0;
  for (const k of [k0 - 1, k0]) v = Math.max(v, blinkAt(t - (k * P + 0.3 + hash(k * 7.13 + a.phase) * 2.6 - a.phase)));
  return v;
}
// nod while listening on a turn: zero at both loop ends so the loop stays seamless
const nodAt = (u, T) => smooth(T * 0.45, T * 0.55, u) * (1 - smooth(T * 0.58, T * 0.68, u));

// face morphs (pure: every driven value is rewritten each frame)
function faceActor(a, t, turn) {
  let sp = null;
  for (const s of a.speech) if (t >= s[0] - 0.05 && t <= s[1] + 0.3) sp = s;
  const speaking = sp && t < sp[1];
  if (!a.faces.length) {   // no ARKit set: procedural jaw only
    if (!a.jaw) return;
    const f = Math.max(0, 0.6 * Math.sin(t * 26 + a.phase) + 0.4 * Math.sin(t * 17.3 + a.phase * 2));
    a.jaw.mesh.morphTargetInfluences[a.jaw.idx] = speaking ? 0.08 + 0.3 * f : 0;
    return;
  }
  const v = new Array(52).fill(0);
  if (sp && sp[2]) {   // Azure viseme frames, faded out after the audio ends
    const L = sp[2], n = L.bs.length - 1, f = Math.max(0, (t - sp[0]) * L.fps);
    const i0 = Math.min(n, Math.floor(f)), i1 = Math.min(n, i0 + 1), u = f - Math.floor(f), k = 1 - smooth(sp[1], sp[1] + 0.3, t);
    for (const j of USE) v[j] = (L.bs[i0][j] * (1 - u) + L.bs[i1][j] * u) * k;
  } else if (speaking) {
    const f = Math.max(0, 0.6 * Math.sin(t * 26 + a.phase) + 0.4 * Math.sin(t * 17.3 + a.phase * 2));
    v[J.jaw] = 0.08 + 0.3 * f;
  }
  const b = blinkVal(a, t, turn);
  v[J.blinkL] = Math.max(v[J.blinkL], b); v[J.blinkR] = Math.max(v[J.blinkR], b);
  if (speaking) {   // speaking face: mood from the line, brows follow the voice
    const txt = sp[3] || '', u = clamp01((t - sp[0]) / Math.max(0.3, sp[1] - sp[0]));
    const q = /\?\s*$/.test(txt), ex = /!\s*$/.test(txt) || /\b(great|sure|okay|thanks|love|nice|cake)\b/i.test(txt);
    const sm = ex ? 0.45 : 0.2, voice = v[J.jaw] || 0;
    v[J.smileL] = Math.max(v[J.smileL], sm); v[J.smileR] = Math.max(v[J.smileR], sm);
    v[J.cheekL] = Math.max(v[J.cheekL], sm * 0.5); v[J.cheekR] = Math.max(v[J.cheekR], sm * 0.5);
    v[J.browUp] = Math.max(v[J.browUp], 0.12 + 0.5 * voice + (q ? 0.4 * smooth(0.55, 0.85, u) : 0));
  }
  if (!speaking) {   // listening face: warm smile, brows lift with the nod
    const nod = turn ? nodAt(t - turn.T0, turn.TURN) : 0, sm = turn ? 0.5 + 0.1 * nod : 0.3;
    v[J.smileL] = Math.max(v[J.smileL], sm); v[J.smileR] = Math.max(v[J.smileR], sm);
    // a real (Duchenne) smile also lifts the cheeks and narrows the eyes a little
    v[J.cheekL] = Math.max(v[J.cheekL], sm * 0.6); v[J.cheekR] = Math.max(v[J.cheekR], sm * 0.6);
    v[J.squintL] = Math.max(v[J.squintL], sm * 0.3); v[J.squintR] = Math.max(v[J.squintR], sm * 0.3);
    v[J.browUp] = Math.max(v[J.browUp], turn ? 0.06 + 0.14 * nod : 0);
  }
  for (const fc of a.faces) fc.map.forEach((m, j) => { if (m !== undefined) fc.inf[m] = v[j] * fc.gain[j]; });
}

// pose one actor at time t: talk/idle blend, face, head and eyes turned toward `look`.
// turn = {T0, TURN} inside a learner turn: t is already folded into [T0, T0+TURN) and the
// last 1.2 s cross-fades to a second idle copy running TURN behind, so pose(T0+TURN) == pose(T0)
function poseActor(a, t, look, turn, eyeLook) {
  let w = 0;
  for (const [t0, t1] of a.speech) w = Math.max(w, smooth(t0 - 0.3, t0 + 0.15, t) * (1 - smooth(t1 - 0.1, t1 + 0.45, t)));
  const wB = turn ? smooth(turn.TURN - 1.2, turn.TURN, t - turn.T0) : 0, dI = a.idle.getClip().duration;
  a.idle.setEffectiveWeight((1 - w) * (1 - wB)); a.idle2.setEffectiveWeight((1 - w) * wB); a.talk.setEffectiveWeight(w);
  a.idle.time = mod(t + a.phase, dI);
  a.idle2.time = mod(t - (turn ? turn.TURN : 0) + a.phase, dI);
  a.talk.time = mod(t + a.phase * 1.7, a.talk.getClip().duration);
  a.mx.update(0);
  for (const r of a.ref) {
    if (r.k === 1) continue;
    const q = r.b.quaternion.clone(), p = r.b.position.clone();
    r.b.quaternion.copy(r.q).slerp(q, r.k); r.b.position.copy(r.p).lerp(p, r.k);
  }
  if (a.arms.length) handsOnLap(a);
  faceActor(a, t, turn);
  for (const e of a.eyes || []) e.b.quaternion.copy(e.q0);   // clips do not drive the eyes: reset, keep it pure
  // aim (not add): the clips have their own head sway, so turn the face toward the target
  // from wherever the clip left it, clamped relative to the body
  if (look && a.neck && a.head && a.faceLocal && !globalThis.NOLOOK) {
    a.obj.updateMatrixWorld(true);
    const to = look.clone().sub(eyePos(a));
    const yaw = Math.max(-55 * DEG, Math.min(55 * DEG, wrap(Math.atan2(to.x, to.z) - Math.atan2(a.fwd.x, a.fwd.z))));
    const pitch = Math.max(-20 * DEG, Math.min(15 * DEG, Math.atan2(to.y, Math.hypot(to.x, to.z))));
    const ry = Math.atan2(a.fwd.x, a.fwd.z) + yaw;
    const want = V(Math.sin(ry) * Math.cos(pitch), Math.sin(pitch), Math.cos(ry) * Math.cos(pitch));
    const cur = a.faceLocal.clone().applyQuaternion(a.head.getWorldQuaternion(new THREE.Quaternion())).normalize();
    // direct address (eyeLook set = learner's turn): face the lens almost fully
    const k = eyeLook ? 0.6 : 0.45;
    const half = IDQ.clone().slerp(new THREE.Quaternion().setFromUnitVectors(cur, want), k);
    rotWorld(a.neck, half);
    a.head.parent.updateMatrixWorld(true);
    rotWorld(a.head, eyeLook ? IDQ.clone().slerp(new THREE.Quaternion().setFromUnitVectors(
      a.faceLocal.clone().applyQuaternion(a.head.getWorldQuaternion(new THREE.Quaternion())).normalize(), want), 0.85) : half);
    if (eyeLook) {
      // remove most of the clip's head roll: a tilted head reads as suspicious when it stares at you
      a.head.updateWorldMatrix(true, false);
      const hq = a.head.getWorldQuaternion(new THREE.Quaternion());
      const f = a.faceLocal.clone().applyQuaternion(hq).normalize();
      const up = a.upLocal ? a.upLocal.clone().applyQuaternion(hq) : null;
      if (up) {
        const side = new THREE.Vector3().crossVectors(f, V(0, 1, 0)).normalize();
        const roll = Math.asin(Math.max(-1, Math.min(1, up.dot(side))));
        rotWorld(a.head, new THREE.Quaternion().setFromAxisAngle(f, -roll * 0.75));
      }
    }
    // eyes finish the aim (eye contact), clamped to a natural 25 degrees
    for (const e of a.eyes || []) {
      e.b.updateWorldMatrix(true, false);
      const want = (eyeLook || look).clone().sub(e.b.getWorldPosition(V())).normalize();
      const cur = e.local.clone().applyQuaternion(e.b.getWorldQuaternion(new THREE.Quaternion())).normalize();
      let q = new THREE.Quaternion().setFromUnitVectors(cur, want);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q.w)));
      if (ang > 25 * DEG) q = IDQ.clone().slerp(q, 25 * DEG / ang);
      rotWorld(e.b, q);
    }
  }
}

// analytic two-bone IK: wrist on the mid thigh, elbow out and back, palm turned down
const LAP = 0.66, LAP_UP = 0.15;   // fraction hip->knee, height above the thigh bone (m)
function handsOnLap(a) {
  a.obj.updateMatrixWorld(true);
  const w = b => b.getWorldPosition(V()), wq = b => b.getWorldQuaternion(new THREE.Quaternion());
  const pel = w(a.pelvis), mid = w(a.arms[0].th).add(w(a.arms[a.arms.length - 1].th)).multiplyScalar(0.5);
  for (const r of a.arms) {
    const A = w(r.ua), B = w(r.la), C = w(r.h);
    const hip = w(r.th), knee = w(r.ca);
    const inward = mid.clone().sub(hip).setY(0);
    const T = hip.clone().lerp(knee, LAP).add(V(0, LAP_UP, 0)).addScaledVector(inward.lengthSq() ? inward.normalize() : V(), 0.015);
    const la = B.distanceTo(A), lb = C.distanceTo(B);
    const AT = T.clone().sub(A), d = Math.min(Math.max(AT.length(), Math.abs(la - lb) + 1e-3), la + lb - 1e-3);
    const dir = AT.normalize();
    const out = A.clone().sub(pel).setY(0).normalize();
    const pole = out.multiplyScalar(0.45).addScaledVector(a.fwd, -0.4).add(V(0, -0.6, 0));
    const perp = pole.addScaledVector(dir, -pole.dot(dir)).normalize();
    const cosA = (la * la + d * d - lb * lb) / (2 * la * d), sinA = Math.sqrt(Math.max(0, 1 - cosA * cosA));
    const E = A.clone().addScaledVector(dir, la * cosA).addScaledVector(perp, la * sinA);
    rotWorld(r.ua, new THREE.Quaternion().setFromUnitVectors(B.clone().sub(A).normalize(), E.clone().sub(A).normalize()));
    r.ua.updateMatrixWorld(true);
    const B2 = w(r.la), Tn = A.clone().addScaledVector(dir, d);
    rotWorld(r.la, new THREE.Quaternion().setFromUnitVectors(w(r.h).sub(B2).normalize(), Tn.clone().sub(B2).normalize()));
    r.la.updateMatrixWorld(true);
    // palm down: twist about the forearm axis, split between forearm and wrist (no twist bones)
    const ax = w(r.h).sub(w(r.la)).normalize();
    const flat = v => v.addScaledVector(ax, -v.dot(ax)).normalize();
    const np = flat(r.palm.clone().applyQuaternion(wq(r.h))), dp = flat(V(0, -1, 0));
    const ang = Math.atan2(V().crossVectors(np, dp).dot(ax), np.dot(dp));
    rotWorld(r.la, new THREE.Quaternion().setFromAxisAngle(ax, ang * 0.5));
    r.la.updateMatrixWorld(true);
    // hand lies on the thigh: fingers along the thigh (slightly down and in), palm down.
    // full orientation from two axes, so the wrist bends flat instead of pointing into the leg
    const f0 = w(r.mid).sub(w(r.h)).normalize(), n0 = r.palm.clone().applyQuaternion(wq(r.h));
    n0.addScaledVector(f0, -n0.dot(f0)).normalize();
    const f1 = knee.clone().sub(hip).normalize().add(V(0, -0.3, 0)).addScaledVector(inward, 0.2).normalize();
    const n1 = V(0, -1, 0).addScaledVector(f1, f1.y).normalize();
    const basis = (f, n) => new THREE.Matrix4().makeBasis(f, n, V().crossVectors(f, n));
    const qh = new THREE.Quaternion().setFromRotationMatrix(basis(f1, n1).multiply(basis(f0, n0).transpose()));
    rotWorld(r.h, qh);
    r.h.updateMatrixWorld(true);
  }
}

function eyePos(a) {
  if (a.le && a.re) return a.le.getWorldPosition(V()).add(a.re.getWorldPosition(V())).multiplyScalar(0.5);
  return a.head.getWorldPosition(V()).add(V(0, 0.1, 0));
}

// static geometry used to place shots (sampled once, after the first pose)
function measure(a) {
  a.obj.updateMatrixWorld(true);
  const eye = eyePos(a), h = a.head.getWorldPosition(V());
  a.eye = eye;
  a.face = eye.clone().add(V(0, -0.035, 0));
  a.chest = h.clone().add(V(0, -0.3, 0)).addScaledVector(a.fwd, 0.04);
}

// ---------- shots ----------
// every builder gets ctx {S: subject, L: other, d: unit S->L (flat), n: camera side (flat)}
// and returns {a, b, move, hold, shake, fg}. a/b = {pos, look, fov}; camera eases a -> b.
const dirAt = (c, th) => c.d.clone().multiplyScalar(Math.cos(th)).addScaledVector(c.n, Math.sin(th));
const single = (c, th, dist, dy, look, fov) => ({ pos: c.S.face.clone().addScaledVector(dirAt(c, th), dist).add(V(0, dy, 0)), look, fov });
const pick = (R, lo, hi) => lo + (hi - lo) * R();
// camera angle (deg) for a single, kept away from the last angles used on this subject
const angle = (c, R, lo, hi) => {
  let best = lo, bd = -1;
  for (let k = 0; k < 6; k++) {
    const x = pick(R, lo, hi), d = Math.min(99, ...(c.used || []).slice(-3).map(u => Math.abs(u - x)));
    if (d > bd) { bd = d; best = x; }
  }
  return best;
};

const SHOTS = {
  wide(c, R, E) {
    const pos = V().fromArray(E.cam.pos), look = V().fromArray(E.cam.target);
    return { a: { pos, look, fov: E.cam.fov }, b: { pos: pos.clone().lerp(look, 0.08), look, fov: E.cam.fov }, shake: 0, free: true };
  },
  two_shot(c, R, E) {
    const mid = c.S.face.clone().lerp(c.L.face, 0.5), sep = c.S.face.distanceTo(c.L.face);
    const fov = 38, hf = 2 * Math.atan(Math.tan(fov * DEG / 2) * Math.min(E.aspect, 1.6));
    const dist = (sep + 1.1) / 2 / Math.tan(hf / 2);
    const pos = mid.clone().addScaledVector(c.n, dist).add(V(0, 0.35, 0)), look = mid.clone().add(V(0, -0.12, 0));
    const tr = c.d.clone().multiplyScalar(pick(R, -0.25, 0.25));
    return { a: { pos, look, fov }, b: { pos: pos.clone().add(tr), look: look.clone().add(tr.multiplyScalar(0.5)), fov }, shake: 0.0012, pull: true, need: [c.S, c.L] };
  },
  medium(c, R) {
    const deg = angle(c, R, 8, 50), th = deg * DEG, d0 = pick(R, 1.3, 1.55), dy = pick(R, -0.08, 0.06);
    const look = c.S.chest.clone().lerp(c.S.face, 0.7);
    const a = single(c, th, d0, dy, look, 32), push = R() < 0.55;
    return { a, b: push ? single(c, th, d0 * 0.86, dy, look, 32) : a, shake: 0.0012, th: deg };
  },
  close_up(c, R) {
    const deg = angle(c, R, 4, 46), th = deg * DEG, look = c.S.face.clone(), dy = pick(R, -0.05, 0.05), d0 = pick(R, 0.8, 0.95);
    return { a: single(c, th, d0, dy, look, 26), b: single(c, th, R() < 0.6 ? d0 * 0.84 : d0, dy, look, 26), shake: 0.001, th: deg };
  },
  over_shoulder(c, R) {
    const side = pick(R, 0.28, 0.36);
    const pos = c.L.eye.clone().addScaledVector(c.d, 0.55).addScaledVector(c.n, side).add(V(0, 0.06, 0));
    const look = c.S.face.clone().lerp(c.L.eye, 0.12);
    return { a: { pos, look, fov: 30 }, b: { pos: pos.clone().addScaledVector(c.n, 0.08), look, fov: 30 }, shake: 0.003, fg: c.L };
  },
  pov(c, R) {
    const toS = flat(c.S.face.clone().sub(c.L.eye));
    const pos = c.L.eye.clone().addScaledVector(toS, 0.14);
    return { a: { pos, look: c.S.face.clone().add(V(0, -0.05, 0)), fov: 52 }, b: { pos: pos.clone().addScaledVector(toS, 0.04), look: c.S.face.clone(), fov: 52 }, shake: 0.007, fg: c.L, nearOk: c.L };
  },
  arc(c, R) {
    const deg = angle(c, R, 12, 40), t0 = deg * DEG, t1 = t0 + pick(R, 15, 24) * DEG * (R() < 0.5 ? 1 : -1);
    const look = c.S.face.clone().lerp(c.S.chest, 0.2), dist = pick(R, 1.2, 1.45);
    return { a: single(c, t0, dist, 0.02, look, 30), b: single(c, Math.max(8 * DEG, t1), dist, 0.02, look, 30), shake: 0.001, move: 'linear', th: deg };
  },
  tilt(c, R) {
    const th = pick(R, 18, 32) * DEG, p = single(c, th, 1.35, -0.12, null, 30).pos;
    const low = c.S.chest.clone().add(V(0, c.S.sit ? -0.4 : -0.55, 0)).addScaledVector(c.S.fwd, 0.25);
    return { a: { pos: p, look: low, fov: 30 }, b: { pos: p, look: c.S.face.clone(), fov: 30 }, hold: 0.55, shake: 0.001 };
  },
  pan(c, R, E) {
    if (!E.changed) return null;
    const mid = c.S.face.clone().lerp(c.L.face, 0.5), sep = c.S.face.distanceTo(c.L.face);
    const pos = mid.clone().addScaledVector(c.n, Math.max(1.2, sep * 0.75)).add(V(0, 0.1, 0));
    return { a: { pos, look: c.L.face.clone(), fov: 30 }, b: { pos, look: c.S.face.clone(), fov: 30 }, hold: 0.45, shake: 0.0015, need: [c.S, c.L] };
  },
  low_angle(c, R) {
    const th = pick(R, 22, 38) * DEG, look = c.S.face.clone();
    const a = single(c, th, 1.3, 0, look, 32); a.pos.y = c.S.chest.y - 0.2;
    const b = { ...a, pos: a.pos.clone().addScaledVector(dirAt(c, th), -0.12) };
    return { a, b, shake: 0.001 };
  },
  high_angle(c, R) {
    const th = pick(R, 25, 40) * DEG, look = c.S.face.clone().add(V(0, -0.08, 0));
    const a = single(c, th, 1.5, 0.7, look, 32);
    return { a, b: { ...a, pos: a.pos.clone().add(V(0, -0.08, 0)) }, shake: 0.001 };
  },
};
// reaction = the same singles aimed at the listener (ctx roles swapped, camera side kept)
// while someone speaks the camera stays on that face (close/medium from a changing angle);
// the whole room (wide/two_shot) is for the moments nobody speaks: intro and outro
const SPEAKER_W = { close_up: 3, medium: 2.5, over_shoulder: 2.2, arc: 1.2, pan: 0.8, low_angle: 0.3, high_angle: 0.3 };
const REACT_W = { close_up: 2.5, medium: 1.5 };

// ---------- planning ----------
export function plan(S, ep, opt = {}) {
  const R = mulberry(opt.seed ?? ep.seed ?? 1);
  const aspect = opt.aspect || 16 / 9;
  const actors = S.cast.map(setupActor), byId = Object.fromEntries(actors.map(a => [a.id, a]));
  // timeline. learner lines become "turns": a TURN-second segment that loops seamlessly in the
  // player until the learner speaks (+TPAD of the same loop so a late seek-back never shows a cut)
  const learner = opt.learner && byId[opt.learner] ? opt.learner : null;
  const TURN = opt.turn || 4, TPAD = 0.6;
  let t = PRE;
  const lines = ep.lines.map((l, i) => {
    if (learner && l.who === learner) {
      const x = { ...l, i, t0: t, t1: t + TURN + TPAD, turn: { T0: t, TURN }, loop: [t, t + TURN] };
      t = x.t1 + LEAD; return x;
    }
    const dur = l.dur || estDur(l.text), x = { ...l, i, t0: t, t1: t + dur };
    t += dur + GAP; byId[l.who].speech.push([x.t0, x.t1, l.bs ? l : null, l.text]); return x;
  });
  const endsOnTurn = !!lines.at(-1).turn;
  const total = endsOnTurn ? lines.at(-1).t1 + TAIL : t - GAP + TAIL;
  const other = (i, who) => {
    const l = lines[i];
    if (l.to) return l.to;
    for (const j of [i - 1, i + 1, i - 2, i + 2]) if (lines[j] && lines[j].who !== who) return lines[j].who;
    return actors.find(a => a.id !== who).id;
  };
  const lookOf = (who, tt) => {   // whom each actor looks at
    const li = lines.findIndex(l => tt < l.t1 + GAP) ;
    const l = lines[li < 0 ? lines.length - 1 : li];
    const target = who === l.who ? other(l.i, who) : l.who;
    return byId[target === who ? actors.find(a => a.id !== who).id : target];
  };
  // sample geometry once with heads already turned
  const pose = tt => { for (const a of actors) poseActor(a, tt, lookOf(a.id, tt).eye || lookOf(a.id, tt).head.getWorldPosition(V())); };
  for (const a of actors) { a.obj.updateMatrixWorld(true); a.eye = eyePos(a); }
  pose(PRE); actors.forEach(measure);

  const E = { aspect, cam: S.recipe.camera || { pos: [0, 1.6, 4], target: [0, 1, 0], fov: 45 }, room: S.recipe.room, changed: false };
  const occl = buildOccluders(S);
  // camera side for the 180-degree rule: one side per actor pair, chosen toward the establishing camera
  const sides = {}, used = {};
  const ctxFor = (Sid, Lid) => {
    const s = byId[Sid], l = byId[Lid], d = flat(l.face.clone().sub(s.face));
    const key = [Sid, Lid].sort().join('|');
    if (!sides[key]) {
      const a = byId[key.split('|')[0]], b = byId[key.split('|')[1]];
      const ab = flat(b.face.clone().sub(a.face)), nn = V(-ab.z, 0, ab.x);
      const mid = a.face.clone().lerp(b.face, 0.5), cam = V().fromArray(E.cam.pos);
      sides[key] = { a: a.id, n: nn.dot(cam.sub(mid)) >= 0 ? nn : nn.negate() };
    }
    return { S: s, L: l, d, n: sides[key].n.clone(), used: (used[Sid] ||= []) };
  };

  const shots = [], recent = [];
  const choose = (weights, ctx, t0, t1, role) => {
    const pool = Object.entries(weights).filter(([k]) => k !== recent.at(-1) && !(k === 'pov' && recent.slice(-3).includes('pov')));
    while (pool.length) {
      let sum = pool.reduce((s, [, w]) => s + w, 0), r = R() * sum, k = 0;
      while (r > pool[k][1]) r -= pool[k++][1];
      const [type] = pool.splice(k, 1)[0];
      const sh = SHOTS[type](ctx, R, E);
      if (sh && valid(sh, ctx, E, occl, actors)) { if (sh.th != null && ctx.used) ctx.used.push(sh.th); } else continue;
      return { ...sh, type: role === 'react' && type !== 'two_shot' ? 'reaction_' + type : type, t0, t1, who: ctx.S.id };
    }
    return { ...SHOTS.wide(ctx, R, E), type: 'wide', t0, t1, who: ctx.S.id };
  };
  const push = s => { shots.push(s); recent.push(s.type.replace('reaction_', '')); };

  push(choose({ wide: 1 }, ctxFor(lines[0].who, other(0, lines[0].who)), 0, lines[0].t0 - (lines[0].turn ? 0 : LEAD), 'est'));
  let since = 0;
  lines.forEach((l, i) => {
    const nx = lines[i + 1];
    if (l.turn) {   // learner's turn: static first-person view, partner looks into the lens and waits
      const ctx = ctxFor(other(i, l.who), l.who), base = SHOTS.pov(ctx, R, E);
      const pos = ctx.L.eye.clone().lerp(ctx.S.face, Math.min(0.4, Math.max(0, 1 - 1.5 / ctx.L.eye.distanceTo(ctx.S.face))));
      pos.y -= 0.08;
      const a = { pos, look: ctx.S.face.clone().add(V(0, -0.06, 0)), fov: 36 };
      const sh = { ...base, a, b: a, shake: 0.004, type: 'turn', t0: l.t0, t1: l.t1, who: ctx.S.id, turn: l.turn };
      if (!valid(sh, ctx, E, occl, actors)) console.warn('turn shot blocked', i);
      push(sh); since++; return;
    }
    const t0 = l.t0 - LEAD, t1 = nx ? (nx.turn ? nx.t0 : nx.t0 - LEAD) : total;
    const ctx = ctxFor(l.who, other(i, l.who));
    E.changed = i > 0 && lines[i - 1].who !== l.who;
    const w = { ...SPEAKER_W };
    if (i === 0) delete w.pan;
    const split = t1 - t0 > 4.6 && actors.length > 1;
    const tm = split ? t0 + (t1 - t0) * 0.58 : t1;
    const s1 = choose(w, ctx, t0, tm, 'speak'); push(s1);
    since = /wide|two_shot/.test(s1.type) ? 0 : since + 1;
    if (split) {
      const rctx = { S: ctx.L, L: ctx.S, d: ctx.d.clone().negate(), n: ctx.n, used: (used[ctx.L.id] ||= []) };
      E.changed = false;
      push(choose(REACT_W, rctx, tm, t1, 'react')); since++;
    }
  });
  if (endsOnTurn) {   // closing shot after the learner's last line
    const l = lines.at(-1);
    push(choose({ wide: 1.5, two_shot: 1 }, ctxFor(other(l.i, l.who), l.who), l.t1, total, 'outro'));
  }

  // segments for the app player (times in seconds of the rendered video)
  const r3 = x => Math.round(x * 1000) / 1000;
  const segments = [{ type: 'intro', t0: 0, t1: r3(lines[0].t0) }];
  for (const l of lines) {
    const s = { type: l.turn ? 'turn' : 'line', i: l.i, who: l.who, text: l.text, tr: l.tr || '', t0: r3(l.t0), t1: r3(l.t1) };
    if (l.turn) Object.assign(s, { loop: l.loop.map(r3), audio: 'l' + l.i + '.mp3' });
    segments.push(s);
  }
  if (endsOnTurn) segments.push({ type: 'outro', t0: r3(lines.at(-1).t1), t1: r3(total) });

  // ---------- per-frame ----------
  const SHAKE = 0.3;   // global handheld scale (user: no shaky motion)
  const shake = (t, amp) => (amp *= SHAKE, V(Math.sin(t * 1.3) * 0.6 + Math.sin(t * 2.9 + 1) * 0.4, Math.sin(t * 1.7 + 2) * 0.6 + Math.sin(t * 3.7) * 0.4, 0).multiplyScalar(amp));
  // periodic handheld for turns: whole multiples of the loop frequency, so it wraps cleanly
  const shakeP = (u, T, amp) => { amp *= SHAKE; const w = 2 * Math.PI / T; return V(Math.sin(w * u) * 0.6 + Math.sin(2 * w * u + 1) * 0.4, Math.sin(w * u + 2) * 0.6 + Math.sin(3 * w * u) * 0.4, 0).multiplyScalar(amp); };
  function frame(t, camera) {
    const sh = shots.find(s => t < s.t1) || shots.at(-1);
    const turn = sh.type === 'turn' ? sh.turn : null;
    if (learner) byId[learner].obj.visible = !turn;
    if (turn) {
      const te = turn.T0 + mod(t - turn.T0, turn.TURN), P = byId[sh.who];
      const dn = sh.a.pos.distanceTo(P.eye), nod = nodAt(te - turn.T0, turn.TURN);
      const lookCam = sh.a.pos.clone().add(V(0, -dn * 0.14 * nod, 0));   // head dips, eyes stay on the lens
      for (const a of actors) poseActor(a, te, a === P ? lookCam : P.eye, turn, a === P ? sh.a.pos : null);
      camera.fov = sh.a.fov * (aspect < 1 ? 1.3 : 1);
      camera.position.copy(sh.a.pos); camera.lookAt(sh.a.look);
      const n = shakeP(te - turn.T0, turn.TURN, sh.shake);
      camera.rotateY(n.x); camera.rotateX(n.y);
      camera.updateProjectionMatrix();
      return { shot: sh, turn: true, line: lines[lines.findIndex(l => l.turn === turn)] };
    }
    pose(t);
    let u = clamp01((t - sh.t0) / (sh.t1 - sh.t0));
    u = sh.hold ? sine(u / sh.hold) : sh.move === 'linear' ? u : sine(u);
    const pos = sh.a.pos.clone().lerp(sh.b.pos, u), look = sh.a.look.clone().lerp(sh.b.look, u);
    if (!sh.free && !sh.need) {   // operator follow: keep the live face framed as heads turn and sway
      const a = byId[sh.who], live = eyePos(a).add(V(0, -0.035, 0)).sub(a.face);
      look.addScaledVector(live, 0.9); if (!sh.fg) pos.addScaledVector(live, 0.5);
    }
    camera.fov = (sh.a.fov + (sh.b.fov - sh.a.fov) * u) * (aspect < 1 && sh.type !== 'wide' ? 1.3 : aspect < 1 ? 1.45 : 1);
    camera.position.copy(pos); camera.lookAt(look);
    if (sh.shake) {   // handheld: small rotation noise in camera space
      const n = shake(t, sh.shake);
      camera.rotateY(n.x); camera.rotateX(n.y);
    }
    camera.updateProjectionMatrix();
    return { shot: sh, line: lines.find(l => t >= l.t0 - 0.1 && t <= l.t1 + 0.35) || null };
  }
  return { shots, lines, total, frame, actors, learner, segments: { id: ep.id, title: ep.title, duration: r3(total), learner, segments } };
}

// ---------- validity ----------
function buildOccluders(S) {
  const meshes = [];
  for (const p of S.props) p.traverse(o => { if (o.isMesh && !/glass/i.test(o.material.name || '')) meshes.push(o); });
  const boxes = S.props.map(p => new THREE.Box3().setFromObject(p).expandByScalar(0.04));
  return { meshes, boxes, ray: new THREE.Raycaster() };
}

function inRoom(p, room) {
  if (!room) return p.y > 0.2;
  return Math.abs(p.x) < room.w / 2 - 0.12 && Math.abs(p.z) < room.d / 2 - 0.12 && p.y > 0.2 && p.y < room.h - 0.15;
}

function raySphere(o, dir, far, c, r) {
  const oc = c.clone().sub(o), tc = oc.dot(dir);
  if (tc < 0 || tc > far) return false;
  return oc.lengthSq() - tc * tc < r * r;
}

function valid(sh, ctx, E, occ, actors) {
  if (sh.free) return true;
  const targets = sh.need || [ctx.S];
  for (const k of ['a', 'b']) {
    const v = sh[k];
    if (!inRoom(v.pos, E.room)) {
      if (!sh.pull) return false;
      // wide framings may slide toward the subject to stay inside the room
      for (let i = 0; i < 12 && !inRoom(v.pos, E.room); i++) v.pos.lerp(v.look, 0.1);
      if (!inRoom(v.pos, E.room)) return false;
    }
    if (occ.boxes.some(b => b.containsPoint(v.pos))) return false;
    for (const a of actors) {
      if (a === sh.nearOk) continue;
      if (v.pos.distanceTo(a.face) < 0.4 || v.pos.distanceTo(a.chest) < 0.35) return false;
    }
    for (const tg of targets) {
      const dir = tg.face.clone().sub(v.pos), far = dir.length() - 0.12; dir.normalize();
      occ.ray.set(v.pos, dir); occ.ray.far = far;
      if (occ.ray.intersectObjects(occ.meshes, false).length) return false;
      for (const a of actors) {
        if (a === tg || a === sh.fg) continue;
        if (raySphere(v.pos, dir, far, a.face, 0.15) || raySphere(v.pos, dir, far, a.chest, 0.24)) return false;
      }
    }
  }
  return true;
}
