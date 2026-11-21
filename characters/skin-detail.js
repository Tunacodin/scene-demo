// Skin micro detail (idea from the CC5 quality reference, no CC5 asset used):
// a small procedural pore normal map, tiled many times over the face UV and blended
// on top of the character's own normal map. Glossy areas (eyes, lips) are masked out
// via the roughness map so they stay smooth.
import * as THREE from 'three';

let poreTex = null;

function makePoreTexture(size = 256, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const h = new Float32Array(size * size);
  const at = (x, y) => ((y + size) % size) * size + ((x + size) % size);
  // pores: small soft dips, wrapped so the tile is seamless
  for (let i = 0; i < 900; i++) {
    const cx = rnd() * size, cy = rnd() * size, r = 0.8 + rnd() * 1.6, d = 0.5 + rnd() * 0.5;
    const R = Math.ceil(r * 2.5);
    for (let y = -R; y <= R; y++) for (let x = -R; x <= R; x++) {
      const px = Math.floor(cx) + x, py = Math.floor(cy) + y;
      const dx = px - cx, dy = py - cy;
      h[at(px, py)] -= d * Math.exp(-(dx * dx + dy * dy) / (r * r));
    }
  }
  // fine grain
  for (let i = 0; i < h.length; i++) h[i] += (rnd() - 0.5) * 0.12;
  const data = new Uint8Array(size * size * 4);
  const k = 1.4;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const nx = (h[at(x - 1, y)] - h[at(x + 1, y)]) * k;
    const ny = (h[at(x, y - 1)] - h[at(x, y + 1)]) * k;
    const l = Math.hypot(nx, ny, 1);
    const o = (y * size + x) * 4;
    data[o] = (nx / l * 0.5 + 0.5) * 255;
    data[o + 1] = (ny / l * 0.5 + 0.5) * 255;
    data[o + 2] = (1 / l * 0.5 + 0.5) * 255;
    data[o + 3] = 255;
  }
  const t = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter; t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true; t.anisotropy = 4; t.needsUpdate = true;
  return t;
}

// m: a MeshStandard/Physical material that already has a tangent-space normalMap
export function addSkinDetail(m, { repeat = 30, strength = 0.55 } = {}) {
  if (!m || !m.normalMap || m.userData.skinDetail) return m;
  m.userData.skinDetail = true;
  poreTex = poreTex || makePoreTexture();
  const chunk = THREE.ShaderChunk.normal_fragment_maps.replace(
    'normal = normalize( tbn * mapN );',
    `{
      vec3 dN = texture2D( detailMap, vNormalMapUv * detailRepeat ).xyz * 2.0 - 1.0;
      float dk = detailStrength;
      #ifdef USE_ROUGHNESSMAP
        dk *= smoothstep( 0.3, 0.55, texture2D( roughnessMap, vRoughnessMapUv ).g );
      #endif
      mapN = normalize( vec3( mapN.xy + dN.xy * dk, mapN.z ) );
    }
    normal = normalize( tbn * mapN );`);
  m.onBeforeCompile = sh => {
    sh.uniforms.detailMap = { value: poreTex };
    sh.uniforms.detailRepeat = { value: repeat };
    sh.uniforms.detailStrength = { value: strength };
    sh.fragmentShader = 'uniform sampler2D detailMap;\nuniform float detailRepeat;\nuniform float detailStrength;\n'
      + sh.fragmentShader.replace('#include <normal_fragment_maps>', chunk);
  };
  m.customProgramCacheKey = () => 'skinDetail';
  m.needsUpdate = true;
  return m;
}
