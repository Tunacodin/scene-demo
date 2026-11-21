// Scene kit runtime: builds a room/outdoor shell from a recipe JSON, places tintable props, seats/stands
// Rocketbox characters on marks. Props: props/<id>.glb (meshopt). Textures: tex/<id>_{d,n,arm}.jpg.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { addSkinDetail } from '../characters/skin-detail.js';

const BASE = new URL('.', import.meta.url).href;
const loader = new GLTFLoader(); loader.setMeshoptDecoder(MeshoptDecoder);
const texLoader = new THREE.TextureLoader();
const propCache = {}, texCache = {}, charCache = {};
// tint maps are grey with mean 0.8 (sRGB) ~ 0.6 linear: scale the tint so the chosen colour reads true
const TEX_GAIN = 1.65;
const DEG = Math.PI / 180;

export function makeRenderer(canvas) {
  const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
  r.setPixelRatio(Math.min(devicePixelRatio, 2));
  r.toneMapping = THREE.NeutralToneMapping; r.outputColorSpace = THREE.SRGBColorSpace;
  r.shadowMap.enabled = true; r.shadowMap.type = THREE.PCFShadowMap;
  return r;
}

function tex(id, kind, rep) {
  const key = id + '_' + kind;
  if (!texCache[key]) {
    const t = texLoader.load(BASE + 'tex/' + key + '.jpg');
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 4;
    if (kind === 'd') t.colorSpace = THREE.SRGBColorSpace;
    texCache[key] = t;
  }
  const t = texCache[key].clone(); t.repeat.set(rep, rep); t.needsUpdate = true;
  return t;
}

// surface spec: { tex: 'laminate_floor_02', tile: 1.5, tint: '#hex', rough: 0.8 } or { color: '#hex' }
function surfaceMat(s = {}) {
  const m = new THREE.MeshStandardMaterial({ color: s.color || '#ffffff', roughness: s.rough ?? 0.85 });
  if (s.tex) {
    const rep = 1 / (s.tile || 1);
    m.map = tex(s.tex, 'd', rep);
    if (s.normal !== false) { m.normalMap = tex(s.tex, 'n', rep); m.normalScale.set(0.6, 0.6); }
    if (s.arm) { m.roughnessMap = tex(s.tex, 'arm', rep); m.roughness = 1; }
    if (s.tint) m.color.set(s.tint).multiplyScalar(TEX_GAIN);
  } else if (s.tint) m.color.set(s.tint);
  return m;
}

// ---------- room shell ----------
// walls: n (z=-d/2), s (z=+d/2), e (x=+w/2), w (x=-w/2). Each wall faces the room; walls between the camera
// and the room are hidden every frame (cutaway), so any camera position works.
const WALLS = {
  n: { len: (w, d) => w, pos: (w, d) => [0, -d / 2], rot: 0, nrm: [0, 1] },
  s: { len: (w, d) => w, pos: (w, d) => [0, d / 2], rot: Math.PI, nrm: [0, -1] },
  e: { len: (w, d) => d, pos: (w, d) => [w / 2, 0], rot: -Math.PI / 2, nrm: [-1, 0] },
  w: { len: (w, d) => d, pos: (w, d) => [-w / 2, 0], rot: Math.PI / 2, nrm: [1, 0] },
};

