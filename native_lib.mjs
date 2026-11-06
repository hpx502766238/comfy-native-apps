// native_lib.mjs — standalone helpers for comfy-native-mcp.
//
// Works ONLY on ComfyUI's NATIVE ".app.json" apps — the files the built-in
// "构建应用 / Build App" feature writes into the workflows directory. It has ZERO
// dependency on the artokun comfyui-mcp / comfyui-mcp-panel plugin: no panel HTTP
// routes, no manifest.json app bundles. It reads the .app.json straight off disk
// and talks to ComfyUI's core HTTP API directly.
//
// Because this server does the UI→API conversion itself, it runs identically
// against a ComfyUI that is headless (--front-end-version=0 / no UI) or one with
// the web frontend loaded. Only the stable core API is used.
//
// A native app file is a UI-format workflow whose whole graph is wrapped in ONE
// subgraph. The subgraph carries the declared I/O:
//
//   <…>/workflows/<any path>.app.json
//     definitions.subgraphs[0] = {
//       name,                       // friendly app name
//       inputNode  { id: -10 },     // the exposed-input "port" shell node
//       outputNode { id: -20 },     // the exposed-output "port" shell node
//       inputs[]  { id,name,type,label,linkIds },   // EXPOSED INPUTS (the contract)
//       outputs[] { id,name,type,linkIds },         // EXPOSED OUTPUTS
//       nodes[]    // the real workflow (CLIPTextEncode, KSampler, …)
//       links[]    { id,origin_id,origin_slot,target_id,target_slot,type }
//     }
//
// Each exposed input port links to an internal node's widget (usually a Primitive
// node), so a port tells us exactly which internal node+widget to fill.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --------------------------------------------------------------------------- #
// Config.
// --------------------------------------------------------------------------- #
const HOST = process.env.COMFYUI_HOST ?? '127.0.0.1';
const PORT = process.env.COMFYUI_PORT ?? '8188';
export const BASE = `http://${HOST}:${PORT}`;
export const RUN_TIMEOUT_S = Number(process.env.RUN_TIMEOUT_S ?? 300);

// --------------------------------------------------------------------------- #
// Workflows-root resolution. Native apps live under <comfyui user>/<user>/workflows/…
// --------------------------------------------------------------------------- #
const ROOT_CANDIDATES = [
  'E:/AIGenerationStudio/ComfyUI/ComfyUI/user',
  path.join(os.homedir(), 'AppData', 'Local', 'Programs', 'ComfyUI', 'resources', 'ComfyUI', 'user'),
  path.join(os.homedir(), 'Documents', 'ComfyUI', 'user'),
];
export function resolveWorkflowsRoot() {
  if (process.env.WORKFLOWS_ROOT) return process.env.WORKFLOWS_ROOT;
  for (const c of ROOT_CANDIDATES) if (fs.existsSync(c)) return c;
  return ROOT_CANDIDATES[0];
}

// Recursively collect every workflows/**\/*.app.json under the user root (apps may
// sit in nested subfolders like NSFW/文生图/…). Sorted for a stable numbering.
export function findNativeApps(root) {
  const out = [];
  const walk = (dir) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.app\.json$/i.test(e.name)) out.push(p);
    }
  };
  walk(root);
  return out.sort();
}

