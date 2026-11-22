#!/usr/bin/env node
// comfy-native-apps — an MCP server for small (9B-class) local models.
// Runs ComfyUI's NATIVE workflow apps (.app.json) and manages the render queue.
//
// It drives ONLY ComfyUI's NATIVE ".app.json" apps (the built-in "构建应用" feature)
// and does the UI→API conversion itself — so it works against a headless OR a
// frontend ComfyUI, with ZERO dependency on the artokun comfyui-mcp / panel plugin.
//
// Tools (no list_tools / describe_tool / call_tool indirection — the model sees
// exactly these, each single-purpose):
//
//   list_apps()                    -> catalog: number, name, description, output
//                                     types for every native .app.json app
//   get_app_params(app)            -> the parameter contract of ONE app
//                                     (input name + type + default, outputs)
//                                     COMBO inputs also carry their full options list
//   run_app(app, inputs, wait_s?)  -> fill only the params you want to change,
//                                     convert UI→API, enqueue, wait, return the
//                                     image (or the video URL); wait_s: 0 = submit only
//   upload_file(path, subfolder)   -> upload a LOCAL file (image/video/audio/mask)
//                                     into ComfyUI's input dir; returns the
//                                     ComfyUI-side relative path for a file param
//   download_output(prompt_id, index?, dest?) -> download one finished output to a
//                                     local file (file or dir dest); works remote too
//   queue_status(recent?)         -> what is running + pending, plus recent finished jobs
//   job_status(prompt_id, wait_s?, preview?, index?) -> state + output files of one
//                                     job; wait_s blocks, and a completed job returns
//                                     its view URL plus the image inline (no download)
//   clear_queue()                  -> clear the pending queue
//   interrupt()                    -> stop the current generation
//
// Config (env vars): COMFYUI_URL (http://127.0.0.1:8188),
//   COMFYUI_PUBLIC_URL (URL clients use for download links; defaults to
//   COMFYUI_URL), WORKFLOWS_ROOT (auto-detected), RUN_TIMEOUT_S (300),
//   DOWNLOAD_DIR (default <cwd>/downloads).
//   Legacy COMFYUI_HOST + COMFYUI_PORT still work as a fallback.
//
// Client config (Claude Code / any MCP client):
//   { "command": "node",
//     "args": ["E:/AIGenerationStudio/tools/comfy-native-apps/comfy_native_apps.mjs"],
//     "env": { "COMFYUI_URL": "http://127.0.0.1:8188" } }
import {
  BASE, RUN_TIMEOUT_S, appCatalog, appParams, resolveAppRef, loadNativeApp,
  graphToPrompt, buildOverrides, postPrompt, waitForJob, collectOutputs,
  getQueue, jobStatus, jobPreview, postJson, uploadFile, downloadOutput,
} from './native_lib.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'comfy-native-apps', version: '1.0.0' };

