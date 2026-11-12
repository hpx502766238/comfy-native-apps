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
// COMFYUI_URL is the one address the MCP server uses to reach ComfyUI, e.g.
// "http://127.0.0.1:8188" or "https://gpu.example.com/comfy". The old
// COMFYUI_HOST + COMFYUI_PORT pair still works as a fallback.
const trimSlashes = (u) => String(u).replace(/\/+$/, '');
export const BASE = trimSlashes(
  process.env.COMFYUI_URL
    ? process.env.COMFYUI_URL
    : `http://${process.env.COMFYUI_HOST ?? '127.0.0.1'}:${process.env.COMFYUI_PORT ?? '8188'}`,
);
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

  // Top-level graph: the subgraph REFERENCE node plus the output/saver nodes the
  // app author left outside the subgraph (SaveImage, VHS_VideoCombine, SaveVideo,
  // PrimitiveFloat feeding frame_rate, …). The top-level links use the compact
  // UI array form [id, origin_id, origin_slot, target_id, target_slot, type].
  const topNodes = raw.nodes ?? [];
  const topLinks = (raw.links ?? []).map((l) => Array.isArray(l)
    ? { id: l[0], origin_id: l[1], origin_slot: l[2], target_id: l[3], target_slot: l[4], type: l[5] }
    : l);
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
    refNodeId: refNode ? refNode.id : null,
    // Ids of every subgraph defined in the file. A top-level node whose type is
    // one of these is a NESTED subgraph reference: it cannot be sent to the API
    // as-is (its class_type would be a UUID), so the converter stops there.
    subgraphIds: (raw.definitions?.subgraphs ?? []).map((s) => s.id),
    nodesById,
    linksById,
    topNodes,
    topLinks,
    inputs,
    outputs,
    portValues,
    portOverrides,
  };
}