function buildRoom(R, root, cut) {
  const { w, d, h } = R, T = 0.12;
  const floorShape = new THREE.Shape([[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(p => new THREE.Vector2(...p)));
  const floor = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), surfaceMat(R.floor));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; root.add(floor);
  if (R.ceiling) {
    const c = new THREE.Mesh(new THREE.ShapeGeometry(floorShape), surfaceMat(R.ceiling));
    c.rotation.x = Math.PI / 2; c.position.y = h; root.add(c); cut.push({ obj: c, ceil: h });
  }
  const wallMat = surfaceMat(R.wall), trimMat = surfaceMat(R.trim || { color: '#f2f0ea', rough: 0.5 });
  const glassMat = new THREE.MeshStandardMaterial({ color: '#cfe3f2', roughness: 0.05, metalness: 0, transparent: true, opacity: 0.18 });
  const frameMat = surfaceMat(R.frame || { color: '#f4f4f2', rough: 0.4 });
  for (const k of R.walls || ['n', 's', 'e', 'w']) {
    const W = WALLS[k], L = W.len(w, d), [px, pz] = W.pos(w, d);
    const g = new THREE.Group(); g.position.set(px, 0, pz); g.rotation.y = W.rot;
    const sh = new THREE.Shape([[-L / 2 - T, 0], [L / 2 + T, 0], [L / 2 + T, h], [-L / 2 - T, h]].map(p => new THREE.Vector2(...p)));
    const ops = (R.openings || []).filter(o => o.wall === k);
    for (const o of ops) {
      const y0 = o.type === 'door' ? 0.001 : o.sill ?? 0.9, oh = o.h ?? (o.type === 'door' ? 2.1 : 1.3), ow = o.w ?? 1.2;
      // shape x runs along the wall as seen from inside the room
      sh.holes.push(new THREE.Path([[o.x - ow / 2, y0], [o.x + ow / 2, y0], [o.x + ow / 2, y0 + oh], [o.x - ow / 2, y0 + oh]].map(p => new THREE.Vector2(...p))));
      const fr = 0.05;
      const parts = [[o.x, y0 + oh + fr / 2, ow + 2 * fr, fr], [o.x - ow / 2 - fr / 2, y0 + oh / 2, fr, oh], [o.x + ow / 2 + fr / 2, y0 + oh / 2, fr, oh]];
      if (o.type !== 'door') parts.push([o.x, y0 - fr / 2, ow + 2 * fr, fr], [o.x, y0 + oh / 2, 0.035, oh]);
      for (const [x, y, sw, shh] of parts) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(sw, shh, T + 0.04), frameMat); b.position.set(x, y, -T / 2); b.castShadow = true; g.add(b);
      }
      if (o.type !== 'door') {
        const gl = new THREE.Mesh(new THREE.PlaneGeometry(ow, oh), glassMat); gl.position.set(o.x, y0 + oh / 2, -T / 2); g.add(gl);
      } else if (o.leaf !== false) {
        const leaf = new THREE.Mesh(new THREE.BoxGeometry(ow - 0.02, oh - 0.01, 0.04), surfaceMat(o.leafSurface || { color: '#e9e6df', rough: 0.5 }));
        leaf.position.set(o.x, oh / 2, -T + 0.02); leaf.castShadow = true; g.add(leaf);
      }
    }
    const geo = new THREE.ExtrudeGeometry(sh, { depth: T, bevelEnabled: false });
    geo.translate(0, 0, -T); // inner face at z=0 of the wall group, thickness goes outward
    const wall = new THREE.Mesh(geo, wallMat); wall.receiveShadow = true; wall.castShadow = true; g.add(wall);
    if (R.baseboard !== false) {
      const segs = [[-L / 2, L / 2]];
      for (const o of ops.filter(o => o.type === 'door')) {
        const ow = o.w ?? 0.9, s = segs.pop(); segs.push([s[0], o.x - ow / 2 - 0.05], [o.x + ow / 2 + 0.05, s[1]]);
      }
      for (const [a, b] of segs) {
        if (b - a < 0.05) continue;
        const bb = new THREE.Mesh(new THREE.BoxGeometry(b - a, 0.08, 0.015), trimMat); bb.position.set((a + b) / 2, 0.04, 0.0075); g.add(bb);
      }
    }
    root.add(g);
    cut.push({ obj: g, x: px, z: pz, nx: W.nrm[0], nz: W.nrm[1] });
  }
}

function buildOutdoor(O, root, scene) {
  const size = O.size || 40;
  const shape = new THREE.Shape([[-size / 2, -size / 2], [size / 2, -size / 2], [size / 2, size / 2], [-size / 2, size / 2]].map(p => new THREE.Vector2(...p)));
  const g = new THREE.Mesh(new THREE.ShapeGeometry(shape), surfaceMat(O.ground));
  g.rotation.x = -Math.PI / 2; g.receiveShadow = true; root.add(g);
  for (const p of O.paths || []) {  // paved strips: {x,z,w,d,rot,surface}
    const m = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape([[-p.w / 2, -p.d / 2], [p.w / 2, -p.d / 2], [p.w / 2, p.d / 2], [-p.w / 2, p.d / 2]].map(q => new THREE.Vector2(...q)))), surfaceMat(p.surface));
    m.rotation.set(-Math.PI / 2, 0, (p.rot || 0) * DEG); m.position.set(p.x, 0.005, p.z); m.receiveShadow = true; root.add(m);
  }
  // vertical gradient sky dome
  const top = new THREE.Color(O.skyTop || '#7fa9d6'), bot = new THREE.Color(O.skyBottom || '#dfe9f1');
  const sky = new THREE.Mesh(new THREE.SphereGeometry(size, 24, 12), new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, uniforms: { top: { value: top }, bot: { value: bot } },
    vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 bot; varying vec3 p; void main(){ gl_FragColor = vec4(mix(bot, top, clamp(p.y*1.6,0.,1.)),1.); }',
  }));
  scene.add(sky);
  if (O.fog !== false) scene.fog = new THREE.Fog(bot, size * 0.35, size * 0.95);
}

