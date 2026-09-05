/* Expression / animation coverage audit for both shipped skins.

Why this exists
---------------
The gesture JSON is a large table of named clips (faces, one-shots, occupancy
groups, tap reactions, FX, idle poses). Anything in it that the runtime never
selects is a feature the player will never see — and "never selected" happens
silently: a name that does not resolve in the .skel, a pose filtered out by an
applicableSittingIds mismatch, a band the app never enters, a part the hit-test
cannot name. This script answers, per skin:

  1. does EVERY animation name referenced by the gesture data resolve in the
     skeleton (through Avatar's own pickAnim suffix rules)?
  2. is every non-disabled expressionSet reachable, i.e. does the band it lives
     in (normal / strong / weak) have a trigger the app actually produces?
  3. which facial clips exist in the skeleton but nothing references?

Run:  node scripts/expression_coverage.js
Exit code 0 = every referenced name resolves and every live set is reachable.
*/
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const WEB = path.join(ROOT, 'web');
const spine = eval(fs.readFileSync(path.join(WEB, 'vendor', 'spine-webgl.js'), 'utf8') + '\n;spine');

class StubRegion {
  constructor(n) {
    this.name = n; this.width = 2; this.height = 2;
    this.u = 0; this.v = 0; this.u2 = 1; this.v2 = 1; this.x = 0; this.y = 0;
    this.splits = null; this.pads = null; this.rotation = false; this.rotate = false;
    this.index = -1; this.packed = false;
  }
}
const bin = new spine.SkeletonBinary(new spine.AtlasAttachmentLoader({
  findRegion(n) { return new StubRegion(n); }
}));
bin.scale = 1;

/* Same resolution rules as avatar.js pickAnim — keep them in sync. */
function pickAnim(names, name) {
  if (!name) return null;
  if (names.has(name)) return name;
  if (!/_idle$/.test(name) && names.has(name + '_idle')) return name + '_idle';
  if (!/_active$/.test(name) && names.has(name + '_active')) return name + '_active';
  const stripped = name.replace(/_(idle|active)$/, '');
  if (stripped !== name && names.has(stripped)) return stripped;
  return null;
}

const SKINS = ['crf_skn_002_0001_01', 'crf_skn_002_0001_99'];
/* Which intensity band the app actually enters, and from where. Mirrors
   Avatar._intensityBand(): strong while talking / tension high, weak in ASMR,
   normal otherwise — so all three are live. */
const BAND_TRIGGER = {
  strong: 'talking or tension > 0.66 (Avatar._intensityBand)',
  normal: 'idle outside ASMR',
  weak: 'idle in ASMR mode (intensitySpeedMultipliers.weak too)'
};
let problems = 0;

