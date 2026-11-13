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

function viewQuery(it) {
  return `filename=${encodeURIComponent(it.filename)}` +
    (it.subfolder ? `&subfolder=${encodeURIComponent(it.subfolder)}` : '') +
    `&type=${encodeURIComponent(it.type ?? 'output')}`;
}

// Where a download lands. dest may be a file, a directory, or absent:
//   "E:/out/clip.mp4"  → that file
//   "E:/out/"          → E:/out/clip.mp4        (no extension → treated as a dir too)
//   "clips"            → <cwd>/clips/clip.mp4
//   omitted            → $DOWNLOAD_DIR/clip.mp4, else <cwd>/downloads/clip.mp4
function resolveDest(dest, filename) {
  let raw = String(dest ?? '').trim() || process.env.DOWNLOAD_DIR || path.join(process.cwd(), 'downloads');
  if (raw === '~' || raw.startsWith('~/') || raw.startsWith('~\\')) raw = path.join(os.homedir(), raw.slice(1));
  const full = path.resolve(raw);
  const isDir = /[\\/]$/.test(raw) ||
    (fs.existsSync(full) && fs.statSync(full).isDirectory()) ||
    !path.extname(full);
  return isDir ? path.join(full, filename) : full;
}

// Resolve one finished output by prompt_id (+ index when a job wrote several),
// fetch its bytes over /view and write them to a local file. Writing through
// HTTP (instead of copying the server-side path) is what makes it work for a
// remote ComfyUI: the file lands on the machine running THIS MCP server.
export async function downloadOutput({ prompt_id, index = 0, dest }) {
  if (!prompt_id) throw new Error('prompt_id is required');
  if (/^\d+$/.test(String(prompt_id).trim())) {
    throw new Error(`"${prompt_id}" is a queue number, not a prompt_id. Use the UUID returned by run_app (e.g. "24700a6f-…").`);
  }
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

  const savedTo = resolveDest(dest, it.filename);
  const bytes = await getBytes(`/view?${viewQuery(it)}`);
  fs.mkdirSync(path.dirname(savedTo), { recursive: true });
  fs.writeFileSync(savedTo, bytes);

  return {
    prompt_id,
    index: i,
    filename: it.filename,
    saved_to: savedTo,
    bytes: bytes.length,
    url: outputViewUrl(it),
  };
}

// Pull the first image/video out of a finished job, plus any STRING outputs.
// Only ComfyUI-side metadata (filename/subfolder/type + /view URL) is reported;
// server filesystem paths are deliberately omitted — a client that wants a local
// file calls download_output, which returns saved_to on the MCP host.
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
      const meta = { filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output', url: outputViewUrl(it) };
      if (key === 'videos' || /\.(mp4|webm|mov|mkv|gif)$/i.test(it.filename)) {
        return { kind: 'video', ...meta, extra: texts };
      }
      const data = await getBytes(`/view?${viewQuery(it)}`);
      const mime = /\.(jpe?g)$/i.test(it.filename) ? 'image/jpeg' : /\.webp$/i.test(it.filename) ? 'image/webp' : 'image/png';
      return { kind: 'image', ...meta, mime, b64: data.toString('base64'), extra: texts };
    }
  }
  return { kind: 'none', text: 'job finished but no image/video output was found', extra: texts };
}

// --------------------------------------------------------------------------- #
// Queue monitoring.
// --------------------------------------------------------------------------- #
// One finished job from /history, kept small enough for a small model to read.
function summarizeHistory(promptId, e) {
  const msgs = e?.status?.messages ?? [];
  const stamp = (name) => msgs.find((m) => m?.[0] === name)?.[1]?.timestamp;
  const finished = stamp('execution_success') ?? stamp('execution_error') ?? stamp('execution_interrupted');
  const outputs = Object.values(e?.outputs ?? {})
    .flatMap((o) => Object.values(o ?? {}))
    .flat()
    .filter((x) => x && typeof x === 'object' && x.filename)
    .map((x) => (x.subfolder ? `${x.subfolder}/${x.filename}` : x.filename));
  return {
    prompt_id: promptId,
    state: e?.status?.status_str === 'error' ? 'error' : 'completed',
    outputs,
    ...(finished ? { finished_at: new Date(finished).toISOString() } : {}),
  };
}

