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

// krea2: the IMAGE port is fed by top-level LoadImage #140.
{
  const app = loadNativeApp(W + '控制生图四合一NSFW（不含提示词反推）-krea2_turbo.app.json');
  const p = app.inputs.find((i) => i.label === '控制图');
  check('krea2 port media/feed/loader', p.media && p.feed?.nodeId === 140 && p.loader?.nodeId === 140, p);
  const prompt = graphToPrompt(app, buildOverrides(app, { 控制图: 'x.png' }));
  check('krea2 139.image is a link to t140', JSON.stringify(prompt['139'].inputs.image) === '["t140",0]', prompt['139']);
  check('krea2 t140.image is the supplied path', prompt.t140?.inputs?.image === 'x.png', prompt.t140);
}

// controlnet: LoadImage #58 -> bypassed #62 -> Canny #57 -> ref input.
{
  const app = loadNativeApp(W + '控制生图-z_image_turbo_controlnet-基于Comfy官方模板自制.app.json');
  const p = app.inputs.find((i) => i.label === 'control_image');
  check('controlnet feed is Canny #57', p.feed?.nodeId === 57 && p.loader?.nodeId === 58, p);
  check('controlnet chain skips bypassed #62', p.chain.join(',') === '57,58', p.chain);
  const prompt = graphToPrompt(app, buildOverrides(app, { control_image: 'y.png' }));
  check('controlnet t58.image is the supplied path', prompt.t58?.inputs?.image === 'y.png', prompt.t58);
  check('controlnet Canny gets LoadImage', JSON.stringify(prompt.t57?.inputs?.image) === '["t58",0]', prompt.t57);
  check('controlnet internal consumer links to Canny', JSON.stringify(prompt['60'].inputs.image) === '["t57",0]', prompt['60']);
  check('controlnet bypassed #62 absent', !('t62' in prompt), Object.keys(prompt));
}

// style ref: image1 has a loader, image2/image3 have none (synthetic loader).
{
  const app = loadNativeApp(W + '风格参考-krea2_style_ref-基于Comfy官方模板自制.app.json');
  const prompt = graphToPrompt(app, buildOverrides(app, { image2: 'z.png' }));
  check('styleref image1 links to t69', JSON.stringify(prompt['52'].inputs.image1) === '["t69",0]', prompt['52']);
  check('styleref synthetic loader holds z.png', prompt['999101']?.inputs?.image === 'z.png', prompt['999101']);
  check('styleref image2 links to synthetic loader', JSON.stringify(prompt['52'].inputs.image2) === '["999101",0]', prompt['52']);
  check('styleref image3 stays null', prompt['52'].inputs.image3 === null, prompt['52']);
}

// scalar ports keep their literal override behaviour.
{
  const app = loadNativeApp(W + '控制生图四合一NSFW（不含提示词反推）-krea2_turbo.app.json');
  const prompt = graphToPrompt(app, buildOverrides(app, { prompt: 'a cat', seed: 42 }));
  check('scalar string override still literal', Object.values(prompt).some((n) => n.class_type === 'CLIPTextEncode' && n.inputs.text === 'a cat'));
  check('scalar int override still literal', Object.values(prompt).some((n) => n.inputs?.seed === 42));
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