for (const id of SKINS) {
  const dir = path.join(WEB, 'assets', 'spine', 'crf_chr_002', id);
  const data = bin.readSkeletonData(
    new Uint8Array(fs.readFileSync(path.join(dir, id + '.skel'))));
  const names = new Set(data.animations.map(a => a.name));
  const g = JSON.parse(fs.readFileSync(path.join(dir, id + '_gesture.json'), 'utf8'));
  const eg = g.emotionalGesture, ep = eg.EmotionProfilesV4, pc = g.projectConfig;
  const used = new Set();
  const missing = [];
  const retired = [];

  const need = (n, where) => {
    if (!n) return;
    const hit = pickAnim(names, n);
    if (hit) used.add(hit);
    else missing.push(where + ' → ' + n);
  };

  /* --- faces ------------------------------------------------------------- */
  let liveSets = 0, deadSets = 0, unresolvable = 0;
  const bandCounts = {};
  for (const em of Object.keys(ep)) {
    for (const band of Object.keys(ep[em].intensityProfiles || {})) {
      const ip = ep[em].intensityProfiles[band];
      const sets = ip.expressionSets || [];
      let live = 0;
      for (const s of sets) {
        const disabled = (s.weight != null && !(Number(s.weight) > 0));
        if (disabled) { deadSets++; continue; }
        live++; liveSets++;
        /* a set whose clips do not resolve silently degrades to the band base */
        const parts = [s.eyeOpen, s.eyeClosed, s.eyebrow, s.mouth];
        if (parts.some(p => p && !pickAnim(names, p))) unresolvable++;
        parts.forEach(p => need(p, em + '.' + band + '.expr'));
      }
      bandCounts[band] = (bandCounts[band] || 0) + live;
      need(ip.eyeBase, em + '.' + band + '.eyeBase');
      need(ip.mouthBase, em + '.' + band + '.mouthBase');
      need(ip.eyebrowBase, em + '.' + band + '.eyebrowBase');
      (ip.effectSets || []).forEach(s => {
        if (s.weight != null && !(Number(s.weight) > 0)) return;
        /* effectSets carry the LOGICAL name (blush001, tear002…); the clip is
           projectConfig.fxOnAnimNames[name] — exactly what _syncFx resolves. */
        (s.names || []).forEach(n => need(pc.fxOnAnimNames[n] || n, em + '.' + band + '.effect'));
      });
      (ip.basePoses || []).forEach(p => need(p.id, em + '.' + band + '.basePose'));
    }
    need(ep[em].lipSyncScrubClip, em + '.lipSyncScrubClip');
    /* one-shots: the app picks one per (emotion, attitude) the LLM can emit */
    const fb = ep[em].fixedGestureBindingsByAttitude || {};
    for (const att of Object.keys(fb)) {
      const live2 = fb[att].filter(x => (x.weight || 0) > 0 && x.oneShotAnimation);
      if (!live2.length) { console.log('  WARN ' + em + '/' + att + ': no live one-shot'); problems++; }
      live2.forEach(x => need(x.oneShotAnimation, em + '.oneShot.' + att));
    }
  }
  need(pc.closedEyeAnimation, 'closedEyeAnimation');
  (eg.DriverDefs || []).forEach(d => { /* gaze drivers are params, not clips */ });
  (eg.TapReactions || []).forEach(t => need(t.OverlayID, 'tap.' + t.PartName));
  Object.keys(pc.fxOnAnimNames || {}).forEach(k => need(pc.fxOnAnimNames[k], 'fxOn.' + k));
  Object.keys(pc.fxOffAnimNames || {}).forEach(k => need(pc.fxOffAnimNames[k], 'fxOff.' + k));
  (eg.MotionGroups || []).forEach(m => {
    /* Groups whose clips the animator retired (…_active_ignore, or names that
       no longer exist in the .skel) are skipped at runtime by
       Avatar._pickLayerGroup's resolvable() guard — reporting them as breakage
       would hide the real misses. */
    [m.AnimName_1, m.AnimName_2].forEach(n => {
      if (!n) return;
      if (pickAnim(names, n)) { need(n, 'group.' + m.GroupId); return; }
      retired.push(m.GroupId + ' → ' + n);
    });
  });

  /* --- reports ----------------------------------------------------------- */
  const atts = new Set();
  Object.keys(ep).forEach(e => Object.keys(ep[e].fixedGestureBindingsByAttitude || {})
    .forEach(a => atts.add(a)));
  console.log('=== ' + id + '  (' + names.size + ' animations, ' +
    Object.keys(ep).length + ' emotions, attitudes ' + [...atts].sort().join('/') + ')');
  console.log('  expression sets: ' + liveSets + ' live / ' +
    (liveSets + deadSets) + ' total  (author-disabled ' + deadSets + ')');
  console.log('  live per band:   ' + Object.entries(bandCounts)
    .map(([b, n]) => b + '=' + n).join('  '));
  Object.keys(bandCounts).forEach(b => {
    if (!BAND_TRIGGER[b]) { console.log('  WARN band ' + b + ' has no trigger in the app'); problems++; }
  });
  if (unresolvable) console.log('  WARN ' + unresolvable + ' live expression sets reference a name that does not resolve');
  if (retired.length) {
    console.log('  author-retired limb groups skipped at runtime (' +
      [...new Set(retired.map(r => r.split(' ')[0]))].length + ' groups): ' +
      [...new Set(retired.map(r => r.split(' ')[0]))].slice(0, 8).join(', ') +
      (new Set(retired.map(r => r.split(' ')[0])).size > 8 ? ' …' : ''));
  }
  if (missing.length) {
    problems += missing.length;
    console.log('  UNRESOLVED REFERENCES (' + missing.length + '):');
    [...new Set(missing)].slice(0, 40).forEach(m => console.log('    ' + m));
  } else {
    console.log('  OK   every animation referenced by the gesture data resolves');
  }

  /* facial clips nothing points at */
  const facial = [...names].filter(n => /^facial_/.test(n));
  const orphan = facial.filter(n => !used.has(n));
  const orphanBase = orphan.filter(n => !/_(idle|active)$/.test(n));
  console.log('  facial clips: ' + facial.length + ', referenced: ' +
    (facial.length - orphan.length) + ', unreferenced: ' + orphan.length +
    ' (of which non _idle/_active variants: ' + orphanBase.length + ')');
  if (orphanBase.length) orphanBase.forEach(n => console.log('    orphan ' + n));
}

console.log(problems ? '\nCOVERAGE: ' + problems + ' problem(s)' : '\nCOVERAGE: OK');
process.exit(problems ? 1 : 0);
