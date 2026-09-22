/* 服装导入回归（crfstore.js）。
 *
 * 为什么要有它
 * ------------
 * 导入会碰玩家的文件，校验错了就是「装了个坏包之后人物消失」。这里用
 * **官方皮肤的真实文件**造 ZIP，跑通「解析 → 校验 → 拒绝坏包」的每一条规则，
 * 再断言坏包全部被挡住。规则照 AgentAtelierR 的本地皮肤导入清单。
 *
 * 用法: node scripts/crf_import_regression.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const SKIN = path.join(ROOT, 'web/assets/spine/crf_chr_002/crf_skn_002_0001_99');
const JS = path.join(ROOT, 'web/js');

let fail = 0;
function ok(cond, name) { if (cond) console.log('  PASS ' + name); else { fail++; console.log('  FAIL ' + name); } }
function eq(a, b, name) { ok(a === b, name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
function throws(fn, code, name) {
  try { fn(); ok(false, name + '（本该抛错却通过了）'); }
  catch (e) { ok(e.code === code, name + ' → ' + (e.code || '(no code)') + ': ' + e.message); }
}

/* ------------------------------------------------------------- sandbox */
const sandbox = {
  console, Promise, Uint8Array, Uint32Array, ArrayBuffer, DataView, TextDecoder, TextEncoder,
  Blob: class { constructor(parts) { this._p = parts; } },
  Response: class { constructor(s) { this._s = s; } arrayBuffer() { return this._s; } },
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  localStorage: (() => { const s = {}; return {
    getItem: k => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); },
    removeItem: k => { delete s[k]; } }; })(),
  indexedDB: undefined,  /* 只在纯校验路径上测；存储路径由 UI 端到端验证 */
  setTimeout, clearTimeout, Math, JSON, String, Number, RegExp, Date, Object, Array, Error, isFinite
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.DecompressionStream = class {
  constructor(fmt) { this.fmt = fmt; }
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(JS, 'crfstore.js'), 'utf8'), sandbox, { filename: 'crfstore.js' });
const CrfStore = sandbox.CrfStore;

/* ---------------------------------------------------- 造一个真 ZIP（store 法）
   不引依赖：自己写最小的 ZIP（method 0，无压缩），中央目录 + 本地头。 */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(files) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const name of Object.keys(files)) {
    const data = files[name];
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);      /* version */
    local.writeUInt16LE(0, 6);       /* flags */
    local.writeUInt16LE(0, 8);       /* method 0 = stored */
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, nameBuf, data);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt16LE(0, 8);
    cd.writeUInt16LE(0, 10);         /* method */
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([cd, nameBuf]));
    offset += local.length + nameBuf.length + data.length;
  }
  const cdBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(files).length, 8);
  eocd.writeUInt16LE(Object.keys(files).length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  const out = Buffer.concat([Buffer.concat(chunks), cdBuf, eocd]);
  return out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength);
}

/* ------------------------------------------------------------- 素材 */
const base = 'crf_skn_002_0001_99';
const files = {};
for (const ext of ['atlas', 'png', 'skel']) {
  files[base + '.' + ext] = new Uint8Array(fs.readFileSync(path.join(SKIN, base + '.' + ext)));
}
files[base + '_gesture.json'] = new Uint8Array(fs.readFileSync(path.join(SKIN, base + '_gesture.json')));

console.log('# 1. 正常包：解析 + 校验通过');
{
  const buf = zip(files);
  const z = CrfStore.parseZip(buf);
  eq(z.entries.length, 4, '解析出 4 个条目');
  const picked = {};
  z.entries.forEach(e => { picked[e.name.split('/').pop()] = e.size; });
  eq(picked[base + '.png'], files[base + '.png'].length, '条目大小正确');
  const v = CrfStore.validate(files);
  eq(v.id, base, 'id 取自文件名前缀');
  eq(v.base, base, 'base 正确');
  ok(!!v.gesture.emotionalGesture, '动作表被解析');
}

console.log('\n# 2. ZIP 结构校验');
{
  throws(() => CrfStore.parseZip(new ArrayBuffer(64)), 'CRF_BAD_ZIP', '非 ZIP 被拒');
  const many = {};
  for (let i = 0; i < 70; i++) many['f' + i + '.png'] = new Uint8Array(8);
  many[base + '.atlas'] = files[base + '.atlas'];
  throws(() => CrfStore.parseZip(zip(many)), 'CRF_TOO_MANY', '条目超过 64 被拒');
}

