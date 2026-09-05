/* Headless behavior regression for the RPG layer (game.js / quests.js /
   daily.js / api.js reducers). Run:  node scripts/game_logic_regression.js
   Mirrors what motion_regression.js does for avatar.js: DOM/audio are
   stubbed, the real modules run untouched. */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const WEB = path.join(__dirname, '..', 'web', 'js');
let failures = 0;
function ok(cond, name) {
  if (cond) console.log('  PASS ' + name);
  else { failures++; console.log('  FAIL ' + name); }
}

/* ------------------------------------------------------------- stubs */
const store = {};
const localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
  key: (i) => Object.keys(localStorage)[i] || null,
  get length() { return Object.keys(store).length; }
};
const fakeEl = {
  classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
  style: {}, querySelector() { return fakeEl; }, querySelectorAll() { return []; },
  appendChild() {}, setAttribute() {}, addEventListener() {}, innerHTML: ''
};
const sandbox = {
  console,
  setTimeout, clearTimeout,
  Math, JSON, Date, Object, Array, String, Number, isFinite, parseInt, parseFloat,
  RegExp, Infinity, NaN,
};
sandbox.window = sandbox;
sandbox.localStorage = localStorage;
sandbox.document = {
  getElementById: () => null,
  querySelectorAll: () => [],
  addEventListener: () => {}
};
sandbox.navigator = {};
sandbox.location = { origin: 'http://127.0.0.1:8765' };
vm.createContext(sandbox);

function load(file) {
  vm.runInContext(fs.readFileSync(path.join(WEB, file), 'utf8'), sandbox, { filename: file });
}

load('util.js');
load('config.js');
load('game.js');
/* Audio / fx / quests render helpers used at clear time. */
sandbox.Sound = { se() {}, tapVoice() {} };
sandbox.Fx = { burstConfetti() {} };
sandbox.I18n = {
  t: (k) => k,
  tc: (k, fb) => fb,
  tf: (k, fb) => fb,
  all: (k) => {
    if (k === 'place.stage_01_002_01') return ['塔奥家门前', 'In front of Tao’s house'];
    if (k === 'place.stage_01_001_04') return ['莱莎家', 'Ryza’s Home'];
    return [];
  },
  LANG_NAMES: { ja: '日本語', zh: '简体中文' }
};
load('quests.js');
load('daily.js');
load('api.js');
load('world.js');

const { Game, Quests, Daily, Config, Api, World } = sandbox;

/* ------------------------------------------------------------ basics */
console.log('# Game basics');
Game.load();
ok(Game.level() === 1, 'start at level 1');
ok(Game.max() === 60, 'stamina cap 60 at lvl1 (50 + 10*lvl)');
Game.s.stamina = Game.max();
ok(Game.apples().filled === 5, 'five full apples');
ok(Game.turnCost('chat', 'voice') === 2, 'chat+voice costs 2');
ok(Game.turnCost('asmr', 'voice') === 4, 'asmr voice costs 4');
ok(Game.turnCost('chat', 'text') === 1, 'plain text costs 1');
ok(Game.spend(10) && Game.s.stamina === Game.max() - 10, 'spend works');
ok(!Game.spend(999), 'cannot overspend');
ok(!Game.faint(), 'not faint yet');
Game.s.stamina = 0;
ok(Game.faint(), 'faint at zero (no cheat)');
Game.restore(30);
ok(Game.s.stamina === 30, 'restore clamps');

console.log('# cheat');
Config.set('app.cheat', true);
Game.s.stamina = 0;
ok(!Game.faint(), 'cheat: never faints');
ok(Game.canAct(999), 'cheat: canAct always');
Game.spend(50);
ok(Game.s.stamina === 0, 'cheat: spend is a no-op');
ok(Game.apples().filled === 5, 'cheat: HUD shows full row');
Game.s.money = 50;
Game.addMoney(-20);
ok(Game.s.money === 50 && Game.canPay(999), 'cheat: gold does not decrease');
Config.set('app.cheat', false);
Game.refill();

console.log('# exp / level');
const lv0 = Game.level(), max0 = Game.max();
Game.addExp(500);
ok(Game.level() > lv0 && Game.max() > max0, 'exp raises level and stamina cap');

console.log('# bags');
Game.reset();
for (let i = 0; i < 30; i++) Game.addItem('you', 'item' + i, 1);
ok(Game.bagUsed('you') <= Game.bagCap('you'), 'bag never exceeds capacity');
Game.s.money = 1000;
const capBefore = Game.bagCap('you');
ok(Game.upgradeBag('you'), 'bag upgrade with enough gold');
ok(Game.bagCap('you') > capBefore, 'capacity grew, gold spent: ' + Game.s.money);
Game.s.bagYou = 'small';
Game.s.inventory = [];
Game.addItem('you', 'emeralia', 1);
Game.addItem('you', 'uni', 1);
Game.addItem('you', 'wasser', 1);
ok(Game.bagUsed('you') === 3 && Game.bagCap('you') === 6, 'small bag = 6 slots');