// --------------------------------------------------------------------------- #
// Load a native app: extract the subgraph, its ports, and a link/node index.
// --------------------------------------------------------------------------- #
export function loadNativeApp(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const sg = raw.definitions?.subgraphs?.[0];
  if (!sg) throw new Error(`not a native app (no subgraph): ${file}`);

  const nodesById = new Map((sg.nodes ?? []).map((n) => [n.id, n]));
  const linksById = new Map((sg.links ?? []).map((l) => [l.id, l]));
  const shellIn = sg.inputNode?.id ?? -10;

  // The subgraph REFERENCE node (top-level node whose type is the subgraph's id)
  // holds the app's actual I/O values in its widgets, keyed by PORT NAME. This is
  // the authoritative value for each exposed input port — the internal node's own
  // widget (e.g. a UNETLoader's template default) may be stale/different.
  const refNode = (raw.nodes ?? []).find((n) => n.type === sg.id);
  const portValues = refNode?.widgets_values_named ?? {};

  // Exposed INPUT ports. A port's link lands on an internal node's widget — that
  // (node, widget) pair is exactly where the model's value must go.
  const inputs = (sg.inputs ?? []).map((p) => {
    const link = p.linkIds?.[0] != null ? linksById.get(p.linkIds[0]) : undefined;
    const target = link ? nodesById.get(link.target_id) : undefined;
    const socket = target?.inputs?.[link.target_slot]?.name ?? null;
    const named = target?.widgets_values_named ?? {};
    return {
      portId: p.id,
      portName: p.name,
      label: p.label ?? p.name,
      type: p.type,
      targetNodeId: link ? link.target_id : null,
      targetSocket: socket,
      default: p.name in portValues ? portValues[p.name] : (socket && socket in named ? named[socket] : null),
    };
  });

  // Pre-populated overrides: each port's real value (from the ref node) applied to
  // the internal node+socket it feeds. User run_app values layer on top of these.
  const portOverrides = new Map();
  for (const inp of inputs) {
    if (inp.targetNodeId != null && inp.targetSocket != null && inp.portName in portValues) {
      portOverrides.set(`${inp.targetNodeId}:${inp.targetSocket}`, portValues[inp.portName]);
    }
  }

  // Exposed OUTPUT ports. A port's link is fed BY an internal node — record that
  // producer (node, slot) so we can attach a synthetic saver after conversion.
  const outputs = (sg.outputs ?? []).map((p) => {
    const link = p.linkIds?.[0] != null ? linksById.get(p.linkIds[0]) : undefined;
    const producer = link ? nodesById.get(link.origin_id) : undefined;
    return {
      name: p.label ?? p.localized_name ?? p.name,
      type: p.type,
      producerNodeId: producer ? producer.id : null,
      producerSlot: producer ? link.origin_slot : 0,
      producerType: producer ? producer.type : null,
    };
  });

  return {
    file,
    id: path.relative(resolveWorkflowsRoot(), file).replace(/\.app\.json$/i, '').replace(/\\/g, '/'),
    name: sg.name ?? path.basename(file, '.app.json'),
    description: raw.extra?.description ?? '',
    shellIn,
    nodesById,
    linksById,
    inputs,
    outputs,
    portValues,
    portOverrides,
  };
}

// --------------------------------------------------------------------------- #
// UI → API conversion.
// --------------------------------------------------------------------------- #
// Build a { "<nodeId>": { class_type, inputs } } prompt from the subgraph.
// `overrides` is a Map keyed `${nodeId}:${socketName}` → literal value (the model's
// filled-in params). Rules per input socket:
//   • override present                          -> the literal value
//   • linked from a REAL internal node           -> [origin_id, origin_slot]
//   • linked from the inputNode shell (-10)      -> an exposed-input port socket
//                                                   -> named default (no override)
//   • not linked (plain widget)                  -> named default
// Plus any widget present in widgets_values_named that is not a socket
// (e.g. KSampler's "control_after_generate") is appended so the prompt is complete.
export function graphToPrompt(app, overrides) {
  const { nodesById, linksById, shellIn } = app;
  // Port values (from the subgraph ref node) are the baseline; user overrides win.
  const eff = new Map(app.portOverrides ?? []);
  for (const [k, v] of overrides ?? []) eff.set(k, v);
  const prompt = {};
  for (const n of nodesById.values()) {
    const named = n.widgets_values_named ?? {};
    const inputs = {};
    for (const s of n.inputs ?? []) {
      const ov = eff.get(`${n.id}:${s.name}`);
      if (ov !== undefined) { inputs[s.name] = ov; continue; }
      if (s.link != null) {
        const l = linksById.get(s.link);
        if (l && l.origin_id !== shellIn && nodesById.has(l.origin_id)) {
          // ComfyUI's API prompt uses STRING node ids, both as keys and as the
          // first element of a [node_id, slot] link reference.
          inputs[s.name] = [String(l.origin_id), l.origin_slot];
        } else {
          inputs[s.name] = s.name in named ? named[s.name] : null;
        }
      } else {
        inputs[s.name] = s.name in named ? named[s.name] : null;
      }
    }
    for (const [k, v] of Object.entries(named)) if (!(k in inputs)) inputs[k] = v;
    prompt[n.id] = { class_type: n.type, inputs };
  }

  // Attach a synthetic saver for each IMAGE/VIDEO output so the result is written
  // to disk and we can fetch it via /view. (The native app's SaveImage node lives
  // at the top level, outside the subgraph, so it is not in the converted graph.)
  let saverId = 999000;
  for (const out of app.outputs) {
    if (out.producerNodeId == null) continue;
    const producer = String(out.producerNodeId);
    if (out.type === 'IMAGE') {
      prompt[++saverId] = {
        class_type: 'SaveImage',
        inputs: { images: [producer, out.producerSlot], filename_prefix: 'comfy_native_mcp' },
      };
    } else if (/VIDEO|ANIMATED|WEBM/i.test(out.type)) {
      prompt[++saverId] = {
        class_type: 'SaveAnimatedWEBM',
        inputs: { images: [producer, out.producerSlot], filename_prefix: 'comfy_native_mcp', fps: 8 },
      };
    }
  }
  return prompt;
}