const TOOLS = [
  {
    name: 'list_apps',
    description: 'List the ComfyUI apps (.app.json) available on the server: number, name, short description and ' +
      'output types. Call this first to pick an app, then get_app_params(app) for the params you can fill.',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_app_params',
    description: 'Show the parameter contract of ONE app: every input param (name, type, default) and its outputs. ' +
      'COMBO inputs also carry their full "options" list so you can pick a value instead of guessing a filename. ' +
      'Call this after list_apps and before run_app to see which params exist.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Which app: its number from list_apps (e.g. "1"), its name, or its id.' },
      },
      required: ['app'],
    },
  },
  {
    name: 'run_app',
    description: 'Run one app: fill its input params and generate. Waits for the job and returns the finished image ' +
      '(or the video URL). Pass app as its number from list_apps, its name, or its id. ' +
      'Call get_app_params first, then pass the params you want to change in the "inputs" object ' +
      '(NOT at the top level — a stray field is an error, not a silently-ignored default). ' +
      'Omitted ones keep their defaults. A seed of -1 rolls a random seed. ' +
      'Set wait_s to 0 to enqueue and return the prompt_id immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'Which app to run: its number from list_apps (e.g. "1"), its name, or its id (relative workflows path).' },
        inputs: {
          type: 'object',
          description: 'Params to fill, keyed by the names get_app_params returns (e.g. "prompt", "seed"). Omit any you want to leave at its default.',
          additionalProperties: true,
        },
        wait_s: {
          type: 'integer', minimum: 0, maximum: 3600,
          description: 'Seconds to block waiting for the result. Defaults to the server RUN_TIMEOUT_S. 0 = submit and return prompt_id at once.',
        },
      },
      required: ['app'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a local file (image / video / audio / mask — anything a ComfyUI input can load) into ' +
      'the ComfyUI input folder, so it can be referenced by run_app. Give the LOCAL path to the file on this ' +
      'machine; optionally a subfolder name. Returns the ComfyUI-side relative path to pass as the value of ' +
      'an image/video/audio/mask input param.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute (or relative) path to the LOCAL file to upload, e.g. "C:/pics/my photo.png" or "D:/vids/clip.mp4".' },
        subfolder: { type: 'string', description: 'Optional destination subfolder inside the ComfyUI input dir (no leading/trailing slash).'},
      },
      required: ['path'],
    },
  },
  {
    name: 'queue_status',
    description: 'Show the ComfyUI queue: what is running and pending now, plus the last few finished jobs (recent, newest first).',
    inputSchema: {
      type: 'object',
      properties: {
        recent: { type: 'integer', description: 'How many finished jobs to list in "recent". Defaults to 5, use 0 to skip history.', minimum: 0, maximum: 50 },
      },
      required: [],
    },
  },
  {
    name: 'job_status',
    description: 'Report the state (running / pending / completed / error) and output files of one job. ' +
      'Pass the UUID prompt_id returned by run_app. While a job is still queued, its queue number also works. ' +
      'Set wait_s to block until the job finishes (or the budget runs out) instead of polling. ' +
      'When the job is completed, each output carries a viewable "url", and (preview=true, the default) the ' +
      'first image is returned inline so a submit-only run_app can be previewed without download_output.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: { type: 'string', description: 'The prompt_id returned by run_app or seen in queue_status.' },
        wait_s: { type: 'integer', minimum: 0, maximum: 3600, description: 'Block until the job finishes, up to this many seconds. Defaults to 0 (return at once).' },
        preview: { type: 'boolean', description: 'When the job is completed, return the image inline (base64) for immediate viewing. Defaults to true; set false to get only the JSON status/URLs.' },
        index: { type: 'integer', minimum: 0, description: 'Which output to preview when the job wrote several. Defaults to 0.' },
      },
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
  {
    name: 'download_output',
    description: 'Download one finished output to a local file. Only needs the prompt_id returned by run_app or job_status; ' +
      'filename comes from ComfyUI history, so it works for local and remote ComfyUI alike. ' +
      'dest is a file path or a directory (relative paths resolve against the MCP server working dir); ' +
      'omit it to use $DOWNLOAD_DIR, else <cwd>/downloads.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt_id: { type: 'string', description: 'The prompt_id returned by run_app or job_status.' },
        index: { type: 'integer', description: 'Which output to take when the job wrote several. Defaults to 0.', minimum: 0 },
        dest: { type: 'string', description: 'Local destination: a file ("E:/out/clip.mp4"), a directory ("E:/out" or "out/"), or a relative path. Omit for the default downloads folder.' },
      },
      required: ['prompt_id'],
    },
  },
];

// --------------------------------------------------------------------------- #
// Tool handlers.
// --------------------------------------------------------------------------- #
function listAppsHandler() {
  return JSON.stringify(appCatalog(), null, 2);
}

async function appParamsHandler({ app }) {
  return JSON.stringify(await appParams(app), null, 2);
}

async function uploadFileHandler({ path: localPath, subfolder }) {
  const r = await uploadFile(localPath, subfolder);
  return [{ type: 'text', text: JSON.stringify(r, null, 2) }];
}

async function downloadOutputHandler(args) {
  const r = await downloadOutput(args);
  return [{ type: 'text', text: JSON.stringify(r, null, 2) }];
}