console.log('# reducer / <state> protocol');
Game.reset();
Game.s.quest = null;
Quests.ensure();
const parsed = Api.parseTaggedReply(
  '[emotion:happy|attitude:agree]\nわかった、採ってくるね！' +
  '<state>{"stamina_delta":-2,"exp_delta":25,"money_delta":40,' +
  '"inventory_added":[{"id":"honey","count":1}],' +
  '"quest":{"step_add":1}}</state>');
ok(parsed.emotion === 'happy' && parsed.text.indexOf('<state>') === -1,
   'tag + state block stripped from display text');
ok(parsed.state && parsed.state.quest.step_add === 1, 'state block parsed');
const q = Quests.active();
const before = { exp: Game.s.exp_total, money: Game.s.money, stamina: Game.s.stamina, step: q.step };
Game.applyDelta(parsed.state, 'llm');
ok(Game.s.exp_total === before.exp + 25, 'exp applied');
ok(Game.s.money === before.money + 40, 'money applied');
ok(Game.s.stamina === before.stamina - 2, 'stamina applied');
ok(Game.countItem('you', 'honey') === 1, 'item applied');
ok(Quests.active().step === before.step + 1, 'quest step advanced via reducer');

console.log('# hostile / garbage deltas');
const moneyBefore = Game.s.money;
Game.applyDelta({ stamina_delta: -1e9, money_delta: 1e9, exp_delta: -1e9 }, 'llm');
ok(Game.s.money <= moneyBefore + 2000 && Game.s.stamina >= 0 && Game.s.exp_total >= 0,
   'deltas clamped, nothing breaks');
Game.applyDelta('nonsense'); Game.applyDelta(null);
ok(true, 'garbage input survives');

/* list-shaped garbage: the LLM sending inventory_added as an object/string
   used to throw mid-reducer (half-applied state) — must degrade to no-op */
Game.s.money = 500; Game.s.exp_total = 0;
Game.applyDelta({ money_delta: 10, inventory_added: 'oops',
                  ryza_inventory_removed: { id: 'emeralia' }, exp_delta: 5 }, 'llm');
ok(Game.s.money === 510 && Game.s.exp_total === 5,
   'non-array inventory lists skipped, rest of delta still applied');

console.log('# battle economics (area used to be a string: NaN wiped gold)');
Game.reset();
Game.s.quest = null;
Config.set('state.stage', 'stage_01_001_04');
ok(Quests.startNo(5).type === 'battle', 'battle quest active for the action test');
Game.s.money = 500;
let bres = null, btry = 0;
do { Game.s.stamina = Game.max(); bres = Quests.doAction('battle'); btry++; }
while (!(bres.ok || bres.done) && btry < 90);
ok(bres.ok && Number.isFinite(Game.s.money) && Game.s.money > 500,
   'battle win PAYS gold (regression: NaN reward silently reset the purse to 0)');

console.log('# main chain 1..8');
Game.reset();
Game.s.quest = null;
let qq = Quests.ensure();
ok(qq.no === 1 && qq.type === 'talk', 'starts at talk quest');
for (let i = 0; i < 4; i++) Quests.progressEvent('talk');
ok(Quests.pendingAdvance(), 'clearing quest1 sets pending advance');
qq = Quests.takeNext();
ok(qq.no === 2 && qq.type === 'explore', 'chain advances to explore');
Quests.progressEvent('explore');
Quests.progressEvent('explore');
qq = Quests.takeNext();
ok(qq.no === 3 && qq.type === 'gather', 'chain advances to gather');

/* gather needs a stage context */
sandbox.Config.set('state.stage', 'stage_01_001_04');
let res = Quests.doAction('gather');
ok(res.ok && res.line, 'gather action works');
qq = Quests.active();
while (qq.step < qq.need) { Quests.doAction('gather'); qq = Quests.active(); }
ok(qq.complete, 'gather quest completes through actions');
qq = Quests.takeNext();
ok(qq.no === 4 && qq.type === 'craft', 'chain at craft');

