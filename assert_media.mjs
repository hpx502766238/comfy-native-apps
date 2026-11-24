// assert_media.mjs — offline regression checks for the native-app converter.
// No ComfyUI needed: pure loadNativeApp → buildOverrides → graphToPrompt checks.
// Run: node assert_media.mjs
//
// Everything here is SYNTHETIC: a minimal .app.json fixture is generated in a temp
// dir, so the suite is self-contained and names no real workflow. A final generic
// pass scans whatever apps are actually installed and asserts shared invariants.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadNativeApp, buildOverrides, graphToPrompt, listApps } from './native_lib.mjs';

const SG_ID = 'sg-synthetic';

// A minimal native app: one subgraph input IMAGE fed by a top-level LoadImage,
// plus STRING and INT ports, an internal CLIPTextEncode/KSampler, a top-level
// SaveImage, and a frontend-only Note that must never be emitted.
function syntheticApp() {
  return {
    nodes: [
      {
        id: 1, type: SG_ID, pos: [0, 0], size: [200, 100], flags: {}, order: 0, mode: 0,
        inputs: [
          { name: 'image', type: 'IMAGE', link: 201, localized_name: 'Source Image' },
          { name: 'prompt', type: 'STRING', link: null, widget: { name: 'prompt' }, label: 'Prompt Text' },
          { name: 'seed', type: 'INT', link: null, widget: { name: 'seed' } },
        ],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [202] }],
        widgets_values: ['', 0],
        widgets_values_named: { prompt: '', seed: 0 },
      },
      {
        id: 2, type: 'LoadImage', pos: [0, 0], size: [100, 100], flags: {}, order: 1, mode: 0,
        inputs: [{ name: 'image', type: 'IMAGE', localized_name: 'Source Image', widget: { name: 'image' } }],
        outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [201] }],
        widgets_values: ['default.png'],
        widgets_values_named: { image: 'default.png' },
      },
      {
        id: 3, type: 'SaveImage', pos: [0, 0], size: [100, 100], flags: {}, order: 2, mode: 0,
        inputs: [{ name: 'images', type: 'IMAGE', link: 202 }],
        outputs: [],
        widgets_values: ['synthetic'],
        widgets_values_named: { filename_prefix: 'synthetic' },
      },
    ],
    links: [
      [201, 2, 0, 1, 0, 'IMAGE'],
      [202, 1, 0, 3, 0, 'IMAGE'],
    ],
    definitions: {
      subgraphs: [{
        id: SG_ID,
        name: 'Synthetic App',
        inputNode: { id: -10 },
        outputNode: { id: -20 },
        inputs: [
          { id: 'p-image', name: 'image', type: 'IMAGE', linkIds: [101] },
          { id: 'p-prompt', name: 'prompt', type: 'STRING', label: 'Prompt Text', linkIds: [102] },
          { id: 'p-seed', name: 'seed', type: 'INT', linkIds: [104] },
        ],
        outputs: [{ id: 'o-image', name: 'IMAGE', type: 'IMAGE', linkIds: [103] }],
        nodes: [
          { id: 10, type: 'CLIPTextEncode', mode: 0,
            inputs: [{ name: 'text', type: 'STRING', widget: { name: 'text' }, link: 102 }],
            outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [105] }],
            widgets_values_named: { text: '' } },
          { id: 11, type: 'ImageScale', mode: 0,
            inputs: [{ name: 'image', type: 'IMAGE', link: 101 }],
            outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [103] }],
            widgets_values_named: {} },
          { id: 12, type: 'KSampler', mode: 0,
            inputs: [
              { name: 'model', type: 'MODEL', link: null },
              { name: 'positive', type: 'CONDITIONING', link: 105 },
              { name: 'negative', type: 'CONDITIONING', link: null },
              { name: 'latent_image', type: 'LATENT', link: null },
              { name: 'seed', type: 'INT', widget: { name: 'seed' }, link: 104 },
            ],
            outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }],
            widgets_values_named: { seed: 0 } },
          { id: 150, type: 'Note', mode: 0, inputs: [], outputs: [], widgets_values_named: {} },
        ],
        links: [
          { id: 101, origin_id: -10, origin_slot: 0, target_id: 11, target_slot: 0, type: 'IMAGE' },
          { id: 102, origin_id: -10, origin_slot: 1, target_id: 10, target_slot: 0, type: 'STRING' },
          { id: 103, origin_id: 11, origin_slot: 0, target_id: -20, target_slot: 0, type: 'IMAGE' },
          { id: 104, origin_id: -10, origin_slot: 2, target_id: 12, target_slot: 4, type: 'INT' },
          { id: 105, origin_id: 10, origin_slot: 0, target_id: 12, target_slot: 1, type: 'CONDITIONING' },
        ],
      }],
    },
    extra: {
      linearData: {
        inputs: [
          [`${SG_ID}:2:image`, 'image'],
          [`${SG_ID}:1:prompt`, 'prompt'],
          [`${SG_ID}:1:seed`, 'seed'],
        ],
      },
    },
  };
}

