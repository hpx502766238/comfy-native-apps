// assert_media.mjs — offline regression checks for the native-app converter.
// No ComfyUI needed: pure loadNativeApp → buildOverrides → graphToPrompt checks.
// Run: node assert_media.mjs
//
// These checks use a few REAL apps as fixtures. If one is renamed or removed, its
// block is SKIPPED (not failed): the MCP itself is generic and discovers every
// *.app.json at runtime — only this dev suite needs concrete sample files.
import { loadNativeApp, buildOverrides, graphToPrompt, listApps } from './native_lib.mjs';

// Resolve fixtures by id substring, so renaming an app file does not break this.
const APPS = listApps().apps.filter((a) => !a.error);
const appFile = (needle, avoid) => {
  const hits = APPS.filter((a) => a.id.includes(needle) && (!avoid || !a.id.includes(avoid)));
  return hits.length ? hits[0].file : null;
};
// Two sibling apps share this id prefix: the plain 四合一 (whose 20-port surface
// this suite asserts) and the -含LLMAPI提示词反推 variant (different ports: 可选创意,
// 控制预处理net分辨率, no 强制启用超分后处理). Skip the LLMAPI one so the fixture is
// unambiguous — this is test-only disambiguation; runtime supports both equally.
const fourInOne = () => appFile('控制生图四合一-krea2_turbo', 'LLMAPI');
const krea2Angles = () => appFile('krea2Angles');
const controlnet = () => appFile('控制生图-z_image_turbo_controlnet');
const styleRef = () => appFile('风格参考-krea2_style_ref');