/* give materials and craft */
Game.s.stamina = Game.max();
Game.addItem('you', 'emeralia', 2);
Game.addItem('you', 'wasser', 2);
res = Quests.doAction('craft');
ok(res.ok && Game.countItem('you', 'bottle') >= 1, 'crafting produces 回復のボトル');
qq = Quests.takeNext();
ok(qq.no === 5 && qq.type === 'battle', 'chain at battle');
Game.s.stamina = Game.max();
let guard = 0;
do { Game.s.stamina = Game.max(); res = Quests.doAction('battle'); guard++; }
while (!(res.ok && res.done) && guard < 60);
ok(res.ok && res.done, 'battle winnable (' + guard + ' tries)');
qq = Quests.takeNext();
ok(qq.no === 6 && qq.type === 'shop', 'chain at shop');
Game.s.stamina = Game.max();
Game.addItem('you', 'uni', 2);
res = Quests.doAction('shop');
ok(res.ok, 'shop sells items');
qq = Quests.takeNext();
ok(qq.no === 7 && qq.type === 'build', 'chain at build');
for (const part of ['driftwood', 'ironwood', 'cloth', 'ore']) {
  Game.addItem('you', part, 1);
  Game.s.stamina = Game.max();
  const r = Quests.doAction('build');
  ok(r.ok, 'ship part ' + part + ' installed');
}
qq = Quests.takeNext();
ok(qq.no === 8 && qq.type === 'sail', 'chain at sail');
ok(Game.flag('ship_parts') === 4, 'four ship parts flagged');
Game.s.money = 250;
Game.s.stamina = Game.max();
res = Quests.doAction('sail');
ok(res.ok && res.sail, 'sail action fires');
ok(Game.s.sailed === true, 'world unlock flag set');
/* -200G sailing fee + the quest-8 clear reward (20+8*20=180G) */
ok(Game.s.money === 250 - 200 + 180, 'sail fee paid, clear reward granted: ' + Game.s.money);
qq = Quests.takeNext();
ok(qq.no >= 9 || qq.no === 9 + 100, 'past quest8 -> infinite side quests');

console.log('# daily login');
Game.reset();
localStorage.removeItem('ryza.daily.v1');
Daily.s = { lastDate: '', streak: 0, claimedDays: [] };
const d1 = Daily.claim();
ok(d1.ok && Daily.streak() === 1, 'day1 claim: full stamina');
ok(Game.s.stamina === Game.max(), 'day1 refills stamina');
const y = new Date(); y.setDate(y.getDate() - 1);
const yStr = y.getFullYear() + '-' + (y.getMonth() + 1) + '-' + y.getDate();
localStorage.setItem('ryza.daily.v1',
  JSON.stringify({ lastDate: yStr, streak: 1, claimedDays: [0] }));
const d2 = Daily.claim();
ok(d2.ok && Daily.streak() === 2 && Game.s.money >= 120, 'day2 pays 120G');
const again = Daily.claim();
ok(!again.ok && again.reason === 'done', 'double claim refused');

console.log('# persistence round-trip');
Game.reset();
Quests.ensure();
Quests.progressEvent('talk');
const snap = Game.snapshot();
Game.reset();
Game.restoreSnapshot(snap);
ok(JSON.stringify(Game.snapshot()) === JSON.stringify(snap), 'snapshot round-trips');

console.log('# talk map move (entry_map_move / current_stage)');
World.hierarchy = JSON.parse(fs.readFileSync(
  path.join(__dirname, '..', 'web', 'assets', '_index', 'world_hierarchy.json'), 'utf8'));
ok(World.resolveStage('stage_01_002_01') === 'stage_01_002_01', 'stage id resolves');
ok(World.resolveStage('隠れ家前') === 'stage_01_002_01', 'ja stage name resolves');
ok(World.resolveStage('ライザの家') === 'stage_01_001_04', 'home ja name resolves');
ok(World.resolveStage('塔奥家门前') === 'stage_01_002_01', 'zh official name resolves');
ok(World.resolveStage('莱莎家') === 'stage_01_001_04', 'zh home name resolves');
ok(World.locked('area_05') === true, 'capital locked before sail');
Game.s.sailed = true;
ok(World.locked('area_05') === false, 'capital open after sail');
Game.s.sailed = false;
const pb = World.promptBlock({ stage: 'stage_01_001_04', tod: 'aft', day: 1 });
ok(/stage_01_001_04/.test(pb) && /ライザの家/.test(pb), 'prompt names current place');
ok(World.resolveStage('塔奥家') === 'stage_01_002_01', 'short zh alias 塔奥家');
ok(World.resolveStage('回家') === 'stage_01_001_04', 'colloquial 回家 → home');
ok(/塔奥家门前/.test(pb) && /隠れ家前/.test(pb), 'catalog lists ja + zh names');
ok(!World.llmDrivesClock(), 'default real: LLM does not drive the clock');
ok(!/<state>/.test(pb), 'place catalog is facts, not a second protocol');
Config.set('app.timeMode', 'flow');
ok(World.llmDrivesClock(), 'flow: LLM drives the clock');
const pbFlow = World.promptBlock({ stage: 'stage_01_001_04', tod: 'aft', day: 1 });
ok(/時間帯/.test(pbFlow) && !/time_advance/.test(pbFlow),
   'flow catalog stays facts; clock write is in the tag line');
