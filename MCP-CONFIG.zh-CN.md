# MCP 客户端配置示例

`comfy-native-apps` 是一个 **stdio 本地进程型 MCP 服务器**,每个客户端都通过
`node <本仓库的 comfy_native_apps.mjs>` 拉起。核心只有一条命令:

```bash
node E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs
```

配置时把它拆成 `command`(`node`) + `args`(上面的 `.mjs` 路径) + `env`
(可选环境变量)即可。以 GitHub 克隆镜像为准,把路径换成你 clone 的位置。

> 注意:Claude Code / dsh / opencode 均**不支持**直接填 `https://github.com/…`
> 拉取,必须指向**本地文件绝对路径**(即本仓库 clone 或检出后的位置)。

---

## 通用最小配置(占位)

所有客户端下面四段都是同一套参数:

| 字段 | 值 |
|------|-----|
| `command` | `node` |
| `args` | `[ "<本仓库>/comfy_native_apps.mjs" ]` |
| `env` | `{ "COMFYUI_URL": "http://127.0.0.1:8188" }`(可选;等价于默认值) |
| `transport` | `stdio`(dsh/opencode 需要显式写;Claude Code 省略即 stdio) |

其余几个可选环境变量见 README:`COMFYUI_URL`、`COMFYUI_PUBLIC_URL`、`WORKFLOWS_ROOT`、`RUN_TIMEOUT_S`。旧的 `COMFYUI_HOST` + `COMFYUI_PORT` 仍兼容。

---

## 1) Claude Code

**项目级**:`E:\AIGenerationStudio\.mcp.json`(仅在该项目生效;不加到
`~/.claude.json`,会变成全局)。

```json
{
  "mcpServers": {
    "comfy-native-apps": {
      "command": "node",
      "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
      "env": { "COMFYUI_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

- 用正斜杠 `/` 的绝对路径(Windows 反斜杠在 JSON 里要转义,绕开)。
- `env` 里的 `COMFYUI_URL` 是 MCP 访问 ComfyUI 的地址,默认就是 `http://127.0.0.1:8188`,没改端口可以不写。
- 已接入。换机器/换 clone 路径时,把 `args` 里的路径换成实际位置即可。

---

## 2) dsh(DeepSeek Harness)

dsh 的 MCP 配置存在 `C:\Users\<you>\.dsh\storages\mcp_connector.json`,
结构分为 `connections`(你自己的)、`grants`、`catalog`(内置目录)。

**优先用 dsh UI 添加**(避免手改大文件):打开 dsh → 设置 → MCP 连接器
→ 添加本地连接,`command` 填 `node`,`args` 填上面的 `.mjs` 路径。

若手改 `mcp_connector.json`,在 `connections` 下加:

```json
{
  "connections": {
    "comfy-native-apps": {
      "schemaVersion": 1,
      "name": "comfy-native-apps",
      "servers": [
        {
          "serverKey": "main",
          "command": "node",
          "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
          "env": { "COMFYUI_URL": "http://127.0.0.1:8188" },
          "cwd": "",
          "transport": "stdio",
          "headers": {}
        }
      ]
    }
  }
}
```

(真实的 `connections` 键结构以 dsh UI 导出的为准;这里是该文件里 `catalog`
内置本地服务器的同构格式。)

---

## 3) opencode

opencode 的 MCP 在项目根 `opencode.json` 的 `mcp` 字段:

```json
{
  "mcp": {
    "comfy-native-apps": {
      "type": "local",
      "command": ["node", "E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
      "environment": { "COMFYUI_URL": "http://127.0.0.1:8188" }
    }
  }
}
```

- `type: "local"` 表示本地 stdio 进程;远程用 `type: "remote"` + `url`。
- `command` 是数组(命令 + 参数),非字符串。
- 未在全局/项目安装 opencode 时,此段直接可参考。

---

## 4) 其他 MCP 客户端

任何支持 **stdio 本地命令** 的 MCP 客户端,套路都一样,只要把
`command`/`args` 指向本仓库路径、`transport` 设 `stdio`。若客户端只支持
远程 `url`,需要把本服务器包一层 HTTP — `comfy-native-apps` 目前是纯
stdio,不支持 HTTP(sse/streamable)。如确有需要可提 issue。

---

## 环境变量速查

| 变量 | 默认 | 说明 |
|------|------|------|
| `COMFYUI_URL` | `http://127.0.0.1:8188` | MCP 服务端访问 ComfyUI 的地址 |
| `COMFYUI_PUBLIC_URL` | 同 `COMFYUI_URL` | 客户端可达的 ComfyUI 地址；MCP 主机能连、客户端连不上时（容器/反代/隧道）用于生成下载链接 |
| `WORKFLOWS_ROOT` | 自动探测 | ComfyUI `user` 目录,递归找 `workflows` 下 `*.app.json` |
| `RUN_TIMEOUT_S` | `300` | 单次渲染等待上限(秒) |

> 旧写法 `COMFYUI_HOST` + `COMFYUI_PORT` 仍兼容，但推荐统一用 `COMFYUI_URL`。

*路径说明:* 本文件例子用 `E:/AIGenerationStudio/tools/comfy-native-apps`
(即本仓库本地位置)。clone 到别处请全局替换。