// ---------- props ----------
async function loadProp(id) {
  if (!propCache[id]) propCache[id] = loader.loadAsync(BASE + 'props/' + id + '.glb').then(g => {
    // source glass panes come in opaque (no transmission in gltfpack output): make them a faint sheen
    g.scene.traverse(o => {
      if (o.isMesh && /glass/i.test(o.material.name || '')) {
        Object.assign(o.material, { transparent: true, opacity: 0.12, depthWrite: false, map: null, roughness: 0.05 });
        o.castShadow = false; o.userData.noShadow = true;
      }
    });
    return g;
  });
  return propCache[id];
}

// tint: { slot: '#hex' }   screen: '#hex' glow colour for 'screen' materials
export function applyTint(obj, tint = {}, screen) {
  obj.traverse(o => {
    if (!o.isMesh) return;
    const n = o.material.name || '';
    if (n.startsWith('tint_') && tint[n.slice(5)]) {
      if (!o.userData.own) { o.material = o.material.clone(); o.userData.own = true; }
      o.material.color.set(tint[n.slice(5)]);
      if (o.material.map) o.material.color.multiplyScalar(TEX_GAIN);
    }
    if (n === 'screen' && screen) {
      if (!o.userData.own) { o.material = o.material.clone(); o.userData.own = true; }
      o.material.emissive.set(screen); o.material.emissiveIntensity = 1.2;
    }
  });
}

async function placeProp(p, root) {
  const g = await loadProp(p.id);
  const o = g.scene.clone(true);
  o.position.fromArray(p.pos || [0, 0, 0]); o.rotation.y = (p.rot || 0) * DEG;
  if (p.scale !== undefined) Array.isArray(p.scale) ? o.scale.fromArray(p.scale) : o.scale.setScalar(p.scale);
  o.traverse(m => { if (m.isMesh) { m.castShadow = p.shadow !== false && !m.userData.noShadow; m.receiveShadow = true; } });
  applyTint(o, p.tint, p.screen);
  o.userData.prop = p; root.add(o);
  return o;
}

// ---------- characters ----------
async function loadChar(id) {
  if (!charCache[id]) charCache[id] = loader.loadAsync(BASE + '../characters/' + id + '.glb').then(g => {
    g.scene.traverse(o => {
      if (!o.isMesh) return;
      o.frustumCulled = false; o.castShadow = true; o.receiveShadow = true;
      const m = o.material, nm = (m.name || '').toLowerCase();
      if (/body|head/.test(nm) && !m.transparent) {
        const p = new THREE.MeshPhysicalMaterial(); THREE.MeshStandardMaterial.prototype.copy.call(p, m);
        Object.assign(p, { roughness: m.roughnessMap ? 1 : 0.52, sheen: 0.35, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xffffff), sheenColorMap: m.map, specularIntensity: 0.5 });
        o.material = p;
        if (/head/.test(nm)) addSkinDetail(p);
      } else if (nm === 'eyes') { m.roughness = 0.05; m.envMapIntensity = 1.2; }
      else if (m.alphaTest || m.transparent) {
        o.castShadow = false;
        if (m.alphaTest) { m.alphaToCoverage = true; m.alphaTest = 0.35; m.roughness = 0.85; m.envMapIntensity = 0.5; }
      }
    });
    return g;
  });
  return charCache[id];
}

function findBone(root, n) { let b = null; root.traverse(o => { if (o.isBone && o.name === n) b = o; }); return b; }