Config.set('app.timeMode', 'real');
ok(/ライザの家/.test(World.promptBlock({ stage: 'stage_01_001_04', tod: 'aft', day: 1 })),
   'reset to real after flow catalog check');
const asmrSys = Api.buildSystemPrompt('asmr', 'voice', '', 'zh', '', pb);
const asmrTag = (asmrSys.match(/^\[emotion:.+\]$/m) || [''])[0];
ok(/\|undress:off\|/.test(asmrTag) && /stage:stage_01_001_04/.test(asmrTag) &&
   !/stamina_delta/.test(asmrSys),
   'asmr gets a filled travel prefix without RPG <state>');
ok(asmrTag.indexOf('tod:') === -1, 'real mode has no tod slot');
ok(/sleep/.test(asmrSys), 'tag line teaches stage:sleep');
Config.set('app.timeMode', 'flow');
const flowSys2 = Api.buildSystemPrompt('chat', 'voice', '', 'ja', '', pbFlow);
const flowTag = (flowSys2.match(/^\[emotion:.+\]$/m) || [''])[0];
ok(/\|tod:aft\]/.test(flowTag), 'flow tag line includes current tod');
Config.set('app.timeMode', 'real');
const rpgBlk = [Game.promptBlock(), Quests.promptBlock()].join('\n\n');
const chatSys = Api.buildSystemPrompt('chat', 'voice', rpgBlk, 'ja', '', pb);
ok(/<state>\{/.test(chatSys) && /stamina_delta/.test(chatSys) &&
   /inventory_added/.test(chatSys),
   'chat RPG prompt teaches trailing <state> for bags/exp/quest');
const slept = Api.parseTaggedReply(
  '[emotion:cuddle|attitude:agree]\nおやすみ<state>{"sleep":true}</state>');
ok(slept.state && slept.state.sleep === true, 'sleep flag parses');
ok(!/stage_05_/.test(pb), 'locked areas omitted from catalog');
const moved = Api.parseTaggedReply(
  '[emotion:happy|attitude:agree]\n行こっ！' +
  '<state>{"current_stage":"stage_01_002_01","tod":"eve"}</state>');
ok(moved.state.current_stage === 'stage_01_002_01' && moved.state.tod === 'eve',
   'current_stage + tod parse');
ok(moved.text.indexOf('<state>') === -1, 'map-move state stripped from speech');

console.log('# time passage (real / flow / manual)');
/* hourToTod bands match the alarm voice table */
ok(World.hourToTod(3) === 'ngt' && World.hourToTod(7) === 'mor' &&
   World.hourToTod(13) === 'aft' && World.hourToTod(18) === 'eve' &&
   World.hourToTod(22) === 'ngt', 'hourToTod bands');
ok(World.hourToTod(-2) === 'ngt' && World.hourToTod(26) === 'ngt',
   'hourToTod wraps out-of-range hours (26→02, -2→22, both night)');
ok(World.todStartHour('mor') === 6 && World.hourToTod(World.todStartHour('eve')) === 'eve',
   'todStartHour snaps back to its own band');
/* flow clock: speed = in-game minutes per real minute */
var at = 1000000;
ok(World.flowHour(10, at, at + 60000, 60) === 11,
   'flow: 60 game-min/real-min advances one hour per real minute');
ok(World.flowHour(23, at, at + 600000, 60) === 9,
   'flow: wraps past midnight (23 + 10 real min @60 = +10h = 09)');
ok(World.flowHour(12, 0, 999999, 60) === 12,
   'flow: unsynced clock (at=0) is a no-op, never a time jump');
ok(World.flowHour(12, at, at, 60) === 12, 'flow: zero elapsed = no advance');
/* LLM time_advance / game_hour parse through the state protocol */
const adv = Api.parseTaggedReply('おやすみ<state>{"time_advance":3}</state>');
ok(adv.state && Number(adv.state.time_advance) === 3, 'LLM time_advance parses');
ok(adv.emotion == null, 'untagged reply does not default emotion to neutral');

console.log(failures ? '\n' + failures + ' FAILURES' : '\nALL PASS');
process.exit(failures ? 1 : 0);
