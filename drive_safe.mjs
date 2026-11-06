// drive_safe.mjs — NON-destructive end-to-end test: list_apps + run_app + job_status.
// No /interrupt, no /queue clear (those are left for the user / a deliberate run).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const srv = spawn(process.execPath, ['comfy_native_apps.mjs'], { cwd: process.cwd() });
srv.stderr.on('data', (d) => process.stderr.write('[srv] ' + d));
let buf = '';
const pending = new Map();
srv.stdout.setEncoding('utf8');
srv.stdout.on('data', (c) => {
  buf += c;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const m = JSON.parse(line);
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
let n = 0;
const call = (method, params = {}) => new Promise((res) => { const id = ++n; pending.set(id, res); srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
const text = (r) => (r.result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');

await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } });
srv.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const la = await call('tools/call', { name: 'list_apps', arguments: {} });
const apps = JSON.parse(text(la)).apps;
console.log('### list_apps:', apps.length, 'apps ->', apps.map((a) => a.number + ':' + a.name).join(' | '));

// run the krea2 txt2img app (number 2) with a small overridden render
const ra = await call('tools/call', { name: 'run_app', arguments: { app: 'Text to Image (Z-Image-Turbo)', values: { width: 512, height: 512, seed: -1 } } });
const content = ra.result?.content ?? [];
const txt = content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
const img = content.find((c) => c.type === 'image');
console.log('\n### run_app:'); console.log(txt);
if (img) {
  const out = path.join(os.tmpdir(), 'comfy_native_mcp_test.png');
  fs.writeFileSync(out, Buffer.from(img.data, 'base64'));
  console.log('  -> IMAGE OK, saved to', out, '(' + img.data.length + ' b64 chars, ' + img.mimeType + ')');
} else {
  console.log('  -> NO IMAGE RETURNED');
}

const pidMatch = txt.match(/prompt_id (\S+)/);
if (pidMatch) {
  const js = await call('tools/call', { name: 'job_status', arguments: { prompt_id: pidMatch[1] } });
  console.log('\n### job_status(' + pidMatch[1] + '):'); console.log(text(js));
}

srv.kill();
setTimeout(() => process.exit(img ? 0 : 1), 200);