console.log('\n# 3. 内容校验（逐条对应 AgentAtelierR 的规则）');
{
  throws(() => CrfStore.validate({}), 'CRF_NEED_ONE_ATLAS', '没有 atlas 被拒');
  throws(() => CrfStore.validate({ 'a.atlas': new Uint8Array(1), 'b.atlas': new Uint8Array(1) }),
    'CRF_NEED_ONE_ATLAS', '两个 atlas（多页）被拒');

  const noPng = Object.assign({}, files);
  delete noPng[base + '.png'];
  throws(() => CrfStore.validate(noPng), 'CRF_MISSING_FILE', '缺贴图被拒');

  const noSkel = Object.assign({}, files);
  delete noSkel[base + '.skel'];
  throws(() => CrfStore.validate(noSkel), 'CRF_MISSING_FILE', '缺骨架被拒');

  const noGesture = Object.assign({}, files);
  delete noGesture[base + '_gesture.json'];
  throws(() => CrfStore.validate(noGesture), 'CRF_MISSING_FILE', '缺动作表被拒');

  const badAtlasName = Object.assign({}, files);
  badAtlasName[base + '.atlas'] = new TextEncoder().encode(
    files[base + '.atlas'] ? new TextDecoder().decode(files[base + '.atlas']).replace(base + '.png', 'other.png') : '');
  throws(() => CrfStore.validate(badAtlasName), 'CRF_ATLAS_NAME', '图集贴图名不匹配被拒');

  const badPng = Object.assign({}, files);
  badPng[base + '.png'] = new Uint8Array(32);   /* 不是 PNG */
  throws(() => CrfStore.validate(badPng), 'CRF_BAD_PNG', '贴图不是 PNG 被拒');

  const badSkel = Object.assign({}, files);
  const sk = new Uint8Array(files[base + '.skel']);
  sk[8] = 4; sk[9] = '3'.charCodeAt(0);         /* 改成 3.8.x */
  badSkel[base + '.skel'] = sk;
  throws(() => CrfStore.validate(badSkel), 'CRF_NOT_42', '非 4.2 骨架被拒');

  const badGesture = Object.assign({}, files);
  badGesture[base + '_gesture.json'] = new TextEncoder().encode('{}');
  throws(() => CrfStore.validate(badGesture), 'CRF_NO_EMOTIONAL', '动作表结构不对被拒');

  /* PNG 尺寸必须与图集声明一致：把图集 size 改掉 */
  const atlasText = new TextDecoder().decode(files[base + '.atlas']);
  const wrongSize = atlasText.replace(/^size:\s*\d+\s*,\s*\d+/m, 'size: 99,99');
  const badSize = Object.assign({}, files);
  badSize[base + '.atlas'] = new TextEncoder().encode(wrongSize);
  throws(() => CrfStore.validate(badSize), 'CRF_SIZE_MISMATCH', 'PNG 尺寸与图集不一致被拒');
}

console.log('\n# 4. 路径安全');
{
  eq(CrfStore.safeName('sub/dir/x.png'), 'x.png', '子目录只取文件名');
  throws(() => CrfStore.safeName('/abs/x.png'), 'CRF_ABS_PATH', '绝对路径被拒');
  throws(() => CrfStore.safeName('C:/x.png'), 'CRF_ABS_PATH', '盘符路径被拒');
  throws(() => CrfStore.safeName('a/../../x.png'), 'CRF_DOTDOT', '.. 路径被拒');
}

console.log('\n# 5. 骨架版本判定（正例）');
{
  ok(CrfStore.skeletonVersionOk(files[base + '.skel']), '官方骨架被判定为 4.2');
  const other = new Uint8Array(fs.readFileSync(
    path.join(ROOT, 'web/assets/spine/crf_chr_002/crf_skn_002_0001_01/crf_skn_002_0001_01.skel')));
  ok(CrfStore.skeletonVersionOk(other), '另一套官方骨架也通过');
}

/* 6. 宿主侧的选文件能力。导入是靠 <input type=file>，而 WebView 自己不会
   开选文件器：宿主不实现 onShowFileChooser 的话，点「导入服装」就是个静默
    空操作（2026-09 的安卓报告）。这里钉住的是「安卓壳必须实现它」，
   并确认用的是 SAF（不需要存储权限）——同一条能力在 Electron 里由 Chromium
   自带，所以只有安卓需要守。 */
console.log('\n# 6. 安卓宿主的文件选择');
{
  const java = fs.readFileSync(path.join(
    ROOT, 'android/app/src/main/java/com/ryza/chat/MainActivity.java'), 'utf8');
  const manifest = fs.readFileSync(path.join(
    ROOT, 'android/app/src/main/AndroidManifest.xml'), 'utf8');
  ok(/onShowFileChooser\s*\(/.test(java),
     'MainActivity 实现了 onShowFileChooser（否则 <input type=file> 无声失败）');
  ok(/parseResult\s*\(/.test(java) && /onActivityResult\s*\(/.test(java),
     '选完文件把结果交回页面（parseResult）');
  ok(/ACTION_GET_CONTENT/.test(java) && /CATEGORY_OPENABLE/.test(java),
     '用 SAF 的 ACTION_GET_CONTENT/OPENABLE：单次授权，不需要存储权限');
  ok(/EXTRA_MIME_TYPES/.test(java) && /getMimeTypeFromExtension/.test(java),
     'accept=".zip" 要翻成 application/zip——直接把 ".zip" 当 type 会出空列表');
  ok(!/READ_EXTERNAL_STORAGE|READ_MEDIA_|MANAGE_EXTERNAL_STORAGE/.test(manifest),
     'manifest 不申请存储权限（SAF 不需要，用户看到的权限仍只有录音）');
  ok(/setAllowContentAccess\(true\)/.test(java),
     'WebView 允许读 content:// （选文件器给的就是这个）');
}

console.log('\n' + (fail === 0 ? 'ALL PASS' : 'FAILED ' + fail));
process.exit(fail === 0 ? 0 : 1);
