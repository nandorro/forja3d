// Preparación de la malla para imprimir (equivale a mesh_tools.py de la versión de escritorio).
// Trabaja con arrays planos: positions = Float32Array [x,y,z,...], indices = Uint32Array [a,b,c,...].

/** Une vértices duplicados y elimina caras degeneradas. */
export function weld(positions, indices) {
  const map = new Map();
  const remap = new Uint32Array(positions.length / 3);
  const out = [];
  for (let i = 0; i < remap.length; i++) {
    // Cuantizamos para unir vértices separados por ruido de coma flotante.
    const k = Math.round(positions[3 * i] * 1e5) + "," + Math.round(positions[3 * i + 1] * 1e5) + "," +
      Math.round(positions[3 * i + 2] * 1e5);
    let id = map.get(k);
    if (id === undefined) {
      id = out.length / 3;
      map.set(k, id);
      out.push(positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]);
    }
    remap[i] = id;
  }
  const faces = [];
  for (let f = 0; f < indices.length; f += 3) {
    const a = remap[indices[f]], b = remap[indices[f + 1]], c = remap[indices[f + 2]];
    if (a !== b && b !== c && a !== c) faces.push(a, b, c);
  }
  return { positions: Float32Array.from(out), indices: Uint32Array.from(faces) };
}

/** Aristas de borde (usadas una sola vez en su sentido): son los agujeros de la malla. */
function boundaryEdges(indices) {
  const half = new Map(); // a*N+b -> true
  const N = 4294967296;
  for (let f = 0; f < indices.length; f += 3) {
    for (let e = 0; e < 3; e++) {
      const a = indices[f + e], b = indices[f + (e + 1) % 3];
      half.set(a * N + b, [a, b]);
    }
  }
  const open = [];
  for (const [key, [a, b]] of half) {
    if (!half.has(b * N + a)) open.push([a, b]);
  }
  return open;
}

/** Tapa los agujeros (abanico desde el centro de cada contorno). Devuelve true si queda estanca. */
export function fillHoles(positions, indices, maxLoop = 5000) {
  let pos = Array.from(positions);
  let idx = Array.from(indices);
  for (let pass = 0; pass < 3; pass++) {
    const open = boundaryEdges(idx);
    if (!open.length) break;
    const next = new Map(); // a -> [b,...]
    for (const [a, b] of open) {
      if (!next.has(a)) next.set(a, []);
      next.get(a).push(b);
    }
    const used = new Set();
    for (const [a0, b0] of open) {
      const k0 = a0 + ":" + b0;
      if (used.has(k0)) continue;
      const loop = [a0];
      used.add(k0);
      let cur = b0, guard = 0;
      while (cur !== a0 && guard++ < maxLoop) {
        loop.push(cur);
        const cand = (next.get(cur) || []).find((n) => !used.has(cur + ":" + n));
        if (cand === undefined) { cur = -1; break; }
        used.add(cur + ":" + cand);
        cur = cand;
      }
      if (cur !== a0 || loop.length < 3) continue; // contorno no cerrado: lo dejamos
      if (loop.length === 3) { idx.push(loop[1], loop[0], loop[2]); continue; }
      let cx = 0, cy = 0, cz = 0;
      for (const v of loop) { cx += pos[3 * v]; cy += pos[3 * v + 1]; cz += pos[3 * v + 2]; }
      const c = pos.length / 3;
      pos.push(cx / loop.length, cy / loop.length, cz / loop.length);
      for (let i = 0; i < loop.length; i++) {
        const a = loop[i], b = loop[(i + 1) % loop.length];
        idx.push(b, a, c); // sentido contrario a la arista abierta para cerrar la malla
      }
    }
  }
  return { positions: Float32Array.from(pos), indices: Uint32Array.from(idx), watertight: boundaryEdges(idx).length === 0 };
}

/** Volumen firmado en mm³ (negativo = caras hacia dentro). */
export function signedVolume(p, idx) {
  let v = 0;
  for (let f = 0; f < idx.length; f += 3) {
    const a = 3 * idx[f], b = 3 * idx[f + 1], c = 3 * idx[f + 2];
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

/**
 * Pasos de prepare_for_print: une vértices, tapa agujeros, orienta (Z arriba, desde glTF Y arriba),
 * escala a la altura pedida, centra en X/Y y apoya en Z=0.
 */
export function prepareForPrint(positions, indices, heightMm) {
  let m = weld(positions, indices);
  m = fillHoles(m.positions, m.indices);
  const p = m.positions;
  // glTF usa Y arriba; las impresoras Z arriba: (x, y, z) -> (x, -z, y)
  for (let i = 0; i < p.length; i += 3) {
    const y = p[i + 1], z = p[i + 2];
    p[i + 1] = -z;
    p[i + 2] = y;
  }
  let min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) {
    min[k] = Math.min(min[k], p[i + k]); max[k] = Math.max(max[k], p[i + k]);
  }
  const height = max[2] - min[2];
  if (!(height > 0)) throw new Error("La malla generada no tiene altura.");
  const s = heightMm / height;
  const cx = (min[0] + max[0]) / 2, cy = (min[1] + max[1]) / 2;
  for (let i = 0; i < p.length; i += 3) {
    p[i] = (p[i] - cx) * s;
    p[i + 1] = (p[i + 1] - cy) * s;
    p[i + 2] = (p[i + 2] - min[2]) * s;
  }
  const idx = m.indices;
  if (signedVolume(p, idx) < 0) { // normales hacia dentro: giramos las caras
    for (let f = 0; f < idx.length; f += 3) { const t = idx[f + 1]; idx[f + 1] = idx[f + 2]; idx[f + 2] = t; }
  }
  const size = [(max[0] - min[0]) * s, (max[1] - min[1]) * s, heightMm];
  return {
    positions: p, indices: idx, watertight: m.watertight, size,
    faces: idx.length / 3, volumeCm3: Math.abs(signedVolume(p, idx)) / 1000,
  };
}

/** STL binario. */
export function toBinaryStl(p, idx) {
  const n = idx.length / 3;
  const buf = new ArrayBuffer(84 + n * 50);
  const dv = new DataView(buf);
  const head = "Forja3D";
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, n, true);
  let o = 84;
  for (let f = 0; f < n; f++) {
    const a = 3 * idx[3 * f], b = 3 * idx[3 * f + 1], c = 3 * idx[3 * f + 2];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    for (const v of [nx, ny, nz, p[a], p[a + 1], p[a + 2], p[b], p[b + 1], p[b + 2], p[c], p[c + 1], p[c + 2]]) {
      dv.setFloat32(o, v, true); o += 4;
    }
    dv.setUint16(o, 0, true); o += 2;
  }
  return buf;
}
