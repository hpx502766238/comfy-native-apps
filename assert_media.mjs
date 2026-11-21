// assert_media.mjs — offline assertions for the media-port conversion fix.
// No ComfyUI needed: pure loadNativeApp → buildOverrides → graphToPrompt checks.
// Run: node assert_media.mjs
import { loadNativeApp, buildOverrides, graphToPrompt } from './native_lib.mjs';

const W = 'E:/AIGenerationStudio/ComfyUI/ComfyUI/user/default/workflows/图生图/';
let failed = 0;
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' -> ' + JSON.stringify(got)}`);
  if (!ok) failed++;
};

// 四合一: the linearData `image` port is the top-level LoadImage #140; its value
// reaches the (hidden) shell `控制图` media feed through the shared loader node.
{
  const app = loadNativeApp(W + '控制生图四合一NSFW（不含提示词反推）-krea2_turbo.app.json');
  const p = app.inputs.find((i) => i.label === 'image');
  check('krea2 linear image port media/feed/loader', p?.media && p.feed?.nodeId === 140 && p.loader?.nodeId === 140, p);
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'x.png' }));
  check('krea2 139.image is a link to t140', JSON.stringify(prompt['139'].inputs.image) === '["t140",0]', prompt['139']);
  check('krea2 t140.image is the supplied path', prompt.t140?.inputs?.image === 'x.png', prompt.t140);
}

// controlnet: the linear `image` port targets LoadImage #58 directly; the bypassed
// #62 skeleton still routes Canny #57 to the (hidden) shell feed internally.
{
  const app = loadNativeApp(W + '控制生图-z_image_turbo_controlnet-基于Comfy官方模板自制.app.json');
  const p = app.inputs.find((i) => i.label === 'image');
  check('controlnet linear image port loader is #58', p?.media && p.loader?.nodeId === 58, p);
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'y.png' }));
  check('controlnet t58.image is the supplied path', prompt.t58?.inputs?.image === 'y.png', prompt.t58);
  check('controlnet Canny gets LoadImage', JSON.stringify(prompt.t57?.inputs?.image) === '["t58",0]', prompt.t57);
  check('controlnet internal consumer links to Canny', JSON.stringify(prompt['60'].inputs.image) === '["t57",0]', prompt['60']);
  check('controlnet bypassed #62 absent', !('t62' in prompt), Object.keys(prompt));
}

// style ref: linear `image` port drives LoadImage #69; hidden image2/image3 have
// no loader. A value routed to a no-loader media port still spawns a synthetic
// loader (exercises the same fallback through the shared media machinery).
{
  const app = loadNativeApp(W + '风格参考-krea2_style_ref-基于Comfy官方模板自制.app.json');
  const p = app.inputs.find((i) => i.label === 'image');
  const prompt = graphToPrompt(app, buildOverrides(app, { image: 'z.png' }));
  check('styleref linear image loader is #69', p?.media && p.loader?.nodeId === 69, p);
  check('styleref image1 links to t69', JSON.stringify(prompt['52'].inputs.image1) === '["t69",0]', prompt['52']);
  check('styleref image2/image3 stay null', prompt['52'].inputs.image2 === null && prompt['52'].inputs.image3 === null, prompt['52']);
  const img2 = app.shellInputs.find((s) => s.portName === 'image2');
  const prompt2 = graphToPrompt(app, new Map([['@media:' + img2.portId, 'z2.png']]));
  const syn = Object.keys(prompt2).find((k) => /^\d+$/.test(k) && prompt2[k].class_type === 'LoadImage');
  check('styleref synthetic loader holds z2.png', syn != null && prompt2[syn].inputs.image === 'z2.png', prompt2);
  check('styleref image2 links to synthetic loader', JSON.stringify(prompt2['52'].inputs.image2) === `["${syn}",0]`, prompt2['52']);
}

// scalar ports keep their literal override behaviour.
{
  const app = loadNativeApp(W + '控制生图四合一NSFW（不含提示词反推）-krea2_turbo.app.json');
  const prompt = graphToPrompt(app, buildOverrides(app, { prompt: 'a cat' }));
  check('scalar string override still literal (alias "prompt")', Object.values(prompt).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a cat'));
}

// linearData top-level ports route to their top-level node's widget.
{
  const app = loadNativeApp(W + '摄像机视角调整-krea2Angles-来自Github.app.json');
  const prompt = graphToPrompt(app, buildOverrides(app, { yaw: 12.5, distance: 1.25, seed: -1 }));
  check('krea2Angles yaw lands on the camera node', prompt.t7?.inputs?.yaw === 12.5, prompt.t7);
  check('krea2Angles distance lands on the camera node', prompt.t7?.inputs?.distance === 1.25, prompt.t7);
  check('krea2Angles seed -1 rolls a real seed', Number.isInteger(prompt.t11?.inputs?.seed) && Number(prompt.t11?.inputs?.seed) >= 0, prompt.t11);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