// Coerce a model-supplied value to the type the port declared, so a 9B model
// sending seed "42" (string) or steps 8.0 instead of 8 still works.
export function coerceByType(value, type) {
  if (value === undefined || value === null) return value;
  switch ((type ?? '').toUpperCase()) {
    case 'STRING': return String(value);
    case 'INT': {
      const n = Number(value);
      return Number.isNaN(n) ? value : Math.trunc(n);
    }
    case 'FLOAT': return Number(value);
    case 'BOOLEAN': return value === true || value === 'true' || value === 1;
    default: return value;
  }
}

// Build the override map from the model's `values`. Keys may be a friendly port
// label ("prompt") or the exact "<nodeId>.<widget>" form. seed = -1 rolls random.
export function buildOverrides(app, values) {
  const ov = new Map();
  const byLabel = new Map(app.inputs.map((i) => [String(i.label), i]));
  for (const [rawKey, rawVal] of Object.entries(values ?? {})) {
    const key = String(rawKey).trim();
    const m = /^(\d+):(.+)$/.exec(key) || /^(\d+)\.(.+)$/.exec(key);
    let nodeId, socket, type;
    if (m) {
      nodeId = m[1]; socket = m[2];
      const p = app.inputs.find((i) => String(i.targetNodeId) === nodeId && i.targetSocket === socket);
      type = p?.type;
    } else {
      const p = byLabel.get(key);
      if (!p) throw new Error(`unknown param "${key}" — available: ${app.inputs.map((i) => i.label).join(', ')}`);
      nodeId = p.targetNodeId; socket = p.targetSocket; type = p.type;
    }
    if (nodeId == null || socket == null) throw new Error(`param "${key}" has no internal target`);
    let v = rawVal;
    if (/seed/i.test(socket) && Number(v) === -1) v = Math.floor(Math.random() * 0xffffffff);
    ov.set(`${nodeId}:${socket}`, coerceByType(v, type));
  }
  return ov;
}

// --------------------------------------------------------------------------- #
// Resolve a model-supplied app reference: 1-based index, name, id (rel path), or filename stem.
// --------------------------------------------------------------------------- #
export function listApps() {
  const root = resolveWorkflowsRoot();
  const files = findNativeApps(root);
  const apps = files.map((f, i) => {
    let a;
    try { a = loadNativeApp(f); } catch { return { number: i + 1, file: f, error: 'unreadable' }; }
    return {
      number: i + 1,
      name: a.name,
      id: a.id,
      file: f,
      description: a.description,
      inputs: a.inputs.map((inp) => {
        const p = { name: inp.label, type: inp.type };
        if (inp.default !== null && inp.default !== undefined) p.default = inp.default;
        return p;
      }),
      outputs: a.outputs.map((o) => ({ name: o.name, type: o.type })),
    };
  });
  return { workflowsRoot: root, count: apps.length, apps };
}

export function resolveAppRef(ref) {
  const { apps } = listApps();
  const ok = apps.filter((a) => !a.error);
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= ok.length) return ok[n - 1];
  if (/^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i >= 1 && i <= ok.length) return ok[i - 1];
    throw new Error(`app #${ref} out of range (1..${ok.length})`);
  }
  const r = String(ref).trim();
  const byId = ok.find((a) => a.id === r);
  if (byId) return byId;
  const byStem = ok.find((a) => path.basename(a.file, '.app.json') === r);
  if (byStem) return byStem;
  const byName = ok.find((a) => a.name === r);
  if (byName) return byName;
  const lower = r.toLowerCase();
  const fuzzy = ok.find((a) => a.name.toLowerCase() === lower);
  if (fuzzy) return fuzzy;
  throw new Error(`no app named "${ref}" — available: ${ok.map((a) => a.name).join(', ') || '(none)'}`);
}

