# comfy-native-apps

[中文文档](README.zh-CN.md)  |  [MCP 客户端配置示例](MCP-CONFIG.zh-CN.md)

A 6-tool MCP server that drives **only** ComfyUI's native `.app.json` apps (the
built-in "构建应用 / Build App" feature) and manages the render queue. It does the
UI→API conversion itself and uses only ComfyUI's stable core HTTP API, so it works
against a **headless** OR a **frontend** ComfyUI — with **zero dependency on the
artokun comfyui-mcp / panel plugin**.

Node 18+ only (global `fetch`, `structuredClone`). No `npm install`.

## Why

artokun's comfyui-mcp exposes ~38 action-parameterized tools (plus 3 facade meta-tools
and a 96-tool panel surface). Even its compact mode forces a `list → describe_tool →
call_tool` chain that a 9B-class local model loops on `describe_tool` forever. This
server deletes the indirection: the model sees exactly seven single-purpose tools.

## Tools

| tool | what it does |
|------|--------------|
| `list_apps` | every native `.app.json` app, with its input params (name + type + default) and outputs |
| `run_app(app, values)` | fill only the params you change, convert UI→API, enqueue, wait, return the image (and any string outputs) |
| `upload_file(path, subfolder?)` | upload a LOCAL file (image/video/audio/mask) into ComfyUI input dir; returns the ComfyUI-side relative path to pass as a file input value |
| `queue_status` | what is running + pending |
| `job_status(prompt_id)` | state + output files of one job |
| `clear_queue` | clear the pending queue |
| `interrupt` | stop the current generation |

`run_app` `app` may be the number from `list_apps`, the app name, or its id (relative
workflows path). `values` keys are the friendly param labels (`prompt`, `seed`, …).
A `seed` of `-1` rolls a random seed.
For apps with an image/video/audio/mask input: first call `upload_file` with a local path, then pass the returned **ComfyUI-side relative path** (e.g. `mybatch/wall.png`) as that param value in `run_app` - ComfyUI reads it from its input dir, not the Windows filesystem, so absolute paths like `E:/.../wall.png` wont resolve.

## How a native app is read

A `.app.json` wraps its whole graph in one subgraph. This server reads the declared
I/O from `definitions.subgraphs[0].inputs[]` / `.outputs[]` (each port has a `label`,
`type`, and a `linkIds` that points at the internal node+widget to fill). It then
converts the subgraph's `nodes` + `links` to an API-format prompt:

- a socket linked from a real internal node → `[String(nodeId), slot]`
- a socket linked from the inputNode shell (`-10`) or not linked → its `widgets_values_named` default
- a model-filled value → the override (type-coerced to the port's declared type)
- widgets that aren't sockets (e.g. KSampler `control_after_generate`) → appended so the prompt is complete
- a synthetic `SaveImage` / `SaveAnimatedWEBM` is attached to each IMAGE/VIDEO output so the result is saved and fetched via `/view`

**Where a port's real value lives.** In app mode the exposed input ports' *configured*
values are stored on the subgraph **reference node** — the top-level node whose `type`
is the subgraph's id — in its `widgets_values_named`, keyed by port *name*. The internal
nodes (e.g. a `UNETLoader`) keep the template's original defaults, which can be stale.
This server reads the port values from the reference node and applies them to the internal
node+socket each port feeds (as pre-populated overrides), so the app runs with the values
the user actually set — including model paths with their subfolder prefix (e.g.
`zimage\z_image_turbo_int8_convrot.safetensors`). User `run_app` values layer on top.

Because the conversion happens here, the same `run_app` works whether ComfyUI is
headless (`--front-end-version 0`, no UI) or running the web frontend — only the core
API is touched. The `.app.json` files are read straight off disk.

## Config (env vars)

| var | default |
|-----|---------|
| `COMFYUI_HOST` | `127.0.0.1` |
| `COMFYUI_PORT` | `8188` |
| `WORKFLOWS_ROOT` | auto-detected `<ComfyUI user>` dir (recursively finds `workflows/**\/*.app.json`) |
| `RUN_TIMEOUT_S` | `300` (seconds to wait for a render) |

## Client config (Claude Code / any MCP client)

```json
{
  "command": "node",
  "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
  "env": { "COMFYUI_PORT": "8188" }
}
```

Wired into this workspace's `.mcp.json` as the server `comfy-native-apps`.

## Files

- `comfy_native_apps.mjs` — the MCP stdio server (6 tools, newline-delimited JSON-RPC 2.0)
- `native_lib.mjs` — workflows discovery, app loading, UI→API conversion, HTTP, queue
- `drive_safe.mjs` — non-destructive end-to-end test (list_apps + run_app + job_status)

## Note on models

An app's default model names must exist on the target machine. If an app was built
with a model that isn't installed, `run_app` returns ComfyUI's `value_not_in_list`
error naming the missing file; override the `*_name` params to an installed model.
