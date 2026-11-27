# comfy-native-apps

[中文文档](README.zh-CN.md)  |  [MCP 客户端配置示例](MCP-CONFIG.zh-CN.md)

A 9-tool MCP server that drives **only** ComfyUI's native `.app.json` apps (the
built-in "构建应用 / Build App" feature) and manages the render queue. It does the
UI→API conversion itself and uses only ComfyUI's stable core HTTP API, so it works
against a **headless** OR a **frontend** ComfyUI — with **zero dependency on the
artokun comfyui-mcp / panel plugin**.

Node 18+ only (global `fetch`, `structuredClone`). No `npm install`.

Tested against ComfyUI **0.45.3** (frontend 1.58.5) with native `.app.json` apps.

## Why

artokun's comfyui-mcp exposes ~38 action-parameterized tools (plus 3 facade meta-tools
and a 96-tool panel surface). Even its compact mode forces a `list → describe_tool →
call_tool` chain that a 9B-class local model loops on `describe_tool` forever. This
server deletes the indirection: the model sees exactly nine single-purpose tools.

## Tools

| tool | what it does |
|------|--------------|
| `list_apps` | catalog only: number, name, id, short description and output types of every native `.app.json` app |
| `get_app_params(app)` | the parameter contract of ONE app: every input param (name + type + default; `COMBO` inputs also carry their full `options` list) and its outputs |
| `run_app(app, inputs, wait_s?)` | fill only the params you change, convert UI→API, enqueue and wait, return the image (and any string outputs); videos come back as an openable `/view` URL. `wait_s` caps how long it blocks; `0` returns the `prompt_id` immediately |
| `upload_file(path, subfolder?)` | upload a LOCAL file (image/video/audio/mask) into ComfyUI input dir; returns the ComfyUI-side relative path to pass as a file input value |
| `download_output(prompt_id, index?, dest?)` | download one finished output to a **local file** (bytes via `/view`), returning the real `saved_to` path. `dest` may be a file, a directory or a relative path; omit it to use `DOWNLOAD_DIR` (default `<cwd>/downloads`). Works for local and remote ComfyUI |
| `queue_status` | what is running + pending, plus a `recent` list of finished jobs (5 by default; `recent: 0` skips history) |
| `job_status(prompt_id, wait_s?)` | state + output files of one job; `wait_s` blocks until it finishes (or times out) so clients need no polling loop |
| `clear_queue` | clear the pending queue |
| `interrupt` | stop the current generation |

`list_apps` is a catalog only — call `get_app_params(app)` for an app's params, so a
long app list never buries the model in inputs it does not need. `run_app` `app` may be
the number from `list_apps`, the app name, or its id (relative workflows path); pass the
**id** when several apps share a name. `inputs` keys are the param labels from
`get_app_params` (`prompt`, `seed`, …). A `seed` of `-1` rolls a random seed.
Params go in the `inputs` object **only** — a stray top-level field is an error, not a
silently-ignored default, and a mistyped param name is reported with a pointer to
`get_app_params`. Both mistakes fail before anything is enqueued.
A `COMBO` input always carries `options` — the full list of legal values — so a client
can render a real dropdown and a model can pick without guessing filenames (a port
declared `STRING` has no choices).
Display-only nodes — `PreviewAny` / `PreviewImage` / `PreviewText` / `ShowText` / `Debug`
(prompt/resolution preview, etc.) — are stripped from the param list: a port whose targets
are *all* of those kinds is scaffolding, not a parameter, so it never shows up. A port that
also feeds a real node is kept.
`job_status` / `download_output` take the **UUID prompt_id** returned by `run_app`; the `queue_number` from `queue_status` is just a queue position and only works as a shortcut while the job is queued.
`queue_status` reads `recent` from ComfyUI's `/history` (cleared when ComfyUI restarts). Each entry only carries `prompt_id`, `state`, output filenames and the finish time; use `job_status` for the full result of one history job.
**Download**: `download_output` now writes the file to disk (bytes over `/view`) and returns `saved_to`. `dest` may be a file path (`E:/out/clip.mp4`, rename on the way), a directory (`E:/out`, `E:/out/`; no extension also means directory) or a relative path (against the MCP process cwd); omit it to use `DOWNLOAD_DIR`. The file lands on the **machine running this MCP server**, remote ComfyUI included.
`run_app` only returns the image preview block and the `/view` URL (videos: URL only) — **no ComfyUI / MCP server file paths**. For a local file call `download_output`; its `saved_to` is the real on-disk path. When a job produced both a saved file and a temp preview, the saved file is the one returned (`download_output` uses the same order).
**Waiting**: `run_app` blocks until the result by default; `wait_s: 0` only enqueues and returns the `prompt_id`. Then `job_status(prompt_id, wait_s)` blocks up to N seconds and returns `timed_out: true` plus the current `state` when the budget runs out — call it again to keep waiting instead of guessing client timeouts.
For apps with an image/video/audio/mask input: first call `upload_file` with a local path, then pass the returned **ComfyUI-side relative path** (e.g. `mybatch/wall.png`) as that param value in `run_app` - ComfyUI reads it from its input dir, not the Windows filesystem, so absolute paths like `E:/.../wall.png` wont resolve.

