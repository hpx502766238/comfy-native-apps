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
// Media ports. An IMAGE/MASK/VIDEO/AUDIO port carries a *file*, and the file is
// owned by a top-level loader node outside the subgraph (the app author wires a
// LoadImage into the subgraph reference node). Writing the filename onto the
// IMAGE socket inside the subgraph hands a string to a node that expects a
// tensor, so media values are routed to the loader widget instead.
// --------------------------------------------------------------------------- #
const MEDIA_TYPES = new Set(['IMAGE', 'MASK', 'VIDEO', 'AUDIO']);
const MEDIA_OVERRIDE_PREFIX = '@media:';
const LOADER_WIDGETS = {
  LoadImage: 'image',
  LoadImageMask: 'image',
  LoadVideo: 'file',
  LoadAudio: 'audio',
  VHS_LoadVideo: 'video',
  VHS_LoadAudio: 'audio',
};
const loaderWidgetOf = (n) => {
  if (!n) return null;
  if (LOADER_WIDGETS[n.type]) return LOADER_WIDGETS[n.type];
  // LoadImageOutput reads the OUTPUT dir, not the input dir an upload lands in.
  if (n.type === 'LoadImageOutput' || !/Load/i.test(String(n.type ?? ''))) return null;
  const w = (n.inputs ?? []).find((i) => i.widget && ['image', 'file', 'audio', 'video'].includes(i.name));
  return w ? w.name : null;
};

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
  const topById = new Map(topNodes.map((n) => [n.id, n]));
  const topLinksById = new Map(topLinks.map((l) => [l.id, l]));
  const shellIn = sg.inputNode?.id ?? -10;
  const nestedIds = new Set((raw.definitions?.subgraphs ?? []).map((s) => s.id));

  // The subgraph REFERENCE node (top-level node whose type is the subgraph's id)
  // holds the app's actual I/O values in its widgets, keyed by PORT NAME. This is
  // the authoritative value for each exposed input port — the internal node's own
  // widget (e.g. a UNETLoader's template default) may be stale/different.
  const refNode = (raw.nodes ?? []).find((n) => n.type === sg.id);
  const portValues = refNode?.widgets_values_named ?? {};
  const refInputs = refNode?.inputs ?? [];

  // A bypassed node (mode 4) is absent from the API prompt: ComfyUI forwards an
  // input of the same type to its output. Resolve such a link to the real source.
  const resolveOrigin = (originId, originSlot) => {
    const seen = new Set();
    let id = originId;
    let slot = originSlot;
    for (;;) {
      const n = topById.get(id);
      if (!n || n.mode !== 4) return { nodeId: id, slot };
      if (seen.has(id)) return null;
      seen.add(id);
      const outType = n.outputs?.[slot]?.type;
      const idx = (n.inputs ?? []).findIndex((i) => i.type === outType && i.link != null);
      const inLink = idx >= 0 ? topLinksById.get(n.inputs[idx].link) : undefined;
      if (!inLink || inLink.origin_id === refNode?.id) return null;
      id = inLink.origin_id;
      slot = inLink.origin_slot;
    }
  };
  const upstreamOf = (id) => {
    const out = [];
    for (const l of topLinks) {
      if (l.target_id !== id || l.origin_id === refNode?.id) continue;
      const src = resolveOrigin(l.origin_id, l.origin_slot);
      if (src) out.push(src.nodeId);
    }
    return out;
  };

  // Follow a media port out of the subgraph: the port's shell link names the ref
  // node input slot, whose top-level link is the feed (e.g. LoadImage #140, or
  // Canny #57 fed by LoadImage #58). Returns the feed output, every top-level
  // node needed to produce it, and the nearest upstream loader that owns the
  // filename widget.
  const mediaFeed = (p) => {
    const shellLink = (p.linkIds ?? []).map((id) => linksById.get(id)).find((l) => l && l.origin_id === shellIn);
    const refInput = (shellLink ? refInputs[shellLink.origin_slot] : null) ?? refInputs.find((i) => i.name === p.name);
    const topLink = refInput?.link != null ? topLinksById.get(refInput.link) : undefined;
    if (!topLink) return { feed: null, chain: [], loader: null };
    const feed = resolveOrigin(topLink.origin_id, topLink.origin_slot);
    if (!feed) return { feed: null, chain: [], loader: null };

    const chain = new Set();
    const queue = [feed.nodeId];
    while (queue.length) {
      const id = queue.shift();
      const n = topById.get(id);
      if (!n || chain.has(id) || (n.mode != null && n.mode !== 0) || nestedIds.has(n.type)) continue;
      chain.add(id);
      for (const src of upstreamOf(id)) queue.push(src);
    }
    // A feed through a nested subgraph cannot be expressed in an API prompt; fall
    // back to the no-feed path rather than link to a node that will not exist.
    if (!chain.has(feed.nodeId)) return { feed: null, chain: [], loader: null };

    let loader = null;
    const seen = new Set();
    queue.push(feed.nodeId);
    while (queue.length && !loader) {
      const id = queue.shift();
      if (seen.has(id)) continue;
      seen.add(id);
      const n = topById.get(id);
      if (!n) continue;
      const widget = loaderWidgetOf(n);
      if (widget) loader = { nodeId: id, widget };
      else for (const src of upstreamOf(id)) queue.push(src);
    }
    return { feed, chain: [...chain], loader };
  };

  // Display-only nodes: they draw a widget or an image on the canvas for a human
  // to look at, but produce no value the workflow uses. If an author exposes one
  // as an input port (a "prompt preview" / "resolution preview"), it is scaffolding,
  // not a parameter — dropping it keeps get_app_params clean. A port is dropped
  // only when ALL of its targets are display-only, so a real node that happens to
  // feed a preview alongside it is never mistaken for one.
  const DISPLAY_NODE_TYPES = new Set(['PreviewAny', 'PreviewImage', 'PreviewText', 'ShowText', 'Debug']);

  // Exposed INPUT ports. A port's link lands on an internal node's widget — that
  // (node, widget) pair is exactly where the model's value must go.
  const buildShellInput = (p) => {
    const link = p.linkIds?.[0] != null ? linksById.get(p.linkIds[0]) : undefined;
    const target = link ? nodesById.get(link.target_id) : undefined;
    const socket = target?.inputs?.[link.target_slot]?.name ?? null;
    const named = target?.widgets_values_named ?? {};
    // One port can fan out to several internal widgets; every one needs the value.
    const targets = [];
    for (const lid of p.linkIds ?? []) {
      const l = linksById.get(lid);
      const s = l ? nodesById.get(l.target_id)?.inputs?.[l.target_slot]?.name : undefined;
      if (s) targets.push({ nodeId: l.target_id, socket: s });
    }
    const media = MEDIA_TYPES.has(p.type);
    const ext = media ? mediaFeed(p) : null;
    return {
      portId: p.id,
      portName: p.name,
      label: p.label ?? p.name,
      type: p.type,
      targets,
      default: p.name in portValues ? portValues[p.name] : (socket && socket in named ? named[socket] : null),
      ...(ext ? { media: true, feed: ext.feed, chain: ext.chain, loader: ext.loader } : {}),
    };
  };
  const shellInputs = (sg.inputs ?? [])
    .filter((p) => !(p.linkIds ?? []).length || (p.linkIds ?? []).some((lid) => {
      const l = linksById.get(lid);
      const n = l ? nodesById.get(l.target_id) : undefined;
      return n && !DISPLAY_NODE_TYPES.has(n.type);
    }))
    .map(buildShellInput);
  // The EXPOSED port surface. In a linearMode app (extra.linearData.inputs) the
  // author hand-picks the parameters, one entry per ["<uuid>:<nodeId>:<socket>",
  // label]. Those subgraph shell ports that are NOT picked (e.g. a nested
  // SeedVR2's seed/sampler/scheduler/denoise/...) are exactly what the linear
  // frontend hides — so they must not appear here either. `shellInputs` (the full
  // derived list) is kept separately for graphToPrompt's media-link machinery.
  let inputs = shellInputs;
  const ld = raw.extra?.linearData;
  if (ld?.inputs?.length && refNode) {
    const shellByName = new Map((sg.inputs ?? []).map((p) => [p.name, p]));
    const used = new Set();
    // A linearMode port's NAME is whatever the frontend renders on the canvas: the
    // TARGET socket's `label ?? localized_name ?? socket name`. The linearData
    // second element is only a short key ("image", "value", "aspect_ratio", …),
    // so it is kept as an ALIAS for existing run_app callers instead of the label.
    const displayName = (node, socketName) => {
      const s = (node.inputs ?? []).find((i) => i.name === socketName);
      return s ? (s.label ?? s.localized_name ?? s.name) : socketName;
    };
    const linearInputs = [];
    for (const [rawRef, rawLabel] of ld.inputs) {
      const parts = String(rawRef).split(':');
      const nodeId = Number(parts[1]);
      let socket = parts.slice(2).join(':');
      try { socket = decodeURIComponent(socket); } catch { /* keep verbatim */ }
      const n = topById.get(nodeId);
      if (!Number.isInteger(nodeId) || !socket || !n) continue;
      let label = displayName(nodeId === refNode.id ? refNode : n, socket);
      if (used.has(label)) {
        let i = 2;
        while (used.has(`${label} (${i})`)) i++;
        label = `${label} (${i})`;
      }
      used.add(label);
      const oldLabel = rawLabel != null ? String(rawLabel) : socket;
      if (nodeId === refNode.id) {
        // A socket on the main subgraph REF node = a subgraph input port. Adopt the
        // matching shell port wholesale so its internal targets, media feed and
        // default keep working (e.g. 四合一 `132:value`, `132:loras.*`, or the media
        // `image` feed that ends at the ref's 控制图 input).
        const sp = shellByName.get(socket);
        if (!sp) continue;
        const p = buildShellInput(sp);
        p.label = label;
        const old = sp.label ?? sp.name;
        p.aliases = [...new Set([oldLabel, sp.name, old, socket])].filter((a) => a && a !== label);
        linearInputs.push(p);
        continue;
      }
      // A socket on a PLAIN top-level node (camera/encoder/sampler/loader/...).
      const sock = (n.inputs ?? []).find((i) => i.name === socket) ?? null;
      const loadW = loaderWidgetOf(n);
      const media = !!loadW;
      const port = {
        portId: `@lin:${nodeId}:${socket}`,
        portName: socket,
        label,
        // Old linearData key and the raw socket name remain valid run_app keys.
        aliases: [...new Set([oldLabel, socket])].filter((a) => a && a !== label),
        type: media ? (n.outputs?.[0]?.type ?? 'IMAGE') : (sock?.type ?? 'STRING'),
        targets: [],
        // Media values are filenames for the loader widget, never a socket default.
        default: media ? undefined : (sock?.widget ? (n.widgets_values_named?.[socket] ?? null) : null),
        // Routes run_app values to the TOP-LEVEL node's widget (`@top:<nodeId>:<socket>`).
        linear: { nodeId, socket },
      };
      if (media) {
        port.media = true;
        port.feed = { nodeId, slot: 0 };
        port.chain = [nodeId];
        port.loader = { nodeId, widget: loadW };
      }
      linearInputs.push(port);
    }
    if (linearInputs.length) inputs = linearInputs;
  }

  // Pre-populated overrides: each port's real value (from the ref node) applied to
  // the internal node+socket it feeds. User run_app values layer on top of these.
  // A port can fan out to several nodes (e.g. one "channel" string driving two
  // Branch nodes), so every link of the port must receive the value — the others
  // would otherwise fall back to their own stale saved widget.
  const portOverrides = new Map();
  for (const p of sg.inputs ?? []) {
    // Media ports never take a literal from the ref node widget: their value is a
    // filename owned by the top-level loader (see mediaFeed above).
    if (MEDIA_TYPES.has(p.type)) continue;
    if (!(p.name in portValues)) continue;
    for (const lid of p.linkIds ?? []) {
      const link = linksById.get(lid);
      if (!link) continue;
      const socket = nodesById.get(link.target_id)?.inputs?.[link.target_slot]?.name;
      if (socket) portOverrides.set(`${link.target_id}:${socket}`, portValues[p.name]);
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
    // as-is (its class_type would be a UUID), so the converter inlines it
    // (graphToPrompt) instead of sending a UUID class_type.
    subgraphIds: [...nestedIds],
    subgraphs: raw.definitions?.subgraphs ?? [],
    nodesById,
    linksById,
    topNodes,
    topLinks,
    topById,
    inputs,
    // Full derived input-port list (all subgraph shell ports). `inputs` may be a
    // smaller, linearData-picked surface; graphToPrompt consults shellInputs for
    // the media-link wiring that keeps feeds flowing even for non-exposed ports.
    shellInputs,
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
// A list widget value (e.g. BranchNode's `branch_names`, an ARRAY rendered as a
// widget) must not reach the API prompt as a bare list: the server reads any list
// as a [node_id, slot] link and rejects it with bad_linked_input. Execution
// unwraps `{"__value__": [...]}` back to the list, which is the only accepted shape.
const asWidgetValue = (v) => (Array.isArray(v) ? { __value__: v } : v);

export function graphToPrompt(app, overrides) {
  const { nodesById, linksById, shellIn } = app;
  // Port values (from the subgraph ref node) are the baseline; user overrides win.
  // Media overrides arrive as `@media:<portId>` and are routed below, not applied
  // as literals: their value is a filename for a loader, never an IMAGE socket.
  const eff = new Map(app.portOverrides ?? []);
  const mediaValues = new Map();
  // Top-level widget overrides (`@top:<nodeId>:<socket>`, set by buildOverrides for
  // linearData ports): keyed by TOP-LEVEL node id so the value lands on the widget
  // of the emitted node (the node namespace differs from the subgraph's interior).
  const TOP_OVERRIDE_RE = /^@top:(\d+):(.+)$/;
  const topWidgetOverrides = new Map();
  const topOverrideNodes = new Set();
  for (const [k, v] of overrides ?? []) {
    if (k.startsWith('@top:')) {
      const m = TOP_OVERRIDE_RE.exec(k);
      if (m) {
        const nid = Number(m[1]);
        let map = topWidgetOverrides.get(nid);
        if (!map) topWidgetOverrides.set(nid, (map = new Map()));
        map.set(m[2], v);
        topOverrideNodes.add(nid);
      }
    } else if (k.startsWith(MEDIA_OVERRIDE_PREFIX)) mediaValues.set(k.slice(MEDIA_OVERRIDE_PREFIX.length), v);
    else eff.set(k, v);
  }
  // Top-level node ids live in a different namespace than the subgraph's internal
  // ids even in the UI, so prefix them to guarantee no key collision in the API prompt.
  const topKey = (id) => `t${id}`;

  // Media ports: internal consumers link to the top-level feed (or a synthetic
  // LoadImage); a supplied filename goes on the loader's widget. Ports fed from
  // outside keep working with their saved image even when no value is supplied.
  const mediaLinks = new Map();
  const feedReach = new Set();
  const syntheticLoads = [];
  let synthLoadId = 999100;
  // Iterate both the exposed input ports AND the full shell list: a linearData
  // media port (e.g. 四合一 `140:image`) carries the filename for the same loader
  // node that the hidden shell port (e.g. `控制图`) routes to its internal
  // consumers. Skipping either side would orphan the feed or the consumer link.
  const mediaPorts = [];
  {
    const seen = new Set();
    for (const p of [...(app.shellInputs ?? []), ...app.inputs]) {
      if (!p.media || seen.has(p.portId)) continue;
      seen.add(p.portId);
      mediaPorts.push(p);
    }
  }
  for (const p of mediaPorts) {
    if (!p.media) continue;
    const value = mediaValues.get(p.portId);
    let target = p.feed;
    let synthetic = false;
    if (value !== undefined) {
      if (p.loader) {
        let m = topWidgetOverrides.get(p.loader.nodeId);
        if (!m) topWidgetOverrides.set(p.loader.nodeId, (m = new Map()));
        m.set(p.loader.widget, String(value));
      } else {
        const type = p.type === 'AUDIO' ? 'LoadAudio' : p.type === 'VIDEO' ? 'LoadVideo' : 'LoadImage';
        const widget = p.type === 'AUDIO' ? 'audio' : p.type === 'VIDEO' ? 'file' : 'image';
        const id = ++synthLoadId;
        syntheticLoads.push({ id, type, widget, value: String(value) });
        target = { nodeId: id, slot: p.type === 'MASK' ? 1 : 0 };
        synthetic = true;
      }
    }
    if (!target) continue;
    if (!synthetic) for (const id of p.chain ?? []) feedReach.add(id);
    const linkId = synthetic ? String(target.nodeId) : topKey(target.nodeId);
    for (const t of p.targets ?? []) mediaLinks.set(`${t.nodeId}:${t.socket}`, [linkId, target.slot]);
  }
  const prompt = {};
  for (const s of syntheticLoads) prompt[s.id] = { class_type: s.type, inputs: { [s.widget]: s.value } };
  for (const n of nodesById.values()) {
    const named = n.widgets_values_named ?? {};
    const inputs = {};
    for (const s of n.inputs ?? []) {
      const ml = mediaLinks.get(`${n.id}:${s.name}`);
      if (ml) { inputs[s.name] = ml; continue; }
      const ov = eff.get(`${n.id}:${s.name}`);
      if (ov !== undefined) { inputs[s.name] = ov; continue; }
      if (s.link != null) {
        const l = linksById.get(s.link);
        if (l && l.origin_id !== shellIn && nodesById.has(l.origin_id)) {
          // ComfyUI's API prompt uses STRING node ids, both as keys and as the
          // first element of a [node_id, slot] link reference.
          inputs[s.name] = [String(l.origin_id), l.origin_slot];
        } else {
          inputs[s.name] = s.name in named ? asWidgetValue(named[s.name]) : null;
        }
      } else {
        inputs[s.name] = s.name in named ? asWidgetValue(named[s.name]) : null;
      }
    }
    for (const [k, v] of Object.entries(named)) if (!(k in inputs)) inputs[k] = asWidgetValue(v);
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
  const topLinksById = new Map(topLinks.map((l) => [l.id, l]));
  const nestedIds = new Set(app.subgraphIds ?? []);
  // Bypassed nodes (mode 4) never reach the API prompt; follow their same-type
  // input to the real source so a consumer still gets a valid link.
  const resolveOrigin = (originId, originSlot) => {
    const seen = new Set();
    let id = originId;
    let slot = originSlot;
    for (;;) {
      const n = topById.get(id);
      if (!n || n.mode !== 4) return { nodeId: id, slot };
      if (seen.has(id)) return null;
      seen.add(id);
      const outType = n.outputs?.[slot]?.type;
      const idx = (n.inputs ?? []).findIndex((i) => i.type === outType && i.link != null);
      const inLink = idx >= 0 ? topLinksById.get(n.inputs[idx].link) : undefined;
      if (!inLink || inLink.origin_id === refId) return null;
      id = inLink.origin_id;
      slot = inLink.origin_slot;
    }
  };
  // Only "always" nodes are converted. A node whose type is a subgraph UUID is a
  // nested subgraph reference — the API can't execute it, so the chain stops here
  // (the output falls back to a synthetic saver instead of an invalid prompt).
  const isActive = (n) => !!n && (n.mode === undefined || n.mode === null || n.mode === 0) && !nestedIds.has(n.type);

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
  // Downstream saver chain + upstream media-feed chain + overridden top widgets.
  const converted = new Set([...allReach, ...feedReach, ...topOverrideNodes]);

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

  // ----------------------------------------------------------------------- #
  // Nested subgraph references: a top-level node whose type is ANOTHER
  // subgraph's UUID. The API can't run a UUID class_type and the ref node is
  // only a shell — the frontend expands it into its internal nodes, so we do
  // the same: convert the subgraph's real nodes under a `n<refId>_<id>` key and
  // resolve its I/O to the internal producers / the ref node's own input links.
  // ----------------------------------------------------------------------- #
  const mainSgId = app.subgraphs?.[0]?.id;
  const nestedSubgraphOf = (n) => {
    if (!n || n.id === refId || n.type === mainSgId) return null;
    return nestedIds.has(n.type) ? (app.subgraphs ?? []).find((s) => s.id === n.type) ?? null : null;
  };
  // Resolve a TOP-LEVEL link to its API value, transparently expanding a nested
  // subgraph ref and a bypassed node. consumerTopId is the node being fed, so a
  // media-feed node never re-resolves its own ref-origin to a subgraph output.
  const resolveTopSource = (topLink, consumerTopId) => {
    if (!topLink) return null;
    const src = resolveOrigin(topLink.origin_id, topLink.origin_slot);
    if (!src) return null;
    if (src.nodeId === refId && !(consumerTopId != null && feedReach.has(consumerTopId))) {
      const port = app.outputs[src.slot];
      return port && port.producerNodeId != null ? [String(port.producerNodeId), port.producerSlot] : null;
    }
    const out = inlineNested(src.nodeId);
    if (out) {
      const pr = out[src.slot];
      return pr ? [pr.key, pr.slot] : null;
    }
    if (converted.has(src.nodeId)) return [topKey(src.nodeId), src.slot];
    const origin = topById.get(src.nodeId);
    const v = origin ? literalOf(origin) : null;
    return v !== null && v !== undefined ? v : null;
  };
  const nestedCache = new Map(); // refNodeId -> [{key,slot}] per output slot, or null
  const inlineNested = (refNodeId) => {
    if (nestedCache.has(refNodeId)) return nestedCache.get(refNodeId);
    const n = topById.get(refNodeId);
    const sg = n ? nestedSubgraphOf(n) : null;
    if (!sg) { nestedCache.set(refNodeId, null); return null; }
    const byId = new Map((sg.nodes ?? []).map((x) => [x.id, x]));
    const linkById = new Map((sg.links ?? []).map((l) => [l.id, l]));
    const shellInId = sg.inputNode?.id ?? -10;
    const prefix = `n${refNodeId}_`;
    // The ref node's own widgets hold the app's ACTUAL configured values (the
    // internal nodes keep the subgraph template's stale defaults), so a shell
    // widget port resolves to the ref value first, then the internal default.
    const refWidgets = n.widgets_values_named ?? {};
    // ref node output slot -> internal producer (prompt key, slot).
    const out = [];
    for (let slot = 0; slot < (sg.outputs ?? []).length; slot++) {
      const l = sg.outputs[slot].linkIds?.[0] != null ? linkById.get(sg.outputs[slot].linkIds[0]) : undefined;
      out[slot] = l && byId.has(l.origin_id) ? { key: prefix + l.origin_id, slot: l.origin_slot } : null;
    }
    for (const inn of sg.nodes ?? []) {
      const named = inn.widgets_values_named ?? {};
      const inputs = {};
      for (const s of inn.inputs ?? []) {
        const l = s.link != null ? linkById.get(s.link) : undefined;
        if (l && l.origin_id === shellInId) {
          // Exposed input port: the shell link's origin_slot is the ref node's
          // input slot. If that socket is itself linked (image/alpha/multiplier),
          // the real source is the top-level link off the ref node. If it is a
          // plain widget (seed/sampler/vae_name/…), the ref node's own value is
          // the authoritative one, else the internal template default.
          const refSock = n.inputs?.[l.origin_slot];
          const src = refSock?.link != null ? resolveTopSource(topLinksById.get(refSock.link)) : undefined;
          if (src !== undefined) {
            inputs[s.name] = src ?? (s.name in named ? asWidgetValue(named[s.name]) : null);
          } else {
            const portName = refSock?.name ?? s.name;
            inputs[s.name] = portName in refWidgets ? asWidgetValue(refWidgets[portName]) : (s.name in named ? asWidgetValue(named[s.name]) : null);
          }
        } else if (l && byId.has(l.origin_id)) {
          inputs[s.name] = [prefix + l.origin_id, l.origin_slot];
        } else {
          inputs[s.name] = s.name in named ? asWidgetValue(named[s.name]) : null;
        }
      }
      for (const [k, v] of Object.entries(named)) if (!(k in inputs)) inputs[k] = asWidgetValue(v);
      prompt[prefix + inn.id] = { class_type: inn.type, inputs };
    }
    nestedCache.set(refNodeId, out);
    return out;
  };

  // Nested refs downstream of a subgraph output: reach them, but stop there —
  // their internals are a separate graph inlined by inlineNested.
  const nestedRefIds = new Set();
  {
    const q = [refId];
    const seen = new Set([refId]);
    while (q.length) {
      const cur = q.shift();
      for (const l of topLinks) {
        if (l.origin_id !== cur || seen.has(l.target_id)) continue;
        const t = topById.get(l.target_id);
        if (!t) continue;
        seen.add(l.target_id);
        if (nestedSubgraphOf(t)) nestedRefIds.add(l.target_id);
        else if (t.mode == null || t.mode === 0) q.push(l.target_id);
      }
    }
  }
  // Pull the FULL upstream closure of everything we convert. A socket whose
  // source is a computed top-level node (ComfySwitchNode, ResolutionSelector,
  // GetImageSize, BranchNode, PrimitiveBoolean, …) must be emitted as a real
  // node reference — guessing a literal from its widgets yields garbage (e.g.
  // the 输出宽度 switch literalizing to `true` inside the resize-multiplier
  // NumberCalculator), which poisons the whole downstream saver chain. Nested
  // refs' direct feeders AND their feeders' feeders are included recursively;
  // the main subgraph ref (refId) is the terminal.
  {
    const q = [];
    const queued = new Set();
    const enqueue = (id) => { if (id === refId || queued.has(id)) return; queued.add(id); q.push(id); };
    for (const id of new Set([...converted, ...nestedRefIds])) enqueue(id);
    for (let i = 0; i < q.length; i++) {
      const n = topById.get(q[i]);
      if (!n) continue;
      for (const s of n.inputs ?? []) {
        if (s.link == null) continue;
        const tl = topLinksById.get(s.link);
        const src = tl ? resolveOrigin(tl.origin_id, tl.origin_slot) : null;
        if (!src || src.nodeId === refId || !topById.has(src.nodeId)) continue;
        converted.add(src.nodeId);
        enqueue(src.nodeId);
      }
    }
  }

  for (const id of new Set([...converted, ...nestedRefIds])) {
    const n = topById.get(id);
    if (!n) continue;
    // A nested ref is a shell: expand its subgraph, never emit the UUID class_type.
    if (nestedSubgraphOf(n)) { inlineNested(id); continue; }
    const named = widgetMapOf(n);
    const inputs = {};
    for (const s of n.inputs ?? []) {
      if (s.link != null) {
        const v = resolveTopSource(topLinksById.get(s.link), id);
        if (v !== null && v !== undefined) inputs[s.name] = v;
      } else if (s.widget && s.name in named) {
        inputs[s.name] = asWidgetValue(named[s.name]);
      }
    }
    // Widgets that belong to the API contract even though the UI lists them as
    // plain widgets. Frontend-only extras (VHS "videopreview", …) are dropped.
    for (const [k, v] of Object.entries(named)) {
      if (k in inputs) continue;
      if ((n.inputs ?? []).some((i) => i.name === k)) continue;
      if (/preview/i.test(k)) continue;
      inputs[k] = asWidgetValue(v);
    }
    // A supplied media path wins over the loader's saved widget value.
    for (const [k, v] of topWidgetOverrides.get(n.id) ?? []) inputs[k] = asWidgetValue(v);
    prompt[topKey(n.id)] = { class_type: n.type, inputs };
  }

  // Only add a synthetic saver when the app's own top-level sink is absent
  // (hand-edited workflow, muted saver, headless import, …), so we never dump a
  // frame sequence next to the real video/image the author configured. A
  // PreviewImage counts as a sink: the app author chose not to persist that
  // output, and its temp file is still downloadable from /history.
  const SAVER_RE = /^(VHS_VideoCombine|SaveVideo|SaveAnimatedWEBM|SaveAnimatedPNG|SaveImage|SaveImageAdvanced|SaveAudio|SaveAudioMP3|SaveAudioOpus|PreviewImage|PreviewAny)$/;
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
  const byLabel = new Map();
  for (const i of app.inputs) {
    if (!byLabel.has(String(i.label))) byLabel.set(String(i.label), i);
    for (const a of i.aliases ?? []) if (!byLabel.has(String(a))) byLabel.set(String(a), i);
  }
  for (const [rawKey, rawVal] of Object.entries(values ?? {})) {
    const key = String(rawKey).trim();
    const m = /^(\d+):(.+)$/.exec(key) || /^(\d+)\.(.+)$/.exec(key);
    let port, targets, type;
    if (m) {
      port = app.inputs.find((i) => (i.targets ?? []).some((t) => String(t.nodeId) === m[1] && t.socket === m[2]))
        || app.inputs.find((i) => i.linear && String(i.linear.nodeId) === m[1] && i.linear.socket === m[2]);
      targets = port?.targets ?? [{ nodeId: m[1], socket: m[2] }];
      type = port?.type;
    } else {
      port = byLabel.get(key);
      if (!port) throw new Error(`unknown param "${key}" — call get_app_params("${app.name}") for its parameter list`);
      targets = port.targets ?? [];
      type = port.type;
    }
    if (port?.media) {
      // A media value is a filename for the port's loader, not a literal for the
      // IMAGE socket the port feeds. graphToPrompt routes it to the loader widget.
      ov.set(MEDIA_OVERRIDE_PREFIX + port.portId, String(rawVal));
      continue;
    }
    if (port?.linear) {
      // linearData port: the value goes to a TOP-LEVEL node's widget, which the
      // subgraph's own node-id namespace can't express (`@top:<nodeId>:<socket>`).
      let v = rawVal;
      if (/^seed$/i.test(port.linear.socket) && Number(v) === -1) v = Math.floor(Math.random() * 0xffffffff);
      ov.set(`@top:${port.linear.nodeId}:${port.linear.socket}`, coerceByType(v, type));
      continue;
    }
    if (!targets.length) throw new Error(`param "${key}" has no internal target`);
    let v = rawVal;
    if (/seed/i.test(targets[0].socket) && Number(v) === -1) v = Math.floor(Math.random() * 0xffffffff);
    for (const t of targets) ov.set(`${t.nodeId}:${t.socket}`, coerceByType(v, type));
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
    try { a = loadNativeApp(f); } catch (e) { return { number: i + 1, file: f, error: e.message }; }
    return {
      number: i + 1,
      name: a.name,
      id: a.id,
      file: f,
      description: a.description,
      outputs: a.outputs.map((o) => ({ name: o.name, type: o.type })),
    };
  });
  return { workflowsRoot: root, count: apps.length, apps };
}

// list_apps payload: only what is needed to CHOOSE an app. The parameter contract
// is a separate per-app call (appParams), so a 20-app catalog does not bury a
// small model in a wall of inputs.
export function appCatalog() {
  const { workflowsRoot, apps } = listApps();
  const list = apps.map((a) => {
    if (a.error) return { number: a.number, error: a.error.replace(`: ${a.file}`, '') };
    return {
      number: a.number,
      name: a.name,
      id: a.id,
      ...(a.description ? { description: a.description } : {}),
      outputs: [...new Set(a.outputs.map((o) => o.type))],
    };
  });
  const out = { count: list.length, apps: list };
  // Only surface the scan root when nothing was found — that is when it matters.
  if (!list.length) out.workflowsRoot = workflowsRoot;
  return out;
}

// get_app_params payload: the full parameter contract of ONE app.
// COMBO inputs always carry their `options` — the full list of legal values,
// pulled from /object_info so a client can show a real dropdown and a model can
// pick without guessing filenames. (Only real COMBOS have one: a port declared
// STRING carries no choices.)
export async function appParams(ref) {
  const app = resolveAppRef(ref);
  const a = loadNativeApp(app.file);
  // The node types behind this app's COMBO ports, deduped. linearData ports target
  // TOP-LEVEL nodes, so combine the subgraph-internal targets with the linear node.
  const comboPorts = a.inputs.filter((p) => p.type === 'COMBO');
  const nodeTypes = new Set();
  for (const p of comboPorts) {
    for (const t of p.targets ?? []) {
      const type = a.nodesById.get(t.nodeId)?.type;
      if (type) nodeTypes.add(type);
    }
    if (p.linear) {
      const type = a.topById?.get(p.linear.nodeId)?.type;
      if (type) nodeTypes.add(type);
    }
  }
  const specs = {};
  await Promise.all([...nodeTypes].map(async (t) => {
    try { specs[t] = (await getJson(`/object_info/${encodeURIComponent(t)}`))[t]?.input; } catch { specs[t] = null; }
  }));
  const socketSpec = (spec, socket) => spec?.required?.[socket] ?? spec?.optional?.[socket] ?? spec?.hidden?.[socket];
  // object_info encodes a COMBO socket several ways:
  //   ["opt1","opt2"]            — bare list
  //   [["opt1","opt2"], {...}]   — options + meta dict
  //   ["COMBO", {options:[...]}] — dict-style combo (ResolutionSelector, …)
  const comboOptions = (raw) => {
    if (!Array.isArray(raw)) return undefined;
    if (Array.isArray(raw[0])) return raw[0];
    if (raw[0] === 'COMBO' && Array.isArray(raw[1]?.options)) return raw[1].options;
    return raw;
  };
  const optionsOf = (port) => {
    for (const t of port.targets ?? []) {
      const type = a.nodesById.get(t.nodeId)?.type;
      const spec = type ? specs[type] : undefined;
      const opts = comboOptions(socketSpec(spec, t.socket));
      if (Array.isArray(opts)) return opts;
    }
    if (port.linear) {
      const type = a.topById?.get(port.linear.nodeId)?.type;
      const spec = type ? specs[type] : undefined;
      const opts = comboOptions(socketSpec(spec, port.linear.socket));
      if (Array.isArray(opts)) return opts;
    }
    return null;
  };
  return {
    number: app.number,
    name: a.name,
    id: a.id,
    ...(a.description ? { description: a.description } : {}),
    inputs: a.inputs.map((inp) => {
      const p = { name: inp.label, type: inp.type };
      if (inp.default !== null && inp.default !== undefined) p.default = inp.default;
      if (inp.type === 'COMBO') {
        const opts = optionsOf(inp);
        if (opts?.length) p.options = opts;
      }
      return p;
    }),
    outputs: a.outputs.map((o) => ({ name: o.name, type: o.type })),
  };
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
  return { path: ((j.subfolder ? j.subfolder + '/' : '') + (j.name ?? name)).replace(/\\/g, '/') };
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
    .filter((x) => x && typeof x === 'object' && x.filename)
    .sort((a, b) => Number(a.type === 'temp') - Number(b.type === 'temp'));
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
export async function collectOutputs(entry, { index = 0 } = {}) {
  const texts = [];
  for (const [nodeId, nodeOut] of Object.entries(entry.outputs ?? {})) {
    for (const [key, items] of Object.entries(nodeOut)) {
      if (Array.isArray(items) && items.length && typeof items[0] === 'string') texts.push(`${key}: ${items[0]}`);
    }
  }
  // Saved files win over temp previews, so a PreviewImage inside the graph does
  // not shadow the real result. Order is otherwise preserved (first node wins).
  const cands = [];
  for (const nodeOut of Object.values(entry.outputs ?? {})) {
    for (const key of ['images', 'gifs', 'videos']) {
      const items = nodeOut[key];
      if (items?.length) cands.push({ key, it: items[0] });
    }
  }
  cands.sort((a, b) => Number(a.it.type === 'temp') - Number(b.it.type === 'temp'));
  const pick = cands[Math.max(0, Number(index) || 0)];
  if (pick) {
    const { key, it } = pick;
    const meta = { filename: it.filename, subfolder: it.subfolder ?? '', type: it.type ?? 'output', url: outputViewUrl(it) };
    if (key === 'videos' || /\.(mp4|webm|mov|mkv|gif)$/i.test(it.filename)) {
      return { kind: 'video', ...meta, extra: texts };
    }
    const data = await getBytes(`/view?${viewQuery(it)}`);
    const mime = /\.(jpe?g)$/i.test(it.filename) ? 'image/jpeg' : /\.webp$/i.test(it.filename) ? 'image/webp' : 'image/png';
    return { kind: 'image', ...meta, mime, b64: data.toString('base64'), extra: texts };
  }
  return { kind: 'none', text: 'job finished but no image/video output was found', extra: texts };
}

// Preview a finished job WITHOUT writing anything to disk: re-read its /history
// entry and return the index-th image inline (base64) plus its /view URL. This is
// what makes the submit-only run_app flow viewable: the client calls
// job_status(prompt_id, wait_s) and gets the picture, no download_output needed.
export async function jobPreview(promptId, { index = 0 } = {}) {
  const hist = await getJson(`/history/${encodeURIComponent(promptId)}`).catch(() => ({}));
  const entry = hist[promptId];
  if (!entry || entry.status?.status_str === 'error') return null;
  const out = await collectOutputs(entry, { index });
  return out.kind === 'image' ? out : null;
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
      hint: 'Pass the UUID prompt_id returned by run_app (unknown, or history cleared).',
    };
  }
  if (e.status?.status_str === 'error') {
    const error = e.status.messages?.find((m) => m?.[0] === 'execution_error')?.[1]?.exception_message ?? 'execution error';
    return { prompt_id: id, state: 'error', error, entry: e };
  }
  const outs = Object.entries(e.outputs ?? {})
    .flatMap(([, o]) => Object.entries(o).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).filter((x) => x && typeof x === 'object' && x.filename).map((x) => ({ key: k, filename: x.filename, ...(x.subfolder ? { subfolder: x.subfolder } : {}), type: x.type ?? 'output', url: outputViewUrl(x) }))));
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
