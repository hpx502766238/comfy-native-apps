# comfy-native-apps

ComfyUI原生应用工作流轻量执行器MCP，适合小模型

一个 8 工具的 MCP 服务器，只驱动 ComfyUI 原生的 `.app.json` 应用（内置的"构建应用 / Build App"功能），并管理渲染队列。它自己做 UI→API 转换，只用到 ComfyUI 稳定的核心 HTTP API，因此对接**无头**或**带前端**的 ComfyUI 都能用——**完全不依赖 artokun 的 comfyui-mcp / panel 插件**。

仅需 Node 18+（全局 `fetch`、`structuredClone`）。无需 `npm install`。

## 为什么

artokun 的 comfyui-mcp 暴露了约 38 个带 action 参数的工具（外加 3 个门面元工具和 96 个面板接口）。即使是它的紧凑模式，也会逼着模型走 `list → describe_tool → call_tool` 这条链，而 9B 级别的本地模型会在 `describe_tool` 上无限打转。这个服务器把中间层删掉：模型只看到 8 个单一用途的工具。

## 工具

| 工具 | 作用 |
|------|------|
| `list_apps` | 列出所有原生 `.app.json` 应用，含输入参数（名称 + 类型 + 默认值）和输出 |
| `run_app(app, values)` | 只填你要改的参数，做 UI→API 转换，入队，等待，返回图片（以及任何字符串输出）；视频返回可直接打开的 `/view` 链接 |
| `upload_file(path, subfolder?)` | 把本地文件（图片/视频/音频/mask）上传进 ComfyUI 的 input 目录；返回可在 `run_app` 的输入参数里直接使用的 ComfyUI 侧相对路径 |
| `download_output(prompt_id, index?)` | 按 `prompt_id` 取一条已完成产物的下载链接（本地实例还会附上真实路径）；本地 / 远程 ComfyUI 通用 |
| `queue_status` | 正在运行 + 排队的任务 |
| `job_status(prompt_id)` | 单个任务的状态 + 输出文件 |
| `clear_queue` | 清空排队中的任务 |
| `interrupt` | 停止当前生成 |

`run_app` 的 `app` 可以是 `list_apps` 返回的编号、应用名或它的 id（相对 workflows 路径）。`values` 的键是友好的参数标签（`prompt`、`seed`、…）。`seed` 设为 `-1` 会掷一个随机种子。
有图片/视频/音频/mask 输入的应用：先调用 `upload_file`（给本地文件路径），再把返回的 **ComfyUI 侧相对路径**（如 `mybatch/wall.png`）作为该输入参数的值传给 `run_app` —— ComfyUI 是从它的 input 目录读文件的，不是从 Windows 文件系统，所以 `E:/.../wall.png` 这种绝对路径解析不到。

## 原生应用是如何被读取的

一个 `.app.json` 把整张图包在单个 subgraph 里。本服务器从 `definitions.subgraphs[0].inputs[]` / `.outputs[]` 读取声明的输入输出（每个端口有 `label`、`type`，以及指向内部节点+控件的 `linkIds`）。然后把 subgraph 的 `nodes` + `links` 转换成 API 格式的 prompt：

- 从真实内部节点连出的 socket → `[String(nodeId), slot]`
- 从 inputNode 外壳（`-10`）连出、或未连接的 socket → 其 `widgets_values_named` 默认值
- 模型填的值 → 覆盖值（按端口声明类型做类型强转）
- 非 socket 的控件（如 KSampler 的 `control_after_generate`）→ 追加，使 prompt 完整
- 顶层保存节点（`SaveImage` / `SaveImageAdvanced` / `VHS_VideoCombine` / `SaveVideo` / `SaveAnimatedWEBM` …）也会被转换——原生 app 把它们留在子图外面，只转子图会导致视频 app 只落一堆 PNG 帧。只有该输出没有任何真实保存节点时，才挂一个合成的 `SaveImage` / `SaveAnimatedWEBM` 兜底
- 文件名里的 `%date:yyyy-MM-dd%` 一类令牌会被展开（这是前端提交前做的，直连 API 不会）
- 嵌套子图引用（`class_type` 是子图 UUID）无法直接下发给 API，转换会停在那里并回退到兜底保存

**端口的真实值存在哪。** 在 app 模式下，暴露的输入端口的*已配置*值存放在 subgraph **引用节点**上——即那个 `type` 等于 subgraph id 的顶层节点——在其 `widgets_values_named` 里，以端口*名称*为键。内部节点（如 `UNETLoader`）保存的是模板的原始默认值，可能是过期的。本服务器从引用节点读取端口值，并把它们应用到每个端口所填充的内部节点+socket 上（作为预填的覆盖值），这样应用就能用用户真正设置的值运行——包括带子目录前缀的模型路径（例如 `zimage\z_image_turbo_int8_convrot.safetensors`）。用户的 `run_app` 值叠加在其上。

因为转换发生在这里，同一个 `run_app` 无论 ComfyUI 是无头模式（`--front-end-version 0`，无 UI）还是跑着 Web 前端都能用——只碰核心 API。`.app.json` 文件直接从磁盘读取。

## 配置（环境变量）

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | MCP 服务端访问 ComfyUI 的地址，如 `https://gpu.example.com/comfy` |
| `COMFYUI_PUBLIC_URL` | 等于 `COMFYUI_URL` | 客户端访问 ComfyUI 的地址；仅当 MCP 主机能连、客户端连不上时（容器 / 反代 / 隧道）才需要设置，用于生成下载链接 |
| `WORKFLOWS_ROOT` | 自动探测的 `<ComfyUI user>` 目录（递归找 `workflows/**\/*.app.json`） | ComfyUI `user` 目录 |
| `RUN_TIMEOUT_S` | `300`（等待一次渲染的秒数） | 单次渲染等待上限 |

> 旧写法 `COMFYUI_HOST` + `COMFYUI_PORT` 仍然兼容，但已被 `COMFYUI_URL` 取代。

## 客户端配置（Claude Code / 任意 MCP 客户端）

```json
{
  "command": "node",
  "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
  "env": { "COMFYUI_URL": "http://127.0.0.1:8188" }
}
```

已作为服务器 `comfy-native-apps` 接入本工作区的 `.mcp.json`。

## 文件

- `comfy_native_apps.mjs` — MCP stdio 服务器（8 个工具，换行分隔的 JSON-RPC 2.0）
- `native_lib.mjs` — 工作流发现、应用加载、UI→API 转换、HTTP、队列
- `drive_safe.mjs` — 非破坏性端到端测试（list_apps + run_app + job_status）

## 关于模型的说明

应用的默认模型名必须存在于目标机器上。如果某个应用用了未安装的模型构建，`run_app` 会返回 ComfyUI 的 `value_not_in_list` 错误并指明缺失的文件；把对应的 `*_name` 参数覆盖成一个已安装的模型即可。
