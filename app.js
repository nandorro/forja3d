import * as THREE from "three";
import { GLTFLoader } from "./vendor/addons/GLTFLoader.js";
import { OrbitControls } from "./vendor/addons/OrbitControls.js";
import { BACKENDS, QuotaExceeded, cuentas, meshyBalance } from "./backends.js";
import { prepareForPrint, toBinaryStl } from "./mesh.js";

const $ = (id) => document.getElementById(id);
let imageBlob = null, backendKey = "hunyuan", detail = 256, lastStl = null, busy = false;

// ---------------------------------------------------------------- Interfaz
for (const b of BACKENDS) {
  const l = document.createElement("label");
  l.className = "engine" + (b.key === backendKey ? " on" : "");
  l.innerHTML = `<b><input type="radio" name="engine" value="${b.key}" ${b.key === backendKey ? "checked" : ""}>` +
    `${b.label}<small>${b.tag}</small></b><span>${b.description}</span>`;
  l.querySelector("input").onchange = () => {
    backendKey = b.key;
    document.querySelectorAll(".engine").forEach((e) => e.classList.toggle("on", e === l));
  };
  $("engines").append(l);
}
$("height").oninput = (e) => ($("hVal").textContent = e.target.value);
$("detail").onclick = (e) => {
  const v = e.target.dataset?.v;
  if (!v) return;
  detail = +v;
  [...$("detail").children].forEach((b) => b.classList.toggle("on", b === e.target));
};
$("file").onchange = (e) => {
  const f = e.target.files[0];
  if (!f) return;
  imageBlob = f;
  $("thumb").src = URL.createObjectURL(f);
  $("thumb").hidden = false;
  $("drop").classList.add("has");
  $("generate").disabled = false;
};

function setProgress(p, msg) {
  $("progress").hidden = false;
  $("bar").style.width = Math.round(p * 100) + "%";
  $("barText").textContent = msg;
}
function showError(msg) { $("error").textContent = msg; $("error").hidden = false; }

// Redimensiona a un máximo de 1024 px y pasa a PNG: sube menos datos y evita formatos raros (HEIC, WebP…).
async function normalizeImage(blob) {
  const bmp = await createImageBitmap(blob);
  const s = Math.min(1, 1024 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return new Promise((r) => c.toBlob(r, "image/png"));
}

// ---------------------------------------------------------------- GLB -> arrays planos
function parseGlb(buffer) {
  return new Promise((resolve, reject) => {
    new GLTFLoader().parse(buffer, "", (gltf) => {
      gltf.scene.updateMatrixWorld(true);
      const pos = [], idx = [];
      let base = 0;
      gltf.scene.traverse((o) => {
        if (!o.isMesh) return;
        const g = o.geometry, p = g.attributes.position, v = new THREE.Vector3();
        for (let i = 0; i < p.count; i++) {
          v.fromBufferAttribute(p, i).applyMatrix4(o.matrixWorld);
          pos.push(v.x, v.y, v.z);
        }
        if (g.index) for (let i = 0; i < g.index.count; i++) idx.push(base + g.index.getX(i));
        else for (let i = 0; i < p.count; i++) idx.push(base + i);
        base += p.count;
      });
      if (!idx.length) reject(new Error("El archivo generado no contiene una malla válida."));
      else resolve({ positions: Float32Array.from(pos), indices: Uint32Array.from(idx) });
    }, reject);
  });
}

// ---------------------------------------------------------------- Visor 3D (Z arriba, como el laminador)
let renderer, scene, camera, controls, meshObj;
function initViewer() {
  const el = $("viewer");
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0xf0f5ee);
  el.append(renderer.domElement);
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(40, 1, 1, 5000);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8899aa, 1.2));
  const d = new THREE.DirectionalLight(0xffffff, 1.4);
  d.position.set(1, -1.5, 2);
  scene.add(d);
  controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  new ResizeObserver(resize).observe(el);
  renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });
}
function resize() {
  const el = $("viewer");
  if (!el.clientWidth) return;
  renderer.setSize(el.clientWidth, el.clientHeight, false);
  camera.aspect = el.clientWidth / el.clientHeight;
  camera.updateProjectionMatrix();
}
function showMesh(m) {
  if (!renderer) initViewer();
  if (meshObj) { scene.remove(meshObj); meshObj.geometry.dispose(); }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(m.positions, 3));
  g.setIndex(new THREE.BufferAttribute(m.indices, 1));
  g.computeVertexNormals();
  meshObj = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: 0xc8c8cd, roughness: .6, metalness: .05 }));
  scene.add(meshObj);
  const grid = scene.getObjectByName("bed") || new THREE.GridHelper(400, 40, 0xaab4bb, 0xd3dade);
  grid.name = "bed"; grid.rotation.x = Math.PI / 2;
  scene.add(grid);
  const h = m.size[2], r = Math.max(m.size[0], m.size[1], h);
  controls.target.set(0, 0, h / 2);
  camera.position.set(r * 1.6, -r * 2.2, h * 0.9 + r * 0.8);
  camera.far = r * 30; camera.updateProjectionMatrix();
  resize();
}