// --------------------------------------------------------------------------- #
// UI → API conversion.
// --------------------------------------------------------------------------- #
// ComfyUI's web frontend expands %date:FORMAT% style tokens in filename prefixes
// right before submitting the prompt; the raw API does not. Without expanding them
// yourself, a workflow like VHS_VideoCombine's
// "%date:yyyy-MM-dd%/%date:yyyyMMdd_hhmmss%_Wan2.2" makes the backend mkdir a
// literal "%date:yyyy-MM-dd%" folder and fail with WinError 267.
const pad2 = (n, w = 2) => String(n).padStart(w, '0');
function formatDateTokens(date, fmt) {
  const h24 = date.getHours();
  const h12 = h24 % 12 || 12;
  const map = {
    yyyy: String(date.getFullYear()),
    yy: pad2(date.getFullYear() % 100),
    fff: pad2(date.getMilliseconds(), 3),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    dd: pad2(date.getDate()),
    d: String(date.getDate()),
    HH: pad2(h24),
    H: String(h24),
    hh: pad2(h12),
    h: String(h12),
    mm: pad2(date.getMinutes()),
    m: String(date.getMinutes()),
    ss: pad2(date.getSeconds()),
    s: String(date.getSeconds()),
  };
  return fmt.replace(/yyyy|yy|fff|MM|M|dd|d|HH|H|hh|h|mm|m|ss|s/g, (t) => map[t]);
}
export function expandFilenameTokens(value) {
  if (typeof value !== 'string' || !value.includes('%')) return value;
  const now = new Date();
  const out = value
    .replace(/%date:([^%]+)%/g, (_, f) => formatDateTokens(now, f))
    .replace(/%date%/g, formatDateTokens(now, 'yyyy-MM-dd'))
    .replace(/%time%/g, formatDateTokens(now, 'HHmmss'))
    .replace(/%year%/g, String(now.getFullYear()))
    .replace(/%month%/g, pad2(now.getMonth() + 1))
    .replace(/%day%/g, pad2(now.getDate()))
    .replace(/%hour%/g, pad2(now.getHours()))
    .replace(/%minute%/g, pad2(now.getMinutes()))
    .replace(/%second%/g, pad2(now.getSeconds()));
  // Anything still token-shaped would be an unknown token (e.g. %width%, %seed%):
  // drop it rather than let it produce an invalid path on the backend.
  return out.replace(/%[^%]*%/g, '');
}

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

  // ------------------------------------------------------------------------- #
  // Top-level output chain (THIS is what actually writes the file).
  //
  // A native app keeps only the model graph inside the subgraph; the node that
  // saves the result (SaveImage / SaveImageAdvanced / VHS_VideoCombine /
  // SaveVideo / SaveAnimatedWEBM / …) stays at the TOP level, fed by the
  // subgraph reference node's outputs. Converting only the subgraph therefore
  // never runs that saver: image-to-video apps used to come back as 48 loose
  // PNG frames (and only the first one reached the model) instead of an .mp4.
  // So convert every top-level node reachable from a subgraph output as well.
  // ------------------------------------------------------------------------- #
  const refId = app.refNodeId ?? null;
  const topNodes = app.topNodes ?? [];
  const topLinks = app.topLinks ?? [];
  const topById = new Map(topNodes.map((n) => [n.id, n]));
  const nestedIds = new Set(app.subgraphIds ?? []);
  // Only "always" nodes are converted. A node whose type is a subgraph UUID is a
  // nested subgraph reference — the API can't execute it, so the chain stops here
  // (the output falls back to a synthetic saver instead of an invalid prompt).
  const isActive = (n) => !!n && (n.mode === undefined || n.mode === null || n.mode === 0) && !nestedIds.has(n.type);
  // Top-level node ids live in a different namespace than the subgraph's internal
  // ids even in the UI, so prefix them to guarantee no key collision in the API prompt.
  const topKey = (id) => `t${id}`;

  // Nodes downstream of one specific subgraph output port (index = ref output slot).
  const reachFromSlot = (slot) => {
    const reach = new Set();
    if (refId == null) return reach;
    const queue = [];
    const pushTarget = (l) => {
      const t = topById.get(l.target_id);
      if (!t || !isActive(t) || reach.has(l.target_id)) return;
      reach.add(l.target_id);
      queue.push(l.target_id);
    };
    for (const l of topLinks) if (l.origin_id === refId && l.origin_slot === slot) pushTarget(l);
    while (queue.length) {
      const cur = queue.shift();
      for (const l of topLinks) if (l.origin_id === cur) pushTarget(l);
    }
    return reach;
  };

  const perPortReach = app.outputs.map((_, i) => reachFromSlot(i));
  const allReach = new Set();
  for (const r of perPortReach) for (const id of r) allReach.add(id);

  // Literal value of a helper node that stayed outside the converted set
  // (e.g. PrimitiveFloat -> VHS_VideoCombine.frame_rate). Only primitive-style
  // nodes are read this way; anything else (a nested subgraph, another graph
  // node) would hand the prompt a bogus value, so it is left unset.
  const PRIMITIVE_RE = /^(Primitive(Int|Float|String|Boolean)?|INTConstant|FLOATConstant|STRINGConstant|BOOLEANConstant|.*Primitive.*|.*Seed.*|CR Seed|ComfySwitchNode)$/i;
  const literalOf = (node) => {
    if (!PRIMITIVE_RE.test(String(node.type ?? ''))) return null;
    if (Array.isArray(node.widgets_values) && node.widgets_values.length) return node.widgets_values[0];
    const vals = Object.values(node.widgets_values_named ?? {});
    return vals.length ? vals[0] : null;
  };

  // Widget values of a top-level node. Plain nodes only have the positional
  // widgets_values array (order = the node's widget inputs), while nodes saved by
  // newer frontends may carry widgets_values_named or an object directly.
  const widgetMapOf = (n) => {
    const out = {};
    const wv = n.widgets_values;
    if (wv && !Array.isArray(wv) && typeof wv === 'object') Object.assign(out, wv);
    else if (Array.isArray(wv)) {
      const names = (n.inputs ?? []).filter((i) => i.widget).map((i) => i.name);
      names.forEach((nm, i) => { if (i < wv.length) out[nm] = wv[i]; });
    }
    return { ...out, ...(n.widgets_values_named ?? {}) };
  };

  for (const id of allReach) {
    const n = topById.get(id);
    if (!n) continue;
    const named = widgetMapOf(n);
    const inputs = {};
    for (const s of n.inputs ?? []) {
      if (s.link != null) {
        const l = topLinks.find((x) => x.id === s.link);
        if (!l) continue;
        if (l.origin_id === refId) {
          const port = app.outputs[l.origin_slot];
          if (port && port.producerNodeId != null) inputs[s.name] = [String(port.producerNodeId), port.producerSlot];
        } else if (allReach.has(l.origin_id)) {
          inputs[s.name] = [topKey(l.origin_id), l.origin_slot];
        } else {
          const origin = topById.get(l.origin_id);
          const v = origin ? literalOf(origin) : null;
          if (v !== null && v !== undefined) inputs[s.name] = v;
        }
      } else if (s.widget && s.name in named) {
        inputs[s.name] = named[s.name];
      }
    }
    // Widgets that belong to the API contract even though the UI lists them as
    // plain widgets. Frontend-only extras (VHS "videopreview", …) are dropped.
    for (const [k, v] of Object.entries(named)) {
      if (k in inputs) continue;
      if ((n.inputs ?? []).some((i) => i.name === k)) continue;
      if (/preview/i.test(k)) continue;
      inputs[k] = v;
    }
    prompt[topKey(n.id)] = { class_type: n.type, inputs };
  }

  // Only add a synthetic saver when the app's own top-level saver is absent
  // (hand-edited workflow, muted saver, headless import, …), so we never dump a
  // frame sequence next to the real video/image the author configured.
  const SAVER_RE = /^(VHS_VideoCombine|SaveVideo|SaveAnimatedWEBM|SaveAnimatedPNG|SaveImage|SaveImageAdvanced|SaveAudio|SaveAudioMP3|SaveAudioOpus)$/;
  let saverId = 999000;
  for (let i = 0; i < app.outputs.length; i++) {
    const out = app.outputs[i];
    if (out.producerNodeId == null) continue;
    const handled = [...perPortReach[i]].some((nid) => SAVER_RE.test(String(topById.get(nid)?.type ?? '')));
    if (handled) continue;
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
  // Expand %date:…% style filename tokens once for the whole prompt (frontend job).
  for (const node of Object.values(prompt)) {
    for (const [k, v] of Object.entries(node.inputs ?? {})) {
      if (typeof v === 'string' && /filename|prefix/i.test(k)) node.inputs[k] = expandFilenameTokens(v);
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
  // Numbering matches list_apps: EVERY app gets a sequential number (bad apps too),
  // so a model that read list_apps and says "11" gets #11 here, never shifted.
  const n = Number(ref);
  if (Number.isInteger(n) && n >= 1 && n <= apps.length) {
    const a = apps[n - 1];
    if (a.error) throw new Error(`app #${n} is unreadable: ${a.error}`);
    return a;
  }
  if (/^\d+$/.test(String(ref))) {
    const i = Number(ref);
    if (i >= 1 && i <= apps.length) {
      const a = apps[i - 1];
      if (a.error) throw new Error(`app #${i} is unreadable: ${a.error}`);
      return a;
    }
    throw new Error(`app #${ref} out of range (1..${apps.length})`);
  }
  const ok = apps.filter((a) => !a.error);
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
  throw new Error(`no app named "${ref}" - available: ${ok.map((a) => a.name).join(', ') || '(none)'}`);
}
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

// Upload a LOCAL file (image/video/audio/mask — anything you can load from the
// input dir) into ComfyUI's /upload/ dir. Multipart like the frontend's Upload.
// `subfolder` is relative to the input dir (e.g. "mybatch"); the returned path
// ("mybatch/name") is exactly what a LoadImage / LoadAudio / LoadVideo / Load
// Mask input expects in run_app values.
export async function uploadFile(localPath, subfolder = '') {
  const abs = path.resolve(localPath);
  if (!fs.existsSync(abs)) throw new Error(`file not found: ${localPath}`);
  const name = path.basename(abs);
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(abs)]), name);
  if (subfolder) form.append('subfolder', subfolder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''));
  const r = await fetch(BASE + '/upload/image', { method: 'POST', body: form });
  if (!r.ok) throw new Error(`ComfyUI /upload/image HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  return { name: j.name ?? name, subfolder: j.subfolder ?? '', type: j.type ?? 'input', path: ((j.subfolder ? j.subfolder + '/' : '') + (j.name ?? name)).replace(/\\/g, '/') };
}

export async function getBytes(p) {
  const r = await fetch(BASE + p);
  if (!r.ok) throw new Error(`ComfyUI ${p} HTTP ${r.status}`);
  return Buffer.from(await r.arrayBuffer());
}

// Client-reachable base for download links. COMFYUI_PUBLIC_URL is for the case
// where this MCP host can reach ComfyUI at COMFYUI_URL but the client cannot
// (container network, reverse proxy, SSH tunnel, …).
const PUBLIC_BASE = (process.env.COMFYUI_PUBLIC_URL || BASE).replace(/\/+$/, '');

export function outputViewUrl(it) {
  return `${PUBLIC_BASE}/view?filename=${encodeURIComponent(it.filename)}` +
    (it.subfolder ? `&subfolder=${encodeURIComponent(it.subfolder)}` : '') +
    `&type=${encodeURIComponent(it.type ?? 'output')}`;
}

// Real path on THIS machine, or null. Returns null for a remote ComfyUI or a
// non-local output dir, so callers are never handed a fake local path.
async function localPathOf(it) {
  const root = await getOutputRoot().catch(() => '');
  if (!root) return null;
  const full = path.join(root, it.subfolder ?? '', it.filename);
  return fs.existsSync(full) ? full : null;
}

// Resolve one finished output by prompt_id (+ index when a job wrote several)
// and return a client-reachable /view URL. Everything (filename, subfolder,
// type) comes from /history, so callers never need to know ComfyUI's layout.
export async function downloadOutput({ prompt_id, index = 0 }) {
  if (!prompt_id) throw new Error('prompt_id is required');
  const hist = await getJson(`/history/${encodeURIComponent(prompt_id)}`).catch(() => ({}));
  const entry = hist[prompt_id];
  if (!entry) throw new Error(`no history for prompt_id ${prompt_id} (unknown, or cleared by ComfyUI)`);
  if (entry.status?.status_str === 'error') {
    const msg = entry.status?.messages?.find((m) => m?.[0] === 'execution_error')?.[1]?.exception_message;
    throw new Error(`job ${prompt_id} failed: ${msg ?? 'execution error'}`);
  }
  const items = Object.values(entry.outputs ?? {})
    .flatMap((o) => ['images', 'videos', 'gifs'].flatMap((k) => (Array.isArray(o?.[k]) ? o[k] : [])))
    .filter((x) => x && typeof x === 'object' && x.filename);
  if (!items.length) throw new Error(`job ${prompt_id} has no downloadable outputs (state: ${entry.status?.status_str ?? 'unknown'})`);
  const i = Math.max(0, Number(index) || 0);
  const it = items[i];
  if (!it) throw new Error(`index ${index} out of range: job ${prompt_id} has ${items.length} output(s)`);
  const out = {
    prompt_id,
    index: i,
    filename: it.filename,
    subfolder: it.subfolder ?? '',
    type: it.type ?? 'output',
    url: outputViewUrl(it),
  };
  const local = await localPathOf(it);
  if (local) out.path = local;
  return out;
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

// Resolve ComfyUI's output dir so we can report a full path the user can open.
// Prefer COMFYUI_OUTPUT_DIR, then the running server's --output-directory argv,
// then <ComfyUI>/output next to the detected user dir.
let outputRootPromise;
export function getOutputRoot() {
  if (process.env.COMFYUI_OUTPUT_DIR) return Promise.resolve(process.env.COMFYUI_OUTPUT_DIR);
  if (!outputRootPromise) {
    outputRootPromise = (async () => {
      try {
        const s = await getJson('/system_stats');
        const argv = s?.system?.argv ?? [];
        const i = argv.indexOf('--output-directory');
        if (i >= 0 && argv[i + 1]) return path.resolve(argv[i + 1]);
      } catch { /* fall through to the layout guess */ }
      return path.join(path.dirname(resolveWorkflowsRoot()), 'output');
    })();
  }
  return outputRootPromise;
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
      const meta = { filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output', url: outputViewUrl(it) };
      const local = await localPathOf(it);
      if (key === 'videos' || /\.(mp4|webm|mov|mkv|gif)$/i.test(it.filename)) {
        return { kind: 'video', ...meta, path: local, extra: texts };
      }
      const data = await getBytes(`/view?${q}`);
      const mime = /\.(jpe?g)$/i.test(it.filename) ? 'image/jpeg' : /\.webp$/i.test(it.filename) ? 'image/webp' : 'image/png';
      return { kind: 'image', ...meta, mime, b64: data.toString('base64'), path: local, extra: texts };
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
    .flatMap(([nid, o]) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object' && x.filename).map((x) => ({ node: nid, key: k, filename: x.filename, subfolder: x.subfolder ?? '', type: x.type ?? 'output' }))));
  return { prompt_id: promptId, state: 'completed', outputs: outs };
}