// Params travel in ONE field, "inputs" (the same word get_app_params returns).
// Anything else at the top level is a misplaced param — a model that meant "inputs"
// but wrote "input" / "values" / "params", or flat name → value pairs. Failing loudly
// here is the whole point: silently dropping them would run the app with its saved
// defaults and return a plausible image the model takes for its own request.
async function runAppHandler({ app, wait_s, inputs, ...stray }) {
  const ref = resolveAppRef(app);
  const a = loadNativeApp(ref.file);
  const labels = new Set(a.inputs.map((i) => String(i.label)));
  const strayNames = Object.keys(stray);
  if (strayNames.length) {
    // Name the strays that are clearly this app's params so the model sees its own
    // mistake, not a generic "unknown key".
    const asParams = strayNames.filter((k) => labels.has(k) || /^loras?\./i.test(k) || /seed|prompt|width|height/i.test(k));
    const where = asParams.length
      ? `"${asParams.join('", "')}" ${asParams.length === 1 ? 'is' : 'are'} ${a.name}'s params`
      : `top-level "${strayNames.join('", "')}" ${strayNames.length === 1 ? 'is' : 'are'} not a run_app field`;
    throw new Error(
      `run_app takes "app", "inputs", "wait_s" only — ${where}. ` +
      `Move every param inside the "inputs" object (see get_app_params); left at the top level it would be ignored and the app would run with its saved defaults.`,
    );
  }
  if (inputs !== undefined && (typeof inputs !== 'object' || inputs === null || Array.isArray(inputs))) {
    throw new Error('"inputs" must be an object of param name → value (see get_app_params)');
  }
  const values = inputs ?? {};
  const overrides = buildOverrides(a, values);
  const prompt = graphToPrompt(a, overrides);
  const resp = await postPrompt(prompt);
  const promptId = resp.prompt_id;

  const waitS = wait_s === undefined || wait_s === null || wait_s === ''
    ? RUN_TIMEOUT_S
    : Math.max(0, Number(wait_s) || 0);

  // wait_s: 0 → submit only; the client decides later with job_status(wait_s).
  if (waitS === 0) {
    const st = await jobStatus(promptId);
    return [{
      type: 'text',
      text: JSON.stringify({
        ...st,
        hint: 'Job submitted. Call job_status with this prompt_id and wait_s to block; once completed it returns the image inline plus a view URL, so no download is needed.',
      }, null, 2),
    }];
  }

  let entry;
  try {
    entry = await waitForJob(promptId, waitS);
  } catch (e) {
    if (e.code !== 'TIMEOUT') throw e;
    const st = await jobStatus(promptId);
    return [{
      type: 'text',
      text: JSON.stringify({
        ...st,
        timed_out: true,
        waited_s: waitS,
        hint: 'Still not finished. Call job_status with this prompt_id and wait_s to keep waiting; it returns the image inline once completed (download_output only if you need a local file).',
      }, null, 2),
    }];
  }

  const out = await collectOutputs(entry);

  if (out.kind === 'image') {
    const lines = [`Generated ${out.filename} with app "${a.name}".`, `URL: ${out.url}`];
    lines.push(`(prompt_id ${promptId})`);
    if (out.extra?.length) lines.push('', 'Other outputs:', ...out.extra);
    return [
      { type: 'text', text: lines.join('\n') },
      { type: 'image', data: out.b64, mimeType: out.mime },
    ];
  }
  if (out.kind === 'video') {
    const lines = [`App "${a.name}" finished (prompt_id ${promptId}).`, `Video: ${out.url}`];
    if (out.extra?.length) lines.push('', 'Other outputs:', ...out.extra);
    return [{ type: 'text', text: lines.join('\n') }];
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
        case 'get_app_params': return [{ type: 'text', text: await appParamsHandler(args) }];
        case 'run_app': return runAppHandler(args);
        case 'upload_file': return uploadFileHandler(args);
        case 'download_output': return downloadOutputHandler(args);
        case 'queue_status': {
          const recent = Math.min(Math.max(Number(args.recent ?? 5) || 0, 0), 50);
          return [{ type: 'text', text: JSON.stringify(await getQueue({ recent }), null, 2) }];
        }
        case 'job_status': {
          const waitS = Math.min(Math.max(Number(args.wait_s ?? 0) || 0, 0), 3600);
          const st = await jobStatus(args.prompt_id, { waitS });
          const content = [{ type: 'text', text: JSON.stringify(st, null, 2) }];
          // Completed + preview (default on): attach the image inline so a
          // submit-only run_app can be viewed without download_output.
          if (st.state === 'completed' && args.preview !== false) {
            const index = Math.max(0, Number(args.index ?? 0) || 0);
            const out = await jobPreview(st.prompt_id, { index }).catch(() => null);
            if (out?.kind === 'image') content.push({ type: 'image', data: out.b64, mimeType: out.mime });
          }
          return content;
        }
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
