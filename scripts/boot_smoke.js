/* Boot smoke: run the real App.init() against a fake DOM whose element ids
   come from the actual index.html, with real config/i18n/game/quests/daily
   and stubbed Avatar/Sound/Onboarding. Catches wiring typos (an id in JS
   that index.html does not ship, a method that no longer exists) that the
   pure-logic regression cannot see.  Run: node scripts/boot_smoke.js */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let failures = 0;
const bad = (msg) => { failures++; console.log('  FAIL ' + msg); };
const ok = (cond, name) => { if (cond) console.log('  PASS ' + name); else bad(name); };

/* ids actually present in index.html */
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const IDS = new Set();
for (const m of html.matchAll(/id="([^"]+)"/g)) IDS.add(m[1]);

function makeEl(id) {
  const el = {
    id, innerHTML: '', textContent: '', value: '', disabled: false, style: {},
    src: '', title: '',
    classList: {
      _s: new Set(),
      add(...c) { c.forEach((x) => this._s.add(x)); },
      remove(...c) { c.forEach((x) => this._s.delete(x)); },
      toggle(c, on) { if (on === undefined) on = !this._s.has(c); on ? this._s.add(c) : this._s.delete(c); },
      contains(c) { return this._s.has(c); }
    },
    setAttribute() {}, getAttribute() { return null; },
    appendChild() {}, removeChild() {}, remove() {}, focus() {},
    querySelector(sel) { return makeEl(id + sel); },
    querySelectorAll() { return []; },
    addEventListener() {},
    play() { return Promise.resolve(); }, pause() {},
    getBoundingClientRect() { return { width: 100, height: 100, left: 0, top: 0 }; },
    getContext() {
      /* swallow-all 2d context so fx.js can draw against nothing */
      return new Proxy({ canvas: this }, {
        get(t, k) { if (k in t) return t[k]; return function () {}; },
        set(t, k, v) { t[k] = v; return true; }
      });
    }
  };
  return el;
}
const elCache = new Map();
const document = {
  getElementById(id) {
    if (!IDS.has(id)) return null;
    if (!elCache.has(id)) elCache.set(id, makeEl(id));
    return elCache.get(id);
  },
  querySelectorAll() { return []; },
  querySelector() { return null; },
  createElement(t) { return makeEl('dyn-' + t); },
  addEventListener() {},
  hidden: false
};

const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(store)[i] ?? null,
  get length() { return Object.keys(store).length; }
};

const FIXTURES = {
  'config/providers.json': null,
  'assets/_index/world_hierarchy.json': { areas: [{ id: 'area_01', name: 'クーケン島周辺地域',
    fields: [{ id: 'field_01_001', name: 'クーケン島',
      stages: [{ id: 'stage_01_001_04', name: 'ライザの家' }] }] }] },
  'assets/_index/npc_placement.json': { npcs: [] },
  'assets/_index/stage_background_map.json': { stage_01_001_04: 'stage_01_001_04' },
  'assets/_index/scenes.json': { stage_01_001_04: { aft: 'x' } },
  'assets/_index/ambient.json': ['amb_001_day.m4a'],
  'assets/_index/tap_voice.json': [],
  'assets/_index/se.json': [],
  'assets/_index/voice_bank.json': { ja: { normal: { goodMorning: { daytime: ['a.m4a'] }, wellDone: { daytime: ['b.m4a'] } } } },
  'assets/_index/skins.json': [{ id: 'crf_skn_002_0001_01', hasSpine: true, preview: 'p.png' }],
  'assets/_index/prologue.json': []
};