// --------------------------------------------------------------------------- #
// ComfyUI core HTTP (no deps; global fetch). Stable across headless + frontend modes.
// --------------------------------------------------------------------------- #
export async function postPrompt(graph) {
  const r = await fetch(BASE + '/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: graph, client_id: 'comfy-native-mcp' }),
  });
  if (!r.ok) throw new Error(`ComfyUI /prompt HTTP ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.json();
}

export async function getJson(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`ComfyUI ${p} HTTP ${r.status}`);
  return r.json();
}

export async function postJson(p, body) {
  const r = await fetch(BASE + p, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  if (!r.ok) throw new Error(`ComfyUI ${p} HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  // /interrupt and /queue?clear answer with an empty 200 body — only parse if there is one.
  const t = await r.text();
  return t ? JSON.parse(t) : { ok: true };
}

export async function getBytes(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`ComfyUI ${p} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Poll /history/<pid> until done, error, or timeout.
export async function waitForJob(promptId) {
  const deadline = Date.now() + RUN_TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const hist = await getJson(`/history/${promptId}`).catch(() => ({}));
    const entry = hist[promptId];
    if (entry) {
      const status = entry.status ?? {};
      if (status.status_str === 'error') {
        const msgs = (status.messages ?? [])
          .filter((mm) => Array.isArray(mm) && mm[0] === 'execution_error')
          .map((mm) => (mm[1]?.exception_message ?? mm[1] ?? 'execution error'));
        throw new Error('ComfyUI error: ' + (msgs.join('; ') || 'unknown'));
      }
      if (status.completed || entry.outputs) return entry;
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  throw new Error(`render not finished within ${RUN_TIMEOUT_S}s (prompt_id ${promptId})`);
}

// Pull the first image/video out of a finished job, plus any STRING outputs.
export async function collectOutputs(entry) {
  const texts = [];
  for (const [nodeId, nodeOut] of Object.entries(entry.outputs ?? {})) {
    for (const [key, items] of Object.entries(nodeOut)) {
      if (Array.isArray(items) && items.length && typeof items[0] === 'string') texts.push(`${key}: ${items[0]}`);
    }
  }
  for (const nodeOut of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos']) {
      const items = nodeOut[key];
      if (!items?.length) continue;
      const it = items[0];
      const q = `filename=${encodeURIComponent(it.filename)}` +
        (it.subfolder ? `&subfolder=${encodeURIComponent(it.subfolder)}` : '') +
        `&type=${encodeURIComponent(it.type ?? 'output')}`;
      if (key === 'videos' || /\.(mp4|webm)$/i.test(it.filename)) {
        return { kind: 'video', filename: it.filename, text: `Saved video: ${it.filename}`, extra: texts };
      }
      const data = await getBytes(`/view?${q}`);
      const mime = /\.(jpe?g)$/i.test(it.filename) ? 'image/jpeg' : 'image/png';
      return { kind: 'image', filename: it.filename, mime, b64: data.toString('base64'), extra: texts };
    }
  }
  return { kind: 'none', text: 'job finished but no image/video output was found', extra: texts };
}

// --------------------------------------------------------------------------- #
// Queue monitoring.
// --------------------------------------------------------------------------- #
async function getQueue() {
  const q = await getJson('/queue');
  const slim = (arr) => (arr ?? []).map((e) => ({
    prompt_id: e[0],
    number: e[2],
    node_count: e[3]?.length ?? 0,
    class_types: (e[1] ?? Object.create(null)) && Object.values(e[1] ?? {}).slice(0, 4).map((n) => n?.class_type).filter(Boolean),
  }));
  return { running: slim(q.queue_running), pending: slim(q.queue_pending) };
}
export { getQueue };

export async function jobStatus(promptId) {
  const q = await getQueue();
  if (q.running.some((e) => e.prompt_id === promptId)) return { prompt_id: promptId, state: 'running' };
  if (q.pending.some((e) => e.prompt_id === promptId)) return { prompt_id: promptId, state: 'pending' };
  const hist = await getJson(`/history/${promptId}`).catch(() => ({}));
  const e = hist[promptId];
  if (!e) return { prompt_id: promptId, state: 'unknown' };
  if (e.status?.status_str === 'error') return { prompt_id: promptId, state: 'error', error: e.status.messages?.find((m) => m?.[0] === 'execution_error')?.[1]?.exception_message };
  const outs = Object.entries(e.outputs ?? {})
    .flatMap(([nid, o]) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object' && x.filename).map((x) => ({ node: nid, key: k, filename: x.filename }))));
  return { prompt_id: promptId, state: 'completed', outputs: outs };
}