let failed = 0;
const check = (label, ok, got) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ' -> ' + JSON.stringify(got)}`);
  if (!ok) failed++;
};

// --------------------------------------------------------------------------- #
// Synthetic fixture: linearMode labels, aliases, media routing, top widgets.
// --------------------------------------------------------------------------- #
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-app-fixture-'));
  const file = path.join(dir, 'synthetic.app.json');
  fs.writeFileSync(file, JSON.stringify(syntheticApp()));
  const app = loadNativeApp(file);

  const labels = app.inputs.map((i) => i.label);
  check('linearMode labels use the target socket name chain',
    JSON.stringify(labels) === JSON.stringify(['Source Image', 'Prompt Text', 'seed']), labels);

  const img = app.inputs.find((i) => i.label === 'Source Image');
  check('image port keeps the linearData key as an alias', img?.aliases?.includes('image'), img);
  check('image port routes to its top-level loader', img?.media && img.feed?.nodeId === 2 && img.loader?.nodeId === 2, img);

  const prompt = app.inputs.find((i) => i.label === 'Prompt Text');
  check('ref-adopted port keeps the old key as an alias', prompt?.aliases?.includes('prompt'), prompt);

  // Media value lands on the loader widget; the internal consumer links to it.
  const media = graphToPrompt(app, buildOverrides(app, { 'Source Image': 'x.png' }));
  check('internal consumer links to the top-level loader', JSON.stringify(media['11'].inputs.image) === '["t2",0]', media['11']);
  check('loader widget gets the supplied filename', media.t2?.inputs?.image === 'x.png', media.t2);
  check('top-level saver is kept (no synthetic saver added)', media.t3?.class_type === 'SaveImage', Object.keys(media));

  // Scalar overrides: alias key and localized label both resolve.
  const scalar = graphToPrompt(app, buildOverrides(app, { prompt: 'hello' }));
  check('alias key overrides the internal text widget', scalar['10'].inputs.text === 'hello', scalar['10']);
  const seed = graphToPrompt(app, buildOverrides(app, { seed: 3 }));
  check('ref-adopted scalar overrides its internal target', seed['12'].inputs.seed === 3, seed['12']);
  const rolled = graphToPrompt(app, buildOverrides(app, { seed: -1 }));
  check('seed -1 rolls a real seed', Number.isInteger(rolled['12'].inputs.seed) && rolled['12'].inputs.seed >= 0, rolled['12']);

  // Frontend-only node must never reach the API prompt.
  check('frontend-only Note is not emitted', !('150' in media) && !Object.values(media).some((n) => n.class_type === 'Note'), Object.keys(media));

  fs.rmSync(dir, { recursive: true, force: true });
}

// --------------------------------------------------------------------------- #
// Generic invariants over EVERY installed app (no fixture names/ids).
// --------------------------------------------------------------------------- #
{
  const apps = listApps().apps.filter((a) => !a.error);
  const FE = /^(Note|MarkdownNote|Reroute|PrimitiveNode)$/;
  const problems = [];
  for (const a of apps) {
    const app = loadNativeApp(a.file);
    const prompt = graphToPrompt(app, buildOverrides(app, {}));

    const labels = app.inputs.map((i) => i.label);
    if (labels.some((l) => !l)) problems.push(`${a.number}: empty input label`);
    if (new Set(labels).size !== labels.length) problems.push(`${a.number}: duplicate input labels`);

    for (const [id, n] of Object.entries(prompt)) {
      if (FE.test(String(n.class_type))) problems.push(`${a.number}#${id}: frontend-only ${n.class_type}`);
      if (!n.class_type || typeof n.inputs !== 'object') problems.push(`${a.number}#${id}: malformed node`);
    }

    for (const p of app.inputs) {
      if (p.media && !p.loader && !p.feed) problems.push(`${a.number}: media port "${p.label}" has no loader/feed`);
    }
  }
  check(`all installed apps convert cleanly (${apps.length} checked)`, problems.length === 0, problems);
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed');
process.exit(failed ? 1 : 0);
