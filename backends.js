// Motores de IA en la nube (el móvil no puede ejecutar TripoSR ni TRELLIS).
// Cada motor recibe (Blob de imagen, opciones, progress) y devuelve un ArrayBuffer GLB (glTF, Y arriba).

export class QuotaExceeded extends Error {}

const HF_SPACE = "https://tencent-hunyuan3d-2.hf.space";
const MESHY_API = "https://api.meshy.ai/openapi/v1";

const store = {
  get: (k) => { try { return localStorage.getItem("forja3d." + k) || ""; } catch { return ""; } },
  set: (k, v) => { try { localStorage.setItem("forja3d." + k, v); } catch { /* sin almacenamiento */ } },
  del: (k) => { try { localStorage.removeItem("forja3d." + k); } catch { /* sin almacenamiento */ } },
};
export const cuentas = {
  get: (name) => store.get(name),
  save(values) { for (const [k, v] of Object.entries(values)) if (v && v.trim()) store.set(k, v.trim()); },
  forget() { store.del("HF_TOKEN"); store.del("MESHY_API_KEY"); },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** fetch normal; si el WebView lo bloquea por CORS, usa la red nativa de Capacitor. */
async function netBytes(url) {
  try {
    const r = await fetch(url);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return await r.arrayBuffer();
  } catch (e) {
    const http = window.Capacitor?.Plugins?.CapacitorHttp;
    if (!http) throw e;
    const r = await http.request({ url, method: "GET", responseType: "blob" });
    const bin = atob(r.data);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out.buffer;
  }
}

// ------------------------------------------------------------ Hunyuan3D-2 (Hugging Face, gratis)

async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const line = chunk.split("\n").find((l) => l.startsWith("data:"));
      if (line) { if (onEvent(JSON.parse(line.slice(5).trim())) === "stop") return; }
    }
  }
}

async function runHunyuan(blob, opts, progress) {
  const token = cuentas.get("HF_TOKEN");
  const auth = token ? { Authorization: "Bearer " + token } : {};
  progress(0.15, "Subiendo la imagen a Hunyuan3D-2 (Hugging Face)…");
  const form = new FormData();
  form.append("files", blob, "imagen.png");
  const up = await fetch(HF_SPACE + "/upload", { method: "POST", body: form, headers: auth });
  if (!up.ok) throw new Error("No he podido subir la imagen (HTTP " + up.status + ")");
  const [path] = await up.json();

  progress(0.3, "Generando la forma 3D en la nube…");
  const session = Math.random().toString(36).slice(2);
  const join = await fetch(HF_SPACE + "/queue/join", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...auth },
    body: JSON.stringify({
      // mismo orden que /shape_generation: texto, imagen, 4 vistas, pasos, guía, semilla, resolución,
      // quitar fondo, chunks, semilla aleatoria
      data: ["", { path, meta: { _type: "gradio.FileData" } }, null, null, null, null,
        30, 5.0, opts.seed, opts.detail, true, 8000, false],
      fn_index: 5, session_hash: session,
    }),
  });
  if (!join.ok) throw new Error("Hunyuan3D-2 no acepta la petición (HTTP " + join.status + ")");

  const stream = await fetch(HF_SPACE + "/queue/data?session_hash=" + session, { headers: auth });
  let result = null, failure = null;
  await readSse(stream, (m) => {
    if (m.msg === "estimation") {
      progress(0.3, m.rank > 0 ? `En cola (puesto ${m.rank + 1})…` : "Generando la forma 3D en la nube…");
    } else if (m.msg === "process_starts") {
      progress(0.45, "Generando la forma 3D en la nube…");
    } else if (m.msg === "queue_full") {
      failure = "La cola de Hunyuan3D-2 está llena; prueba en unos minutos"; return "stop";
    } else if (m.msg === "process_completed") {
      if (m.success === false || !m.output?.data) failure = m.output?.error || "error desconocido";
      else result = m.output.data[0];
      return "stop";
    }
  });
  if (failure) {
    if (/quota/i.test(failure)) {
      throw new QuotaExceeded("Se ha acabado tu cuota gratuita de Hunyuan3D-2; se renueva con el tiempo." +
        (token ? "" : " Inicia sesión con tu cuenta de Hugging Face en «Cuentas» para tener más.") +
        " También puedes probar con Meshy.");
    }
    throw new Error(failure);
  }
  const file = result?.value ?? result;
  const url = file?.url || (file?.path ? HF_SPACE + "/file=" + file.path : null);
  if (!url) throw new Error("Hunyuan3D-2 no devolvió ningún modelo");
  progress(0.75, "Descargando el modelo…");
  return netBytes(url);
}

// ------------------------------------------------------------ Meshy (nube, de pago)

async function meshy(method, path, key, body) {
  const r = await fetch(MESHY_API + path, {
    method, headers: { Authorization: "Bearer " + key, ...(body ? { "Content-Type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) throw new Error("Meshy ha rechazado tu clave API. Revísala en «Cuentas»");
  if (r.status === 402) throw new Error("No te quedan créditos en Meshy");
  if (r.status === 429) throw new Error("Meshy ha recibido demasiadas peticiones; espera un poco");
  if (!r.ok) throw new Error("Meshy respondió HTTP " + r.status);
  return r.json();
}

export async function meshyBalance(key) {
  try { return (await meshy("GET", "/balance", key)).balance ?? null; }
  catch (e) { if (/clave|créditos/.test(e.message)) throw e; return null; }
}

function blobToDataUri(blob) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error);
    fr.readAsDataURL(blob);
  });
}

async function runMeshy(blob, opts, progress) {
  const key = cuentas.get("MESHY_API_KEY");
  if (!key) throw new Error("Falta tu clave API de Meshy. Añádela en «Cuentas»");
  progress(0.1, "Enviando la imagen a Meshy…");
  // Sin textura: para imprimir solo importa la forma y así gasta menos créditos.
  const { result: id } = await meshy("POST", "/image-to-3d", key,
    { image_url: await blobToDataUri(blob), should_texture: false });
  const deadline = Date.now() + 15 * 60 * 1000;
  let task;
  for (;;) {
    task = await meshy("GET", "/image-to-3d/" + id, key);
    if (task.status === "SUCCEEDED") break;
    if (["FAILED", "CANCELED", "EXPIRED"].includes(task.status)) {
      throw new Error(`Meshy no pudo generar el modelo (${task.task_error?.message || task.status})`);
    }
    if (Date.now() > deadline) throw new Error("Meshy está tardando demasiado; inténtalo más tarde");
    progress(0.15 + 0.6 * (task.progress || 0) / 100, `Generando en Meshy… ${task.progress || 0} %`);
    await sleep(5000);
  }
  progress(0.8, "Descargando el modelo de Meshy…");
  return netBytes(task.model_urls.glb);
}

export const BACKENDS = [
  { key: "hunyuan", label: "☁️ Hunyuan3D-2", tag: "recomendado",
    description: "Gratis vía Hugging Face. Mejor forma para imprimir. ~20 s.", run: runHunyuan },
  { key: "meshy", label: "💎 Meshy", tag: "de pago",
    description: "Calidad profesional. Gasta créditos de tu cuenta de Meshy.", run: runMeshy },
];