// mark: { pos:[x,y,z], rot:deg, type:'sit'|'stand' }. For 'sit', pos is the seat surface point under the hips.
async function placeChar(c, marks, root, mixers) {
  const g = await loadChar(c.char);
  const mk = marks[c.mark];
  // characters reuse one GLB: a second use of the same id needs its own skeleton
  const { clone } = await import('three/addons/utils/SkeletonUtils.js');
  const obj = clone(g.scene); root.add(obj);
  const mixer = new THREE.AnimationMixer(obj);
  const clipName = c.clip || (mk.type === 'sit' ? 'sit_idle' : 'stand_idle');
  const clip = g.animations.find(a => a.name === clipName);
  const act = mixer.clipAction(clip); act.play(); act.time = (c.phase || 0) * clip.duration; mixer.update(0);
  obj.rotation.y = (mk.rot || 0) * DEG;
  obj.position.set(0, 0, 0); obj.updateMatrixWorld(true);
  if (mk.type === 'sit') {
    // seated pelvis sits ~0.12 above the seat surface (same rule as the character viewer stool)
    const p = findBone(obj, 'pelvis').getWorldPosition(new THREE.Vector3());
    obj.position.set(mk.pos[0] - p.x, mk.pos[1] - (p.y - 0.12), mk.pos[2] - p.z);
  } else obj.position.fromArray(mk.pos);
  mixers.push(mixer);
  // director needs these to blend talk/idle and to find the actor by id
  Object.assign(obj.userData, { mixer, clips: g.animations, mark: mk, char: c.char, id: c.id || c.char });
  return obj;
}

// ---------- lights ----------
function buildLights(L = {}, scene, renderer, bounds) {
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = L.env ?? 0.55;
  const sun = new THREE.DirectionalLight(L.sunColor || '#fff3e2', L.sun ?? 2.2);
  sun.position.fromArray(L.sunPos || [3, 5, 2]);
  sun.castShadow = true; sun.shadow.mapSize.set(1024, 1024); sun.shadow.radius = 4;
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03;
  const r = bounds;
  Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 0.1, far: 30 });
  scene.add(sun); scene.add(sun.target);
  if (L.hemi !== 0) scene.add(new THREE.HemisphereLight(L.skyColor || '#dfe9f5', L.groundColor || '#8a7a68', L.hemi ?? 0.35));
  for (const p of L.points || []) {  // practical lamps: {pos, color, power, dist}
    const pl = new THREE.PointLight(p.color || '#ffd9a8', p.power ?? 3, p.dist ?? 4, 2); pl.position.fromArray(p.pos); scene.add(pl);
  }
}

// ---------- scene ----------
export async function loadScene(recipe, renderer, onProgress) {
  const R = typeof recipe === 'string' ? await (await fetch(recipe)).json() : recipe;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(R.background || '#dde6ee');
  const root = new THREE.Group(); scene.add(root);
  const cut = [], mixers = [], props = [];
  if (R.room) buildRoom(R.room, root, cut);
  if (R.outdoor) buildOutdoor(R.outdoor, root, scene);
  const bounds = R.room ? Math.max(R.room.w, R.room.d) * 0.75 : (R.outdoor.shadowSize || 8);
  buildLights(R.lights, scene, renderer, bounds);
  let done = 0; const total = (R.props || []).length + (R.cast || []).length;
  const tick = () => onProgress && onProgress(++done / total);
  await Promise.all((R.props || []).map(p => placeProp(p, root).then(o => { props.push(o); tick(); return o; })));
  const cast = await Promise.all((R.cast || []).map(c => placeChar(c, R.marks || {}, root, mixers).then(o => (tick(), o))));
  const api = {
    scene, recipe: R, props, cast, mixers,
    // hide walls whose outside faces the camera (and the ceiling when looking from above)
    update(camera, dt) {
      for (const c of cut) {
        if (c.ceil !== undefined) { c.obj.visible = camera.position.y < c.ceil; continue; }
        c.obj.visible = (camera.position.x - c.x) * c.nx + (camera.position.z - c.z) * c.nz > -0.05;
      }
      // dt 0 = only cut walls (the director poses actors itself; a mixer update would undo head-look)
      if (dt) for (const m of mixers) m.update(dt);
    },
    // variant: { room: {wall:{...}, floor:{...}}, tint: { tag: {slot:'#hex'} } }
    setVariant(v) {
      for (const o of props) {
        const t = v.tint && v.tint[o.userData.prop.tag];
        if (t) applyTint(o, t);
      }
      if (v.room) root.traverse(o => {
        if (!o.isMesh) return;
        if (v.room.wall && o.geometry.type === 'ExtrudeGeometry') o.material.color.set(v.room.wall).multiplyScalar(o.material.map ? TEX_GAIN : 1);
      });
    },
  };
  if (R.variants && R.variants.length) api.setVariant(R.variants[0]);
  return api;
}