## How a native app is read

A `.app.json` wraps its whole graph in one subgraph. This server reads the declared
I/O from `definitions.subgraphs[0].inputs[]` / `.outputs[]` (each port has a `label`,
`type`, and a `linkIds` that points at the internal node+widget to fill). It then
converts the subgraph's `nodes` + `links` to an API-format prompt:

> A purely-linear app (frontend's "linear" layout) has **no subgraph**: the whole
> top-level graph is the app, with `extra.linearMode: true` and
> `extra.linearData.inputs` listing every exposed port (`"<uuid>:<nodeId>:<socket>"` +
> label). Such apps are recognized and converted through the same top-level machinery —
> every active top-level node is emitted and port values route to those nodes' widgets — so
> they can be driven from `run_app` exactly like subgraph apps.

- a socket linked from a real internal node → `[String(nodeId), slot]`
- a socket linked from the inputNode shell (`-10`) or not linked → its `widgets_values_named` default
- a model-filled value → the override (type-coerced to the port's declared type)
- widgets that aren't sockets (e.g. KSampler `control_after_generate`) → appended so the prompt is complete
- a **list-valued widget** (e.g. `BranchNode`'s `branch_names`, an `ARRAY` rendered as a widget) → `{"__value__": [...]}`, because the raw API reads any bare list as a `[node_id, slot]` link and rejects it with `bad_linked_input`
- top-level saver nodes (`SaveImage` / `SaveImageAdvanced` / `VHS_VideoCombine` / `SaveVideo` / `SaveAnimatedWEBM` …) are converted too — a native app keeps them outside the subgraph, and converting only the subgraph left video apps with a pile of loose PNG frames. A synthetic `SaveImage` / `SaveAnimatedWEBM` is only attached when an output has no real sink; a `PreviewImage` counts as a sink (the author chose not to persist that output, and its temp file is still downloadable from `/history`)
- filename tokens such as `%date:yyyy-MM-dd%` are expanded (the web frontend does this before submitting; the raw API does not)
- a **nested subgraph reference** (`class_type` is the UUID of another `definitions.subgraphs[]` entry) is **inlined**: its internal nodes are emitted under a `n<refId>_<id>` key, its `-10` shell sockets are resolved to the reference node's own input links (or its `widgets_values_named` when the socket is a plain widget), and its output slots map back to the top-level consumers. The reference node itself is never sent (the API can't run a UUID). Any computed top-level node feeding an inlined socket — a `ComfySwitchNode`, `ResolutionSelector`, `BranchNode`, even indirect feeders-of-feeders — is converted as a real node too, never collapsed to a literal (a switch would otherwise literalize to `true` and poison, say, a `NumberCalculator` resize-multiplier downstream of a saver)
- a media input port (`IMAGE` / `MASK` / `VIDEO` / `AUDIO`) is a file, not a literal: the path goes to the filename widget of the top-level loader (`LoadImage`, `LoadVideo`, `LoadAudio`, …) that feeds the subgraph reference node, and the internal consumers link to that loader's output. A port with no external loader gets a synthetic `LoadImage`; a filename is never written onto an `IMAGE` socket

**Where a port's real value lives.** In app mode the exposed input ports' *configured*
values are stored on the subgraph **reference node** — the top-level node whose `type`
is the subgraph's id — in its `widgets_values_named`, keyed by port *name*. The internal
nodes (e.g. a `UNETLoader`) keep the template's original defaults, which can be stale.
This server reads the port values from the reference node and applies them to every internal
node+socket the port feeds (as pre-populated overrides), so the app runs with the values
the user actually set — including model paths with their subfolder prefix (e.g.
`zimage\z_image_turbo_int8_convrot.safetensors`). A port can fan out to several nodes (one
"channel" string driving two `BranchNode`s, say); all of them receive the value, and user
`run_app` values layer on top the same way. Media ports are the exception: their value is a
file, so it is routed to the loader's filename widget instead of the internal `IMAGE` socket.

Because the conversion happens here, the same `run_app` works whether ComfyUI is
headless (`--front-end-version 0`, no UI) or running the web frontend — only the core
API is touched.

## App discovery

Apps are read from the ComfyUI server itself, through the same `/userdata` API the
web frontend uses to list and open workflows:

- `GET /userdata?dir=workflows&recurse=true&full_info=true` lists every workflow,
- `GET /userdata/<url-encoded path>` returns its JSON.

The listing is mirrored into a temp dir so the converter can read apps as files, and
only changed files are re-downloaded. Because discovery goes over HTTP, the MCP needs
no local filesystem access: it works against a remote ComfyUI, and apps added or edited
in ComfyUI appear on the next tool call without restarting the server.

If the server does not expose `/userdata` (old builds), the MCP falls back to scanning
a local `<ComfyUI user>` dir.

## Config (env vars)

| var | default | notes |
|-----|---------|-------|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | address the MCP server uses to reach ComfyUI, e.g. `https://gpu.example.com/comfy` |
| `COMFYUI_PUBLIC_URL` | same as `COMFYUI_URL` | address clients use; set it only when this MCP host can reach ComfyUI but clients cannot (container / reverse proxy / tunnel), so download links stay reachable |
| `WORKFLOWS_ROOT` | *(unset)* | optional override: read `workflows/**/*.app.json` from this local dir instead of the server API |
| `RUN_TIMEOUT_S` | `300` | seconds to wait for a render |
| `DOWNLOAD_DIR` | `<MCP process cwd>/downloads` | where `download_output` writes when `dest` is omitted |

> The old `COMFYUI_HOST` + `COMFYUI_PORT` pair still works as a fallback, but `COMFYUI_URL` replaces it.

## Client config (Claude Code / any MCP client)

```json
{
  "command": "node",
  "args": ["C:/path/to/comfy-native-apps/comfy_native_apps.mjs"],
  "env": { "COMFYUI_URL": "http://127.0.0.1:8188" }
}
```

Wired into this workspace's `.mcp.json` as the server `comfy-native-apps`.

## Files

- `comfy_native_apps.mjs` — the MCP stdio server (9 tools, newline-delimited JSON-RPC 2.0)
- `native_lib.mjs` — workflows discovery, app loading, UI→API conversion, HTTP, queue
- `drive_safe.mjs` — non-destructive end-to-end test (list_apps + get_app_params + run_app + job_status)
- `assert_media.mjs` — offline assertions for the media-port conversion (no ComfyUI needed): `node assert_media.mjs`

## Note on models

An app's default model names must exist on the target machine. If an app was built
with a model that isn't installed, `run_app` returns ComfyUI's `value_not_in_list`
error naming the missing file; override the `*_name` params to an installed model.
