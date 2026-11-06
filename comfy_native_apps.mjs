#!/usr/bin/env node
// comfy-native-apps — a 6-tool MCP server for small (9B-class) local models.
// Runs ComfyUI's NATIVE workflow apps (.app.json) and manages the render queue.
//
// It drives ONLY ComfyUI's NATIVE ".app.json" apps (the built-in "构建应用" feature)
// and does the UI→API conversion itself — so it works against a headless OR a
// frontend ComfyUI, with ZERO dependency on the artokun comfyui-mcp / panel plugin.
//
// Tools (no list_tools / describe_tool / call_tool indirection — the model sees
// exactly these six, each single-purpose):
//
//   list_apps()                    -> every native .app.json app, with the exact
//                                     input params to fill (label + type) and outputs
//   run_app(app, values)           -> fill only the params you want to change,
//                                     convert UI→API, enqueue, wait, return the image
//   queue_status()                 -> what is running + pending in the queue
//   job_status(prompt_id)          -> state + output files of one job
//   clear_queue()                  -> clear the pending queue
//   interrupt()                    -> stop the current generation
//
// Config (env vars): COMFYUI_HOST (127.0.0.1), COMFYUI_PORT (8188),
//   WORKFLOWS_ROOT (auto-detected), RUN_TIMEOUT_S (300).
//
// Client config (Claude Code / any MCP client):
//   { "command": "node",
//     "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
//     "env": { "COMFYUI_PORT": "8188" } }
import {
  BASE, RUN_TIMEOUT_S, listApps, resolveAppRef, loadNativeApp,
  graphToPrompt, buildOverrides, postPrompt, waitForJob, collectOutputs,
  getQueue, jobStatus, postJson,
} from './native_lib.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'comfy-native-apps', version: '1.0.0' };

const TOOLS = [
  {
    name: 'list_apps',
    description: 'List every ComfyUI app (.app.json) available on the server. ' +
      'Each app shows its input params (name + type + default) and outputs. Call this first, then run_app.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'run_app',
    description: 'Run one app: fill its input params and generate. Returns the finished image. ' +
      'Pass app as its number from list_apps, its name, or its id. ' +
      'Pass only the params you want to change; omitted ones keep their defaults. ' +
      'A seed of -1 rolls a random seed.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Which app to run: its number from list_apps (e.g. "1"), its name, or its id.' },
        values: {
          type: 'object',
          description: 'Params to fill. Keys are the param name shown by list_apps (e.g. "prompt", "seed"). Omit any you want to leave at its default.',
          additionalProperties: true,
        },
      },
      required: ['app'],
    },
  },
  {
    name: 'queue_status',
    description: 'Show what is currently running and pending in the ComfyUI queue.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'job_status',
    description: 'Report the state (running / pending / completed / error) and output files of one job by its prompt_id.',
    inputSchema: {
      type: 'object',
      properties: { prompt_id: { type: 'string', description: 'The prompt_id returned by run_app or seen in queue_status.' } },
      required: ['prompt_id'],
    },
  },
  {
    name: 'clear_queue',
    description: 'Clear all pending (not yet started) jobs from the queue. Running jobs are untouched.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'interrupt',
    description: 'Interrupt the currently running generation, if any.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
];

// --------------------------------------------------------------------------- #
// Tool handlers.
// --------------------------------------------------------------------------- #
function listAppsHandler() {
  return JSON.stringify(listApps(), null, 2);
}

async function runAppHandler({ app, values = {} }) {
  const ref = resolveAppRef(app);
  const a = loadNativeApp(ref.file);
  const overrides = buildOverrides(a, values);
  const prompt = graphToPrompt(a, overrides);
  const resp = await postPrompt(prompt);
  const promptId = resp.prompt_id;
  const entry = await waitForJob(promptId);
  const out = await collectOutputs(entry);

  if (out.kind === 'image') {
    const lines = [`Generated ${out.filename} with app "${a.name}".`, `(prompt_id ${promptId})`];
    if (out.extra?.length) lines.push('', 'Other outputs:', ...out.extra);
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', data: out.b64, mimeType: out.mime },
    ];
  }
  const lines = [`App "${a.name}" finished (prompt_id ${promptId}).`, out.text];
  if (out.extra?.length) lines.push('', 'Other outputs:', ...out.extra);
  return [{ type: 'text', text: lines.join('\n') }];
}

// --------------------------------------------------------------------------- #
// MCP over stdio: newline-delimited JSON-RPC 2.0.
// --------------------------------------------------------------------------- #
function send(obj) { process.stdout.write(JSON.stringify(obj) + '\n'); }

function handle(msg) {
  const { method, id, params = {} } = msg;

  if (method === 'initialize') {
    send({ jsonrpc: '2.0', id, result: {
      protocolVersion: params.protocolVersion ?? PROTOCOL_VERSION,
      capabilities: { tools: {} }, serverInfo: SERVER_INFO,
    } });
  } else if (method === 'tools/list') {
    send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
  } else if (method === 'tools/call') {
    const { name, arguments: args = {} } = params;
    const run = async () => {
      switch (name) {
        case 'list_apps': return [{ type: 'text', text: listAppsHandler() }];
        case 'run_app': return runAppHandler(args);
        case 'queue_status': return [{ type: 'text', text: JSON.stringify(await getQueue(), null, 2) }];
        case 'job_status': return [{ type: 'text', text: JSON.stringify(await jobStatus(args.prompt_id), null, 2) }];
        case 'clear_queue': { const r = await postJson('/queue', { clear: true }); return [{ type: 'text', text: JSON.stringify(r) }]; }
        case 'interrupt': { const r = await postJson('/interrupt', {}); return [{ type: 'text', text: JSON.stringify(r) }]; }
        default: throw new Error(`Unknown tool: ${name}`);
      }
    };
    run().then((content) => send({ jsonrpc: '2.0', id, result: { content, isError: false } }))
      .catch((e) => send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true } }));
  } else if (method === 'ping') {
    send({ jsonrpc: '2.0', id, result: {} });
  } else if (method && method.startsWith('notifications/')) {
    return;
  } else if (id !== undefined) {
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

function main() {
  process.stderr.write(`comfy-native-apps targeting ${BASE} (timeout ${RUN_TIMEOUT_S}s)\n`);
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { handle(JSON.parse(line)); } catch (e) { process.stderr.write(`bad json: ${e.message}\n`); }
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

main();