// recent > 0 also reads that many finished jobs from /history. jobStatus() leaves
// it at 0 so polling a job does not re-download history on every call.
async function getQueue({ recent = 0 } = {}) {
  const [q, hist] = await Promise.all([
    getJson('/queue'),
    recent > 0 ? getJson(`/history?max_items=${recent}`).catch(() => ({})) : null,
  ]);
  // ComfyUI queue entries are [queue_number, prompt_id, prompt, extra_data,
  // outputs_to_execute]. Very old builds sent [prompt_id, prompt, outputs].
  // Normalize both shapes and never confuse the queue number with the prompt_id.
  const slim = (arr) => (arr ?? []).map((e) => {
    const five = Array.isArray(e) && e.length >= 5;
    const queueNumber = five ? e[0] : null;
    const promptId = five ? e[1] : e?.[0];
    const prompt = (five ? e[2] : e?.[1]) ?? {};
    const classTypes = Object.values(prompt).slice(0, 4).map((n) => n?.class_type).filter(Boolean);
    return {
      prompt_id: String(promptId ?? ''),
      queue_number: queueNumber,
      node_count: Object.keys(prompt).length,
      class_types: classTypes,
    };
  });
  const out = { running: slim(q.queue_running), pending: slim(q.queue_pending) };
  if (hist) {
    // /history is ordered oldest -> newest; the model wants newest first.
    out.recent = Object.entries(hist).slice(-recent)
      .map(([id, e]) => summarizeHistory(id, e))
      .reverse();
  }
  return out;
}
export { getQueue };

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

// One non-blocking look at a job: queue first, then history. Also resolves a
// queue number shorthand while the job is still queued.
async function inspectJob(promptId) {
  let id = String(promptId ?? '').trim();
  const q = await getQueue();
  if (/^\d+$/.test(id)) {
    const hit = [...q.running, ...q.pending].find((e) => String(e.queue_number) === id);
    if (hit) id = hit.prompt_id;
  }
  const running = q.running.find((e) => e.prompt_id === id);
  if (running) return { prompt_id: id, state: 'running', queue_number: running.queue_number };
  const pending = q.pending.find((e) => e.prompt_id === id);
  if (pending) return { prompt_id: id, state: 'pending', queue_number: pending.queue_number };

  const hist = await getJson(`/history/${id}`).catch(() => ({}));
  const e = hist[id];
  if (!e) {
    return {
      prompt_id: id,
      state: 'unknown',
      hint: 'Use the UUID returned by run_app. A queue number only works while the job is queued; history is cleared after a ComfyUI restart.',
    };
  }
  if (e.status?.status_str === 'error') {
    const error = e.status.messages?.find((m) => m?.[0] === 'execution_error')?.[1]?.exception_message ?? 'execution error';
    return { prompt_id: id, state: 'error', error, entry: e };
  }
  const outs = Object.entries(e.outputs ?? {})
    .flatMap(([nid, o]) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object' && x.filename).map((x) => ({ node: nid, key: k, filename: x.filename, subfolder: x.subfolder ?? '', type: x.type ?? 'output' }))));
  return { prompt_id: id, state: 'completed', outputs: outs, entry: e };
}

// Block until the job is no longer running/pending, or the budget runs out.
// `entry` (raw /history entry) stays on the result for internal callers.
async function waitForFinal(promptId, waitS) {
  const started = Date.now();
  const budget = Math.max(0, Number(waitS) || 0) * 1000;
  const deadline = started + budget;
  for (;;) {
    const st = await inspectJob(promptId);
    if (st.state === 'completed' || st.state === 'error' || st.state === 'unknown') return st;
    const left = deadline - Date.now();
    if (left <= 0) {
      return { ...st, timed_out: true, waited_s: Math.round((Date.now() - started) / 1000) };
    }
    await sleep(Math.min(1000, left));
  }
}

// External shape: never leak the full prompt graph back to the model.
export async function jobStatus(promptId, { waitS = 0 } = {}) {
  const st = waitS > 0 ? await waitForFinal(promptId, waitS) : await inspectJob(promptId);
  const { entry, ...rest } = st;
  return rest;
}

// Used by run_app: returns the raw /history entry, throws on error or timeout.
export async function waitForJob(promptId, timeoutS = RUN_TIMEOUT_S) {
  const st = await waitForFinal(promptId, timeoutS);
  if (st.state === 'error') throw new Error(`ComfyUI error: ${st.error ?? 'execution error'}`);
  if (st.state === 'unknown') throw new Error(`no history for prompt_id ${st.prompt_id} (unknown, or cleared by ComfyUI)`);
  if (st.timed_out) {
    const err = new Error(`render not finished within ${timeoutS}s (prompt_id ${st.prompt_id}, state ${st.state})`);
    err.code = 'TIMEOUT';
    throw err;
  }
  return st.entry;
}
