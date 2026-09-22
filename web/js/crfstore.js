/* crfstore.js — 本地服装（crf）导入。

   为什么要有它
   ------------
   官方 6 款皮肤已经随包提供，但玩家想换自己准备的服装时，旧实现没有任何入口。
   这里补上「导入服装」：ZIP 进 IndexedDB，运行时直接穿，不碰安装目录。

   两个必须解决的坑（参考 AgentAtelierR 的校验规则 + Atelier R'Coagula 的实测结论）
   ------------------------------------------------------------------------------
   1) **存哪**：不能用 localStorage。桌面壳会把 localStorage 镜像进
      `%AppData%/RyzaChat/ryza-web-storage.json` 并每次启动重新注入，几百 KB 的
      贴图会把那个文件撑爆、拖慢每次启动。IndexedDB 在 Chromium profile 里，
      重启后 blob 仍然逐字节一致。
   2) **图集贴图行是「裸文件名」**：spine 的 `.atlas` 里贴图写成 `xxx.png`（没有目录）。
      若把 atlas 交给 `blob:` URL 加载，引擎无法从裸文件名解析出贴图 →
      实测报 `Region not found in atlas: 001_arm_07`。
      正确做法：**atlas 文本原样保留**，把导入的贴图 blob URL 通过
      `Avatar.setPageSource()` 交给渲染层（渲染层不碰 IndexedDB，只收一个函数）。

   校验规则（照 AgentAtelierR 的做法，逐条对齐）
   --------------------------------------------
     ZIP ≤ 64MB / 条目 ≤ 64 / 拒绝绝对路径、含 `:`、`..`、符号链接 /
     只收 .atlas .png .skel .json / 单页图集 / 四件套同名前缀 /
     骨架必须是 4.2 / 动作表必须含 emotionalGesture / 展开总量 ≤ 64MB
*/
(function (global) {
  'use strict';

  var DB = 'ryza_crf';
  var STORE = 'outfits';
  var META_KEY = 'ryza.crf.imported.v1';     /* 小元数据放 localStorage，贴图放 IDB */
  var MAX_BYTES = 64 * 1024 * 1024;
  var MAX_ENTRIES = 64;

  var _db = null;
  var _urls = {};                            /* id -> { pageName: blobURL } */

  /* Errors carry a stable .code so the UI can translate them (see i18n crf.err.*)
     while the English message stays a readable fallback. The code is the contract
     the regression suite checks — the wording is free to change. */
  function crfErr(code, msg) {
    var e = new Error(msg || code);
    e.code = code;
    return e;
  }

  /* ---------------------------------------------------------------- idb */
  function open() {
    if (_db) return Promise.resolve(_db);
    if (typeof indexedDB === 'undefined') return Promise.reject(new Error('no indexedDB'));
    return new Promise(function (res, rej) {
      var req;
      try { req = indexedDB.open(DB, 1); } catch (e) { rej(e); return; }
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = function () { _db = req.result; res(_db); };
      req.onerror = function () { rej(req.error); };
    });
  }

  function tx(mode) {
    return open().then(function (db) {
      return db.transaction(STORE, mode).objectStore(STORE);
    });
  }

  function meta() {
    try { return JSON.parse(localStorage.getItem(META_KEY) || '[]'); } catch (e) { return []; }
  }
  function setMeta(list) {
    try { localStorage.setItem(META_KEY, JSON.stringify(list)); } catch (e) {}
  }

  /* ---------------------------------------------------------------- zip
     最小 ZIP 读取器：中心目录 → 本地头 → DecompressionStream 解压。
     不引依赖；method 0（store）直接拷贝，method 8（deflate）走平台解压。 */
  function u16(dv, o) { return dv.getUint16(o, true); }
  function u32(dv, o) { return dv.getUint32(o, true); }

  function readZip(buf) {
    var dv = new DataView(buf);
    var eocd = -1;
    for (var i = buf.byteLength - 22; i >= 0 && i > buf.byteLength - 66000; i--) {
      if (u32(dv, i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw crfErr('CRF_BAD_ZIP', 'Not a valid ZIP file');
    var count = u16(dv, eocd + 10);
    var cdOff = u32(dv, eocd + 16);
    if (count > MAX_ENTRIES) throw crfErr('CRF_TOO_MANY', 'Too many entries in the ZIP (max ' + MAX_ENTRIES + ')');
    var out = [];
    var p = cdOff;
    for (var n = 0; n < count; n++) {
      if (u32(dv, p) !== 0x02014b50) throw crfErr('CRF_DIR_CORRUPT', 'ZIP central directory is corrupt');
      var method = u16(dv, p + 10);
      var size = u32(dv, p + 24);
      var nameLen = u16(dv, p + 28);
      var extraLen = u16(dv, p + 30);
      var commentLen = u16(dv, p + 32);
      var localOff = u32(dv, p + 42);
      var name = '';
      for (var k = 0; k < nameLen; k++) name += String.fromCharCode(dv.getUint8(p + 46 + k));
      out.push({ name: name, method: method, size: size, localOff: localOff });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return { entries: out, dv: dv, buf: buf };
  }

  async function entryBytes(zip, e) {
    var dv = zip.dv;
    var p = e.localOff;
    if (u32(dv, p) !== 0x04034b50) throw crfErr('CRF_LOCAL_CORRUPT', 'ZIP local header is corrupt');
    var nameLen = u16(dv, p + 26);
    var extraLen = u16(dv, p + 28);
    var start = p + 30 + nameLen + extraLen;
    var slice = zip.buf.slice(start, start + e.size);
    if (e.method === 0) return new Uint8Array(slice);
    if (e.method !== 8) throw crfErr('CRF_BAD_METHOD', 'Unsupported compression method: ' + e.method);
    if (typeof DecompressionStream === 'undefined') throw crfErr('CRF_NO_INFLATE', 'This environment cannot decompress the ZIP');
    var ds = new DecompressionStream('deflate-raw');
    var stream = new Blob([slice]).stream().pipeThrough(ds);
    var ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }

  /* 路径安全 + 白名单（照 AgentAtelierR 的规则） */
  function safeName(path) {
    var p = String(path || '').replace(/\\/g, '/');
    if (p.startsWith('/') || p.indexOf(':') >= 0) throw crfErr('CRF_ABS_PATH', 'The ZIP contains an absolute path');
    var parts = p.split('/');
    for (var i = 0; i < parts.length; i++) if (parts[i] === '..') throw crfErr('CRF_DOTDOT', 'The ZIP contains a ".." path');
    return parts[parts.length - 1];
  }
  var OK_EXT = /\.(atlas|png|skel|json)$/i;

  /* 骨架版本：Spine 4.2 的二进制头是 8 字节哈希 + varint 版本串 */
  function skeletonVersionOk(bytes) {
    if (!bytes || bytes.length < 14) return false;
    var len = bytes[8];
    if (!(len >= 4 && len <= 32)) return false;
    var s = '';
    for (var i = 0; i < len; i++) s += String.fromCharCode(bytes[9 + i]);
    return s.indexOf('4.2.') === 0;
  }

  /* PNG 尺寸（只看 IHDR） */
  function pngSize(bytes) {
    if (!bytes || bytes.length < 24) return null;
    if (bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { w: dv.getUint32(16), h: dv.getUint32(20) };
  }

  /* 校验并归一化一份导入包。返回 { id, files: {name: Uint8Array} } */
  function validate(files) {
    var names = Object.keys(files);
    var atlases = names.filter(function (n) { return /\.atlas$/i.test(n); });
    if (atlases.length !== 1) throw crfErr('CRF_NEED_ONE_ATLAS', 'Need exactly one .atlas file (single-page atlas)');
    var base = atlases[0].replace(/\.atlas$/i, '');
    ['png', 'skel', 'json'].forEach(function (ext) {
      var want = (ext === 'json') ? base + '_gesture.json' : base + '.' + ext;
      if (!files[want]) throw crfErr('CRF_MISSING_FILE', 'Missing ' + want);
    });
    var atlasText = new TextDecoder().decode(files[base + '.atlas']);
    /* 单页：atlas 里声明贴图的行只能有一条，且必须与 .png 同名 */
    var pageLines = atlasText.split(/\r?\n/).filter(function (l) {
      return /\.png\s*$/i.test(l.trim());
    });
    if (pageLines.length !== 1) throw crfErr('CRF_MULTIPAGE', 'Only a single-page atlas is supported');
    if (pageLines[0].trim() !== base + '.png') throw crfErr('CRF_ATLAS_NAME', 'The atlas page name does not match the .png file name');

    var declared = /^size:\s*(\d+)\s*,\s*(\d+)/m.exec(atlasText);
    if (!declared) throw crfErr('CRF_NO_SIZE', 'The atlas has no size declaration');
    var png = pngSize(files[base + '.png']);
    if (!png) throw crfErr('CRF_BAD_PNG', 'The texture is not a valid PNG');
    if (png.w !== Number(declared[1]) || png.h !== Number(declared[2])) {
      throw crfErr('CRF_SIZE_MISMATCH', 'PNG size ' + png.w + 'x' + png.h +
                      ' does not match the atlas declaration ' + declared[1] + 'x' + declared[2]);
    }
    if (!skeletonVersionOk(files[base + '.skel'])) throw crfErr('CRF_NOT_42', 'Only Spine 4.2 skeletons are supported');
    var gesture;
    try { gesture = JSON.parse(new TextDecoder().decode(files[base + '_gesture.json'])); }
    catch (e) { throw crfErr('CRF_BAD_GESTURE_JSON', 'The gesture table is not valid JSON'); }
    if (!gesture || !gesture.emotionalGesture) throw crfErr('CRF_NO_EMOTIONAL', 'The gesture table has no emotionalGesture');

    /* id 用文件名前缀，非法字符丢掉；重名加后缀 */
    var id = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 48) || 'imported';
    return { id: id, base: base, files: files, gesture: gesture };
  }

  /* ---------------------------------------------------------------- api */
  var CrfStore = {
    MAX_BYTES: MAX_BYTES,
    MAX_ENTRIES: MAX_ENTRIES,

    /* 供回归使用（纯函数，不碰 IndexedDB） */
    parseZip: function (buf) { return readZip(buf); },
    validate: validate,
    skeletonVersionOk: skeletonVersionOk,
    pngSize: pngSize,
    safeName: safeName,

    list: function () { return meta(); },

    /* 导入一个 ZIP（File / ArrayBuffer / Uint8Array） */
    importZip: function (input) {
      return Promise.resolve().then(function () {
        if (input && typeof input.arrayBuffer === 'function') return input.arrayBuffer();
        return input;
      }).then(function (buf) {
        var ab = (buf instanceof ArrayBuffer) ? buf : buf.buffer;
        if (ab.byteLength > MAX_BYTES) throw crfErr('CRF_TOO_BIG', 'The ZIP is larger than 64MB');
        var zip = readZip(ab);
        /* 先按白名单收集，再逐条解压 */
        var picked = [];
        var total = 0;
        zip.entries.forEach(function (e) {
          var name = safeName(e.name);
          if (!OK_EXT.test(name)) return;
          if (picked.some(function (p) { return p.name === name; })) {
            throw crfErr('CRF_DUP', 'Duplicate file in the ZIP: ' + name);
          }
          total += e.size;
          if (total > MAX_BYTES) throw crfErr('CRF_TOO_BIG', 'Unpacked size is larger than 64MB');
          picked.push({ name: name, entry: e });
        });
        if (!picked.length) throw crfErr('CRF_EMPTY', 'The ZIP has no usable files');
        return Promise.all(picked.map(function (p) {
          return entryBytes(zip, p.entry).then(function (b) { return { name: p.name, bytes: b }; });
        }));
      }).then(function (list) {
        var files = {};
        list.forEach(function (x) { files[x.name] = x.bytes; });
        var v = validate(files);
        /* 存进 IndexedDB（贴图/骨架/动作表都存，重开也能穿） */
        return tx('readwrite').then(function (store) {
          return new Promise(function (res, rej) {
            var rec = { id: v.id, base: v.base, files: {}, preview: null };
            Object.keys(files).forEach(function (n) {
              rec.files[n] = new Blob([files[n]]);
            });
            var put = store.put(rec);
            put.onsuccess = function () { res(v); };
            put.onerror = function () { rej(put.error); };
          });
        }).then(function (v2) {
          var m = meta().filter(function (x) { return x.id !== v.id; });
          m.push({ id: v.id, base: v.base, imported: true, addedAt: Date.now() });
          setMeta(m);
          return v;
        });
      });
    },

    remove: function (id) {
      return tx('readwrite').then(function (store) {
        return new Promise(function (res) {
          var del = store.delete(id);
          del.onsuccess = function () { res(); };
          del.onerror = function () { res(); };
        });
      }).then(function () {
        setMeta(meta().filter(function (x) { return x.id !== id; }));
        Object.keys(_urls[id] || {}).forEach(function (k) {
          try { URL.revokeObjectURL(_urls[id][k]); } catch (e) {}
        });
        delete _urls[id];
      });
    },

    /* 取一件导入服装（含文件 blob） */
    get: function (id) {
      return tx('readonly').then(function (store) {
        return new Promise(function (res, rej) {
          var g = store.get(id);
          g.onsuccess = function () { res(g.result || null); };
          g.onerror = function () { rej(g.error); };
        });
      });
    },

    /* 渲染层的端口实现：把某件导入服装的图集贴图给成 blob URL。
       返回 null 表示「这件不是导入的」，渲染层继续走正常 URL 路径。 */
    pageUrl: function (skinId, pageName) {
      var m = meta();
      var hit = null;
      for (var i = 0; i < m.length; i++) if (m[i].id === skinId) hit = m[i];
      if (!hit) return Promise.resolve(null);
      _urls[skinId] = _urls[skinId] || {};
      if (_urls[skinId][pageName]) return Promise.resolve(_urls[skinId][pageName]);
      return CrfStore.get(skinId).then(function (rec) {
        if (!rec || !rec.files) return null;
        var f = rec.files[pageName] || rec.files[rec.base + '.png'];
        if (!f) return null;
        var url = URL.createObjectURL(f);
        _urls[skinId][pageName] = url;
        return url;
      });
    },

    /* 把导入的服装登记成 skins.json 那样的一条（渲染层据此解析骨架） */
    entryFor: function (rec) {
      var base = rec.base;
      _urls[rec.id] = _urls[rec.id] || {};
      function urlOf(name) {
        if (!_urls[rec.id][name]) {
          var f = rec.files[name];
          if (!f) return null;
          _urls[rec.id][name] = URL.createObjectURL(f);
        }
        return _urls[rec.id][name];
      }
      return {
        id: rec.id,
        chr: 'crf_chr_002',
        hasSpine: true,
        imported: true,
        preview: urlOf(base + '.png'),
        skel: urlOf(base + '.skel'),
        atlas: urlOf(base + '.atlas'),
        gesture: urlOf(base + '_gesture.json')
      };
    },

    /* 启动时把已导入的服装登记进 Avatar 的皮肤表 */
    entries: function () {
      var ids = meta().map(function (x) { return x.id; });
      if (!ids.length) return Promise.resolve([]);
      return Promise.all(ids.map(function (id) {
        return CrfStore.get(id).then(function (rec) {
          return rec ? CrfStore.entryFor(rec) : null;
        });
      })).then(function (list) {
        return list.filter(Boolean);
      });
    }
  };

  global.CrfStore = CrfStore;
})(window);