let failed = 0;
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' -> ' + JSON.stringify(got)}`);
  if (!ok) failed++;
};
// Run a fixture block, or skip it when the sample app is absent.
const withFixture = (file, label, fn) => {
  if (!file) { console.log(`SKIP ${label} (fixture not found)`); return; }
  fn(loadNativeApp(file));
};

// 四合一: the linearData `image` port is the top-level LoadImage #140; its value
// reaches the (hidden) shell `控制图` media feed through the shared loader node.
withFixture(fourInOne(), 'krea2 linear media', (app) => {
  const p = app.inputs.find((i) => i.portName === 'image');
  check('krea2 linear image port media/feed/loader', p?.media && p.feed?.nodeId === 140 && p.loader?.nodeId === 140, p);
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'x.png' }));
  check('krea2 139.image is a link to t140', JSON.stringify(prompt['139'].inputs.image) === '["t140",0]', prompt['139']);
  check('krea2 t140.image is the supplied path', prompt.t140?.inputs?.image === 'x.png', prompt.t140);
});

// controlnet: the linear `image` port targets LoadImage #58 directly; the bypassed
// #62 skeleton still routes Canny #57 to the (hidden) shell feed internally.
withFixture(controlnet(), 'controlnet linear media', (app) => {
  const p = app.inputs.find((i) => i.portName === 'image');
  check('controlnet linear image port loader is #58', p?.media && p.loader?.nodeId === 58, p);
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'y.png' }));
  check('controlnet t58.image is the supplied path', prompt.t58?.inputs?.image === 'y.png', prompt.t58);
  check('controlnet Canny gets LoadImage', JSON.stringify(prompt.t57?.inputs?.image) === '["t58",0]', prompt.t57);
  check('controlnet internal consumer links to Canny', JSON.stringify(prompt['60'].inputs.image) === '["t57",0]', prompt['60']);
  check('controlnet bypassed #62 absent', !('t62' in prompt), Object.keys(prompt));
});

// style ref: linear `image` port drives LoadImage #69; hidden image2/image3 have
// no loader. A value routed to a no-loader media port still spawns a synthetic
// loader (exercises the same fallback through the shared media machinery).
withFixture(styleRef(), 'style-ref linear media', (app) => {
  const p = app.inputs.find((i) => i.portName === 'image');
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'z.png' }));
  check('styleref linear image loader is #69', p?.media && p.loader?.nodeId === 69, p);
  check('styleref image1 links to t69', JSON.stringify(prompt['52'].inputs.image1) === '["t69",0]', prompt['52']);
  check('styleref image2/image3 stay null', prompt['52'].inputs.image2 === null && prompt['52'].inputs.image3 === null, prompt['52']);
  const img2 = app.shellInputs.find((s) => s.portName === 'image2');
  const prompt2 = graphToPrompt(app, new Map([['@media:' + img2.portId, 'z2.png']]));
  const syn = Object.keys(prompt2).find((k) => /^\d+$/.test(k) && prompt2[k].class_type === 'LoadImage');
  check('styleref synthetic loader holds z2.png', syn != null && prompt2[syn].inputs.image === 'z2.png', prompt2);
  check('styleref image2 links to synthetic loader', JSON.stringify(prompt2['52'].inputs.image2) === `["${syn}",0]`, prompt2['52']);
});

// scalar ports keep their literal override behaviour.
withFixture(fourInOne(), 'krea2 scalar override', (app) => {
  const prompt = graphToPrompt(app, buildOverrides(app, { prompt: 'a cat' }));
  check('scalar string override still literal (alias "prompt")', Object.values(prompt).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a cat'));
});

// linearData top-level ports route to their top-level node's widget.
withFixture(krea2Angles(), 'krea2Angles top-level routing', (app) => {
  const prompt = graphToPrompt(app, buildOverrides(app, { yaw: 12.5, distance: 1.25, seed: -1 }));
  check('krea2Angles yaw lands on the camera node', prompt.t7?.inputs?.yaw === 12.5, prompt.t7);
  check('krea2Angles distance lands on the camera node', prompt.t7?.inputs?.distance === 1.25, prompt.t7);
  check('krea2Angles seed -1 rolls a real seed', Number.isInteger(prompt.t11?.inputs?.seed) && Number(prompt.t11?.inputs?.seed) >= 0, prompt.t11);
});

// linearMode port NAMES mirror the frontend: the target socket's
// label ?? localized_name ?? name, not the linearData short key (which stays an alias).
withFixture(fourInOne(), 'krea2 frontend port names', (app) => {
  const labels = app.inputs.map((i) => i.label);
  const want = ['图像', '使用原图分辨率生成', '自定义分辨率宽高比', '自定义分辨率百万像素', '自定义分辨率预览', '提示词',
    'loras.0.lora_name', 'loras.0.strength', 'loras.0.enabled', 'loras.1.lora_name', 'loras.1.strength', 'loras.1.enabled',
    'controlnet通道选择', '控制net分辨率', 'depth强度', 'pose强度', 'candy强度', 'tile强度', 'tile预处理器', '强制启用超分后处理'];
  check('krea2 frontend port names (exact order)', JSON.stringify(labels) === JSON.stringify(want), labels);
  const img = app.inputs.find((i) => i.label === '图像');
  check('krea2 Chinese label keeps old key as alias', img?.aliases?.includes('image'), img);
  check('krea2 Chinese labels route via aliases and media override', img?.media && buildOverrides(app, { 图像: 'x.png' }).has('@media:@lin:140:image'), img);
});

withFixture(krea2Angles(), 'krea2Angles localized labels', (app) => {
  const seed = app.inputs.find((i) => i.label === '种子');
  check('krea2Angles localized label keeps old key as alias', seed?.aliases?.includes('seed'), seed);
  check('krea2Angles alias routes to the top node', buildOverrides(app, { seed: 3 }).has('@top:11:seed'), [...buildOverrides(app, { seed: 3 }).entries()]);
});

// GENERIC check (no fixture): frontend-only nodes (Note / MarkdownNote / Reroute /
// PrimitiveNode) must never reach the API prompt — ComfyUI rejects the whole job
// with missing_node_type. This scans EVERY app currently on disk, including new ones.
{
  const FE = /^(Note|MarkdownNote|Reroute|PrimitiveNode)$/;
  const offenders = [];
  for (const a of APPS) {
    const app = loadNativeApp(a.file);
    const prompt = graphToPrompt(app, buildOverrides(app, {}));
    for (const [id, n] of Object.entries(prompt)) {
      if (FE.test(String(n.class_type))) offenders.push(`${a.id}#${id}:${n.class_type}`);
    }
  }
  check('no frontend-only node reaches the API prompt (all apps)', offenders.length === 0, offenders);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