// ---------------------------------------------------------------- Generar
$("generate").onclick = async () => {
  if (busy || !imageBlob) return;
  busy = true; $("generate").disabled = true; $("error").hidden = true; $("result").hidden = true;
  const backend = BACKENDS.find((b) => b.key === backendKey);
  const t0 = Date.now();
  try {
    setProgress(0.05, "Preparando la imagen…");
    const img = await normalizeImage(imageBlob);
    const glb = await backend.run(img, { detail, seed: parseInt($("seed").value, 10) || 1234 }, setProgress);
    setProgress(0.85, "Reparando y preparando para imprimir…");
    await new Promise((r) => setTimeout(r, 30)); // deja pintar el progreso
    const raw = await parseGlb(glb);
    const m = prepareForPrint(raw.positions, raw.indices, +$("height").value);
    lastStl = { name: `modelo_${new Date().toISOString().replace(/\D/g, "").slice(0, 14)}.stl`, buffer: toBinaryStl(m.positions, m.indices) };
    $("result").hidden = false;
    showMesh(m);
    const [x, y, z] = m.size.map((v) => v.toFixed(1));
    $("info").innerHTML =
      `<b>Tamaño:</b> ${x} × ${y} × ${z} mm<br><b>Caras:</b> ${m.faces.toLocaleString("es-ES")}<br>` +
      `<b>Volumen:</b> ${m.volumeCm3.toFixed(1)} cm³<br><b>Estado:</b> ` +
      (m.watertight ? "✅ Estanca (lista para imprimir)" : "⚠️ No estanca: revísala en el laminador") +
      `<br><b>Tiempo:</b> ${Math.round((Date.now() - t0) / 1000)} s · <b>Motor:</b> ${backend.label}`;
    setProgress(1, "¡Listo!");
    $("result").scrollIntoView({ behavior: "smooth" });
  } catch (e) {
    $("progress").hidden = true;
    showError(e instanceof QuotaExceeded ? e.message
      : `${backend.label} falló: ${String(e.message || e).replace(/\.$/, "")}. Prueba otra vez o cambia de motor.`);
  } finally {
    busy = false; $("generate").disabled = false;
  }
};

// ---------------------------------------------------------------- Guardar / compartir
function toBase64(buf) {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  return btoa(s);
}
$("share").onclick = async () => {
  if (!lastStl) return;
  const cap = window.Capacitor?.Plugins;
  try {
    if (cap?.Filesystem && cap?.Share) {
      const f = await cap.Filesystem.writeFile({ path: lastStl.name, data: toBase64(lastStl.buffer), directory: "CACHE" });
      await cap.Share.share({ title: "Modelo Forja3D", files: [f.uri], dialogTitle: "Guardar o enviar el STL" });
    } else { // navegador de escritorio (pruebas)
      const a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([lastStl.buffer], { type: "model/stl" }));
      a.download = lastStl.name; a.click();
    }
  } catch (e) {
    if (!/cancel/i.test(String(e.message || e))) showError("No he podido compartir el STL: " + (e.message || e));
  }
};

// ---------------------------------------------------------------- Cuentas
async function accountStatus() {
  const lines = [];
  const hf = cuentas.get("HF_TOKEN");
  if (!hf) lines.push("⬜ <b>Hugging Face:</b> sin cuenta (cuota gratuita mínima)");
  else {
    try {
      const r = await fetch("https://huggingface.co/api/whoami-v2", { headers: { Authorization: "Bearer " + hf } });
      if (!r.ok) throw 0;
      lines.push(`✅ <b>Hugging Face:</b> conectado como <b>${(await r.json()).name}</b>`);
    } catch { lines.push("⚠️ <b>Hugging Face:</b> el token no funciona; revísalo"); }
  }
  const mk = cuentas.get("MESHY_API_KEY");
  if (!mk) lines.push("⬜ <b>Meshy:</b> sin clave (no podrás usar Meshy)");
  else {
    try {
      const bal = await meshyBalance(mk);
      lines.push(`✅ <b>Meshy:</b> clave guardada${bal != null ? ` · saldo: <b>${bal}</b> créditos` : ""}`);
    } catch (e) { lines.push(`⚠️ <b>Meshy:</b> ${e.message}`); }
  }
  $("accountInfo").innerHTML = lines.join("<br>");
}
$("saveAcc").onclick = () => {
  cuentas.save({ HF_TOKEN: $("hf").value, MESHY_API_KEY: $("meshy").value });
  $("hf").value = $("meshy").value = "";
  accountStatus();
};
$("forget").onclick = () => { cuentas.forget(); accountStatus(); };
$("accounts").addEventListener("toggle", () => { if ($("accounts").open) accountStatus(); });