const sandbox = {
  console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval,
  Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  RegExp, Promise, Set, Map, Infinity, NaN
};
sandbox.performance = { now: () => Date.now() };
sandbox.window = sandbox;
sandbox.document = document;
sandbox.localStorage = localStorage;
sandbox.navigator = {};
sandbox.location = { origin: 'http://127.0.0.1:8765', reload() {} };
sandbox.fetch = (url) => {
  const key = String(url).replace(/^\.\//, '');
  if (key in FIXTURES) {
    return Promise.resolve({ ok: true, json: () => Promise.resolve(FIXTURES[key]) });
  }
  return Promise.resolve({ ok: false, json: () => Promise.reject(new Error('404 ' + key)) });
};
sandbox.XMLHttpRequest = function () {};
sandbox.Audio = function () { return makeEl('audio'); };
sandbox.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
sandbox.requestAnimationFrame = () => 0;
sandbox.cancelAnimationFrame = () => {};

/* module stubs that would need real GL / network */
const Avatar = {
  _initCb: null,
  init(cb) { this._initCb = cb; setTimeout(cb, 0); },
  resize() {}, onModeChange() {}, setHidden() {}, setEmotion() {}, setTalking() {},
  setTalkingEnvelope() {}, loadScene(id, tod, cb) { cb && cb(null); },
  loadSkin(id, cb) { cb && cb(); }, postureKey() { return 'posture_sitting'; },
  supportsBothPostures() { return false; }, hitPartAt() { return null; },
  poke() { return null; }, outfitOf(id) { return String(id).replace(/_(01|99)$/, ''); },
  setAtlasVariant() {}, variantPageUrls() { return []; }
};
sandbox.Avatar = Avatar;
sandbox.Onboarding = {
  showTitle(cb) { cb(); }, isDone() { return true; }, start() {},
  skip() {}, next() {}, prologueNext() {}, tutorialAdvance() { return false; }
};
sandbox.alert = () => {}; sandbox.confirm = () => true; sandbox.prompt = () => null;

vm.createContext(sandbox);
const load = (f) => vm.runInContext(fs.readFileSync(path.join(WEB, 'js', f), 'utf8'),
                                   sandbox, { filename: f });

for (const f of ['util.js', 'config.js', 'i18n.js', 'api.js', 'memory.js',
                 'game.js', 'quests.js', 'daily.js', 'world.js', 'audio.js',
                 'alarm.js', 'fx.js', 'nsfw.js', 'app.js']) {
  try { load(f); console.log('  loaded ' + f); }
  catch (e) { bad('load ' + f + ': ' + e.message); }
}

(async () => {
  try {
    await sandbox.App.init();
    await new Promise((r) => setTimeout(r, 50));   // let the init chain settle
    ok(true, 'App.init completed without throwing');

    const g = sandbox.Game, q = g.s.quest;
    ok(!!q && q.no === 1, 'quest chain started (no=' + (q && q.no) + ')');
    ok(g.s.stamina > 0, 'game state initialized');
    ok(document.getElementById('hud-stamina').innerHTML.indexOf('apple') >= 0 ||
       document.getElementById('hud-stamina').innerHTML === '',
       'HUD stamina chip rendered after boot');
    ok(sandbox.Daily.available(), 'daily claim available on fresh boot');

    /* exercise the reducer end-to-end through App events */
    g.applyDelta({ exp_delta: 400, money_delta: 100, quest: { step_add: 4 } });
    ok(sandbox.Quests.pendingAdvance(), 'quest1 cleared via reducer path');
    sandbox.Quests.takeNext();
    ok(g.s.quest.no === 2, 'chain advanced to quest2');

    /* render surfaces that index.html wires */
    sandbox.Quests.render(document.getElementById('quest-list'), {});
    sandbox.Daily.render(document.getElementById('daily-body'));
    sandbox.App.renderStatus();
    sandbox.App.renderInv();
    sandbox.App.buildSettings();
    sandbox.App.buildCharaForm();
    sandbox.App.updateHud();
    ok(true, 'render surfaces + settings form built');
    ok(!!sandbox.Memory && sandbox.Memory.promptBlock() === '', 'Memory module boots empty');
    sandbox.App.renderMemory();
    ok(!sandbox.App._lastText, 'no stale retry text');

    /* per-mode TTS voice direction: base hint + mode layer, overridable */
    const A = sandbox.Api, C = sandbox.Config;
    const base = C.section('tts').styleHint.trim();
    ok(A.ttsStyleFor('chat') === base, 'chat TTS = base hint only');
    const asmr = A.ttsStyleFor('asmr');
    ok(asmr.indexOf(base) === 0 && asmr.length > base.length &&
       /ささや/i.test(asmr), 'asmr TTS layers whisper direction');
    C.set('tts.modeHints', { asmr: '自定义耳语' });
    ok(A.ttsStyleFor('asmr') === base + ' 自定义耳语', 'tts.modeHints overrides the mode layer');
    C.set('tts.modeHints', {});
    ok(A.MODE_PLAY_FX.asmr.rate < 1 && A.MODE_PLAY_FX.asmr.gain < 1,
       'asmr playback shaping present');
    ok(A.isPlaceholderModel('tts-model') && !A.isPlaceholderModel('mimo-audio'),
       'placeholder-model check centralized');
    const nsfwTag = A.parseTaggedReply('[emotion:shy|attitude:agree|undress:on]\nhi');
    ok(nsfwTag.nsfw === true && nsfwTag.emotion === 'shy', 'undress:on parses with extra pipes');
    const spacedNsfw = A.parseTaggedReply('[emotion: shy | undress: on]\nhi');
    ok(spacedNsfw.nsfw === true && spacedNsfw.emotion === 'shy',
       'spaced undress:on still parses');
    const omitFace = A.parseTaggedReply('タグなし');
    ok(omitFace.emotion == null && omitFace.attitude == null,
       'missed emotion tag is omit, not a reset to neutral');
    ok(sandbox.Nsfw && /着ている/.test(sandbox.Nsfw.screenFact()),
       'prompt tells the LLM she is dressed');
    sandbox.Nsfw.onTurn({ nsfw: null });
    ok(!sandbox.Nsfw.active(), 'omitted tag does not strip');
    sandbox.Nsfw.onTurn(nsfwTag);
    ok(sandbox.Nsfw.active(), 'llm nsfw:on strips');
    ok(/肌が見えている/.test(sandbox.Nsfw.screenFact()),
       'prompt tells the LLM she is undressed');
    sandbox.Nsfw.reset();
    ok(!sandbox.Nsfw.active(), 'reset clears nsfw');

    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    sandbox.Config.set('state.stage', 'stage_01_001_04');
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'aft', 'real mode ignores LLM tod');
    sandbox.Config.set('app.timeMode', 'manual');
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'aft', 'manual mode ignores LLM tod');
    sandbox.Config.set('app.timeMode', 'flow');
    sandbox.Config.set('state.gameHour', 12);
    sandbox.Config.set('state.gameClockAt', Date.now());
    sandbox.App._applySceneDelta({ tod: 'ngt' });
    ok(sandbox.Config.section('state').tod === 'ngt', 'flow mode applies LLM tod');
    sandbox.Config.set('state.tod', 'aft');
    sandbox.Config.set('state.gameHour', 14);
    sandbox.Config.set('state.gameClockAt', Date.now());
    sandbox.App._applySceneDelta({ tod: 'aft' });
    ok(Math.abs(Number(sandbox.Config.section('state').gameHour) - 14) < 0.05,
       'echoing current tod does not rewind to band start');
    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    function tagLine(sys) {
      var m = String(sys).match(/^\[emotion:.+\]$/m);
      return m ? m[0] : '';
    }
    ok(/undress:off/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))) &&
       /stage:stage_01_001_04/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))) &&
       tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext())).indexOf('tod:') === -1,
       'real 出力形式 fills undress+stage, no tod slot');
    sandbox.Config.set('app.timeMode', 'flow');
    ok(/tod:/.test(tagLine(A.buildSystemPrompt('chat', 'voice', '', 'ja', '',
       sandbox.App._sceneContext()))),
       'flow 出力形式 includes current tod');
    sandbox.Config.set('app.timeMode', 'real');
    sandbox.Config.set('state.tod', 'aft');
    const sleptTod = sandbox.Config.section('state').tod;
    sandbox.App._sleepHome();
    ok(sandbox.Config.section('state').tod === sleptTod,
       'real sleep refills stamina without jumping the wall-clock band');
    ok(sandbox.Config.section('state').stage === 'stage_01_001_04', 'sleep still sends her home');

    sandbox.Config.set('state.mode', 'asmr');
    ok(!sandbox.App._rpgContext(), 'asmr skips numeric RPG block');
    ok(/stage_01_001_04/.test(sandbox.App._sceneContext()),
       'asmr still gets place catalog (marionette scene.*)');
    sandbox.Config.set('state.mode', 'chat');

    /* log-panel lifecycle (2026-09-07 UI pass): the panel is persistent —
       showBubble pushes a page + renders dots, nothing self-hides anymore,
       and a second typeBubble chain supersedes the first via the gen token */
    sandbox.App.showBubble('テスト');
    ok(sandbox.App._pages[sandbox.App._pages.length - 1] === 'テスト',
       'showBubble pushes the line into the log pages');
    ok(!sandbox.App._bubbleTimer, 'the panel no longer arms an auto-hide timer');
    sandbox.App.showBubble('テスト');
    ok(sandbox.App._pages.filter((x) => x === 'テスト').length === 1,
       'back-to-back identical lines do not stack duplicate dots');
    sandbox.App.typeBubble('一二三', null);
    const genAfterStart = sandbox.App._typeGen;
    sandbox.App.typeBubble('abc', null);
    ok(sandbox.App._typeGen === genAfterStart + 1, 'second type chain bumps the gen token');
  } catch (e) {
    bad('runtime: ' + (e && e.stack || e));
  }
  console.log(failures ? '\nBOOT SMOKE: ' + failures + ' FAILURES' : '\nBOOT SMOKE: ALL PASS');
  process.exit(failures ? 1 : 0);
})();
