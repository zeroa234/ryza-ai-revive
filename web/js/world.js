/* World map / RPG layer.

   Layout: world_hierarchy.json (5 areas -> 38 fields -> 120 stages).
   Presence: npc_placement.json — bases(%) + move%(area/field/stage) + companions(%).
   Resolved in resolveOrder, deterministic per (npc, day). */
(function (global) {
  'use strict';

  var TODS = ['mor', 'aft', 'eve', 'ngt'];
  var PIN = {
    area: 'assets/world_map/ui/area_pin.svg',
    field: 'assets/world_map/ui/field_pin.svg',
    fieldOff: 'assets/world_map/ui/field_pin_inactive.svg',
    ring: 'assets/world_map/ui/field_pin_ring.svg',
    here: 'assets/world_map/ui/current_location.svg',
    char: 'assets/world_map/ui/char_pin.svg'
  };

  var World = {
    hierarchy: null,
    npcs: null,
    stageMap: null,
    scenes: null,
    _placeCache: {},
    mapLevel: 'areas',
    mapAreaId: null,
    mapFieldId: null,

    init: function () {
      return Promise.all([
        fetch('assets/_index/world_hierarchy.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/npc_placement.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/stage_background_map.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/scenes.json').then(function (r) { return r.json(); })
      ]).then(function (res) {
        World.hierarchy = res[0];
        World.npcs = res[1];
        World.stageMap = res[2];
        World.scenes = res[3];
        return World;
      });
    },

    areas: function () { return (World.hierarchy && World.hierarchy.areas) || []; },

    fields: function (areaId) {
      var a = World.areas().filter(function (x) { return x.id === areaId; })[0];
      return a ? a.fields : [];
    },

    findField: function (fieldId) {
      var out = null;
      World.areas().forEach(function (a) {
        a.fields.forEach(function (f) {
          if (f.id === fieldId) out = { area: a, field: f };
        });
      });
      return out;
    },

    allStages: function () {
      var out = [];
      World.areas().forEach(function (a) {
        a.fields.forEach(function (f) {
          f.stages.forEach(function (s) {
            out.push({
              area: a.name, areaId: a.id, field: f.name, fieldId: f.id,
              stage: s.name, stageId: s.id
            });
          });
        });
      });
      return out;
    },

    find: function (stageId) {
      return World.allStages().filter(function (s) { return s.stageId === stageId; })[0] || null;
    },

    areaOf: function (stageId) {
      var s = World.find(stageId);
      return s ? s.areaId : null;
    },

    stagesInField: function (fieldId) {
      var hit = World.findField(fieldId);
      return hit ? hit.field.stages.slice() : [];
    },

    backgroundFor: function (stageId) {
      return World.stageMap ? (World.stageMap[stageId] || stageId) : stageId;
    },

    todLabel: function (tod) { return I18n.t('tod.' + tod); },

    nextTod: function (tod) {
      return TODS[(TODS.indexOf(tod) + 1) % TODS.length];
    },

    /* ---------------------------------------------------------- time-of-day
       Bands match the alarm voice table (alarm.js todForHour) so the scene,
       the greeting voice and the light all agree on when 朝/昼/夕/夜 start. */
    hourToTod: function (h) {
      h = ((Number(h) % 24) + 24) % 24;
      if (h < 5) return 'ngt';
      if (h < 11) return 'mor';
      if (h < 17) return 'aft';
      if (h < 20) return 'eve';
      return 'ngt';
    },
    /* Official AppServerClock: scene.time_bucket is a FACT pushed TO marionette,
       never a command FROM it. Only the local 'flow' clock lets the LLM dial time. */
    llmDrivesClock: function () {
      try {
        return !!(global.Config && Config.section('app').timeMode === 'flow');
      } catch (e) { return false; }
    },
    /* representative hour at the start of a band — used when the LLM or the
       manual button SETS a band in flow mode and the game clock must snap */
    todStartHour: function (tod) {
      return { mor: 6, aft: 12, eve: 17, ngt: 21 }[tod] != null
        ? { mor: 6, aft: 12, eve: 17, ngt: 21 }[tod] : 12;
    },
    /* pure flow-clock advance: gameHour after `speed` in-game minutes pass per
       real minute, measured from gameClockAt to nowMs. speed=60 ⇒ 1 real min =
       1 game hour (a full in-game day every 24 real minutes). */
    flowHour: function (gameHour, gameClockAt, nowMs, speed) {
      var h = Number(gameHour);
      if (!(h >= 0 && h < 24)) h = 12;
      var at = Number(gameClockAt);
      if (!(at > 0)) return h;
      var realMin = Math.max(0, (Number(nowMs) - at) / 60000);
      var sp = Number(speed); if (!(sp > 0)) sp = 60;
      h = h + realMin * sp / 60;
      return ((h % 24) + 24) % 24;
    },

    /* ------------------------------------------------------------- RNG */
    _hash: function (str) {
      var h = 2166136261, i;
      for (i = 0; i < str.length; i++) {
        h ^= str.charCodeAt(i);
        h = (h * 16777619) >>> 0;
      }
      return (h % 10000) / 100;
    },

    _pick: function (arr, seed) {
      if (!arr || !arr.length) return null;
      var i = Math.floor(World._hash(seed) / 100 * arr.length) % arr.length;
      return arr[i];
    },

    _weightedBase: function (bases, seed) {
      var total = 0, i, r, acc = 0;
      for (i = 0; i < bases.length; i++) total += Number(bases[i].pct) || 0;
      if (total <= 0) return bases[0];
      r = World._hash(seed);
      for (i = 0; i < bases.length; i++) {
        acc += (Number(bases[i].pct) || 0) * (100 / total);
        if (r < acc) return bases[i];
      }
      return bases[bases.length - 1];
    },

    _stageFromBase: function (base, npcId, day) {
      if (base.stageId) return base.stageId;
      if (base.fieldId) {
        var sts = World.stagesInField(base.fieldId);
        var s = World._pick(sts, 'base|' + npcId + '|' + day + '|' + base.fieldId);
        return s ? s.id : null;
      }
      return null;
    },

    /* bases → home, then mutually exclusive area/field/stage drift. */
    _drift: function (homeId, move, npcId, day) {
      var home = World.find(homeId);
      if (!home) return homeId;
      var area = Number(move && move.area) || 0;
      var field = Number(move && move.field) || 0;
      var stage = Number(move && move.stage) || 0;
      var r = World._hash('move|' + npcId + '|' + day);
      var others, pick;
      if (r < area) {
        others = World.allStages().filter(function (s) { return s.areaId !== home.areaId; });
        pick = World._pick(others, 'area|' + npcId + '|' + day);
        return pick ? pick.stageId : homeId;
      }
      r -= area;
      if (r < field) {
        others = World.allStages().filter(function (s) {
          return s.areaId === home.areaId && s.fieldId !== home.fieldId;
        });
        pick = World._pick(others, 'field|' + npcId + '|' + day);
        return pick ? pick.stageId : homeId;
      }
      r -= field;
      if (r < stage) {
        others = World.stagesInField(home.fieldId).filter(function (s) { return s.id !== homeId; });
        pick = World._pick(others, 'stage|' + npcId + '|' + day);
        return pick ? pick.id : homeId;
      }
      return homeId;
    },

    /* Map of npcId -> stageId for a given day. */
    placement: function (day) {
      day = day || 1;
      if (World._placeCache[day]) return World._placeCache[day];
      var loc = {};
      var list = ((World.npcs && World.npcs.npcs) || []).slice().sort(function (a, b) {
        return (a.resolveOrder || 0) - (b.resolveOrder || 0);
      });
      list.forEach(function (n) {
        var bases = n.bases || [];
        if (!bases.length) return;
        var home = World._stageFromBase(World._weightedBase(bases, 'home|' + n.id + '|' + day), n.id, day);
        loc[n.id] = World._drift(home, n.move, n.id, day);
      });
      list.forEach(function (n) {
        var order = n.resolveOrder || 0;
        (n.companions || []).forEach(function (c) {
          var roll = World._hash('comp|' + n.id + '|' + c.id + '|' + day);
          var other = list.filter(function (x) { return x.id === c.id; })[0];
          var otherOrder = other ? (other.resolveOrder || 0) : 0;
          if (roll < (c.pct || 0) && loc[n.id] && otherOrder <= order) loc[c.id] = loc[n.id];
        });
      });
      World._placeCache[day] = loc;
      return loc;
    },

    npcsAt: function (stageId, day) {
      var loc = World.placement(day);
      var byId = {};
      ((World.npcs && World.npcs.npcs) || []).forEach(function (n) { byId[n.id] = n; });
      var out = [];
      Object.keys(loc).forEach(function (id) {
        if (loc[id] !== stageId) return;
        var n = byId[id];
        if (n) out.push({ id: n.id, name: World.npcName(n.id), note: n.note || '' });
      });
      return out.sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
    },

    npcsInField: function (fieldId, day) {
      var loc = World.placement(day);
      var byId = {};
      ((World.npcs && World.npcs.npcs) || []).forEach(function (n) { byId[n.id] = n; });
      var seen = {}, out = [];
      Object.keys(loc).forEach(function (id) {
        var info = World.find(loc[id]);
        if (!info || info.fieldId !== fieldId) return;
        if (seen[id]) return;
        seen[id] = true;
        var n = byId[id];
        if (n) out.push({ id: n.id, name: World.npcName(n.id), note: n.note || '', stageId: loc[id], stage: info.stage });
      });
      return out;
    },

    /* area_bottom_sheet.dart needs "who is in this area right now". */
    npcsInArea: function (areaId, day) {
      var out = {};
      World.fields(areaId).forEach(function (f) {
        World.npcsInField(f.id, day).forEach(function (n) {
          if (!out[n.id]) out[n.id] = { id: n.id, name: n.name, note: n.note || '', where: [] };
          out[n.id].where.push(f.name + '（' + n.stage + '）');
        });
      });
      return Object.keys(out).map(function (k) { return out[k]; })
        .sort(function (a, b) { return a.name.localeCompare(b.name, 'ja'); });
    },

    iconFor: function (npcId) {
      var key = npcId.replace(/^npc_/, '');
      var aliases = { empel: 'ampel', klaudia: 'claudia', patricia: 'patrizia' };
      return 'assets/images/chara_icons/' + (aliases[key] || key) + '.png';
    },

    /* display-name localization (ja is the shipped data, i18n CONTENT has
       official-style zh / en names) */
    npcName: function (npcId) {
      var hit = ((World.npcs && World.npcs.npcs) || []).filter(function (n) { return n.id === npcId; })[0];
      var base = hit ? hit.name : npcId;
      if (!window.I18n || !I18n.tc) return base;
      return I18n.tc('npc.' + String(npcId).replace(/^npc_/, ''), base);
    },
    placeLabel: function (id, base) {
      return (window.I18n && I18n.tc) ? I18n.tc('place.' + id, base) : base;
    },

    /* Player/LLM colloquialisms → official stage ids. Keys are _fold()'d.
       Only shortenings of names that exist in the pack (or "go home"). */
    TALK_ALIASES: {
      'home': 'stage_01_001_04',
      'おうち': 'stage_01_001_04',
      'うち': 'stage_01_001_04',
      '回家': 'stage_01_001_04',
      '家里': 'stage_01_001_04',
      '回家睡觉': 'stage_01_001_04',
      '莱莎的家': 'stage_01_001_04',
      'ライザの家': 'stage_01_001_04',
      '塔奥家': 'stage_01_002_01',
      'タオの家': 'stage_01_002_01',
      'tao': 'stage_01_002_01'
    },

    isTod: function (t) { return TODS.indexOf(t) >= 0; },

    _fold: function (s) {
      return String(s || '').toLowerCase().replace(/[\s'"’`・·。，、]/g, '');
    },

    _labels: function (id, base) {
      var out = [], seen = {};
      function add(v) {
        v = String(v || '').trim();
        if (!v || seen[v]) return;
        seen[v] = 1; out.push(v);
      }
      add(base); add(id);
      add(World.placeLabel(id, base));
      if (window.I18n && typeof I18n.all === 'function') {
        I18n.all('place.' + id).forEach(add);
      }
      return out;
    },

    /* Talk-side map move (source: entry_map_move.dart / detectEntryMapMove /
       scene.current_stage). Resolves a stage id, a field/area id, or a
       displayed name in any shipped language. Locked areas still resolve —
       the caller decides whether to refuse. */
    resolveStage: function (token) {
      var q = String(token || '').trim();
      if (!q || !World.hierarchy) return null;
      var alias = World.TALK_ALIASES[World._fold(q)];
      if (alias && World.find(alias)) return alias;
      if (World.find(q)) return q;
      var field = World.findField(q);
      if (field && field.field.stages && field.field.stages[0]) {
        return field.field.stages[0].id;
      }
      var area = World.areas().filter(function (a) { return a.id === q; })[0];
      if (area && area.fields && area.fields[0] && area.fields[0].stages[0]) {
        return area.fields[0].stages[0].id;
      }
      var nq = World._fold(q);
      if (nq.length < 2) return null;
      var best = null, bestScore = 0;
      World.areas().forEach(function (a) {
        a.fields.forEach(function (f) {
          f.stages.forEach(function (s) {
            var labels = World._labels(s.id, s.name)
              .concat(World._labels(f.id, f.name))
              .concat(World._labels(a.id, a.name));
            labels.forEach(function (lab) {
              var nl = World._fold(lab);
              if (!nl) return;
              var score = 0;
              if (nl === nq) score = 3;
              else if (nl.indexOf(nq) >= 0) score = 2;
              else if (nq.indexOf(nl) >= 0 && nl.length >= 4) score = 1;
              if (score > bestScore) { bestScore = score; best = s.id; }
            });
          });
        });
      });
      return best;
    },

    /* Facts only — how to write stage/tod lives once in api.js 出力形式. */
    promptBlock: function (st) {
      st = st || {};
      var here = World.find(st.stage);
      if (!here) return '';
      var L = ['## いまの場所'];
      L.push('- いま：' + World.placeLabel(here.stageId, here.stage) +
             '（' + here.stageId + '）／' +
             World.placeLabel(here.fieldId, here.field) + '／' +
             World.placeLabel(here.areaId, here.area));
      L.push('- 時間帯：' + (st.tod || 'aft') + '（mor=朝 aft=昼 eve=夕 ngt=夜）');
      var sailed = window.Game && Game.s && Game.s.sailed;
      if (!sailed) {
        L.push('- 船ができるまでクーケン島（area_01）以外は行けない。');
      }
      L.push('- 行ける場所（stage 欄用）：');
      World.areas().forEach(function (a) {
        if (World.locked(a.id)) return;
        a.fields.forEach(function (f) {
          var bits = f.stages.map(function (s) {
            var labs = World._labels(s.id, s.name).filter(function (x) {
              return x !== s.id;
            });
            return s.id + ' ' + labs.join('/');
          });
          L.push('  ' + World.placeLabel(f.id, f.name) + '：' + bits.join('；'));
        });
      });
      return L.join('\n');
    },

    /* --------------------------------------------------------- pin map */
    /* Source flow: the world beyond クーケン島 (area_01) opens when the
       ship quest finishes (`sailed` in game.js — entry_map_move.dart). */
    locked: function (areaId) {
      if (!window.Game || !Game.s) return false;
      return !Game.s.sailed && areaId !== 'area_01';
    },

    _pinGrid: function (root, items, currentId, opts) {
      opts = opts || {};
      root.innerHTML = '';
      var grid = document.createElement('div');
      grid.className = 'map-pins';
      items.forEach(function (it, i) {
        var el = document.createElement('button');
        el.type = 'button';
        el.className = 'map-pin' + (it.id === currentId ? ' here' : '') +
          (it.inactive ? ' inactive' : '') + (it.locked ? ' locked' : '');
        var col = (i % 4) + 1;
        var row = Math.floor(i / 4) + 1;
        el.style.gridColumn = String(col);
        el.style.gridRow = String(row);
        var img = document.createElement('img');
        img.className = 'pin-svg';
        img.src = it.pin || PIN.field;
        img.alt = '';
        var cap = document.createElement('span');
        cap.className = 'pin-cap';
        cap.textContent = it.name;
        el.appendChild(img);
        if (it.here) {
          var ring = document.createElement('img');
          ring.className = 'pin-ring';
          ring.src = PIN.ring;
          ring.alt = '';
          el.appendChild(ring);
          var here = document.createElement('img');
          here.className = 'pin-here';
          here.src = PIN.here;
          here.alt = '';
          el.appendChild(here);
        }
        if (it.locked) {
          var lk = document.createElement('img');
          lk.className = 'pin-lock';
          lk.src = 'assets/icons/lock.svg';
          lk.alt = '';
          el.appendChild(lk);
        }
        if (it.faces && it.faces.length) {
          var faces = document.createElement('span');
          faces.className = 'pin-faces';
          it.faces.slice(0, 3).forEach(function (src) {
            var f = document.createElement('img');
            f.src = src;
            f.alt = '';
            faces.appendChild(f);
          });
          el.appendChild(faces);
        }
        el.appendChild(cap);
        el.onclick = function () { opts.onPick && opts.onPick(it); };
        grid.appendChild(el);
      });
      root.appendChild(grid);
    },

    render: function (root, sideRoot, currentStageId, onPick) {
      var here = World.find(currentStageId);
      var day = (Config && Config.section('state').day) || 1;
      if (!World.mapAreaId && here) World.mapAreaId = here.areaId;
      if (!World.mapFieldId && here) World.mapFieldId = here.fieldId;

      var crumbs = document.createElement('div');
      crumbs.className = 'map-crumbs';

      function crumb(label, fn) {
        var b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.onclick = fn;
        crumbs.appendChild(b);
      }

      var body = document.createElement('div');
      body.className = 'map-body';

      if (World.mapLevel === 'areas') {
        crumb(I18n.t('world.areas'));
        World._pinGrid(body, World.areas().map(function (a) {
          var on = here && here.areaId === a.id;
          return {
            id: a.id, name: World.placeLabel(a.id, a.name), pin: PIN.area, here: on,
            locked: World.locked(a.id),
            faces: []
          };
        }), World.mapAreaId, {
          onPick: function (it) {
            if (it.locked) {
              if (window.App) App.toast(I18n.t('world.lockedToast'), true);
              return;
            }
            World.mapLevel = 'fields';
            World.mapAreaId = it.id;
            World.render(root, sideRoot, currentStageId, onPick);
          }
        });
      } else if (World.mapLevel === 'fields') {
        crumb(I18n.t('world.areas'), function () {
          World.mapLevel = 'areas';
          World.render(root, sideRoot, currentStageId, onPick);
        });
        var area = World.areas().filter(function (a) { return a.id === World.mapAreaId; })[0];
        crumb(area ? World.placeLabel(area.id, area.name) : World.mapAreaId);
        World._pinGrid(body, World.fields(World.mapAreaId).map(function (f) {
          var npcs = World.npcsInField(f.id, day);
          return {
            id: f.id, name: World.placeLabel(f.id, f.name),
            pin: (here && here.fieldId === f.id) ? PIN.field : PIN.fieldOff,
            here: here && here.fieldId === f.id,
            faces: npcs.slice(0, 3).map(function (n) { return World.iconFor(n.id); })
          };
        }), World.mapFieldId, {
          onPick: function (it) {
            World.mapLevel = 'stages';
            World.mapFieldId = it.id;
            World.render(root, sideRoot, currentStageId, onPick);
          }
        });
      } else {
        crumb(I18n.t('world.areas'), function () {
          World.mapLevel = 'areas';
          World.render(root, sideRoot, currentStageId, onPick);
        });
        var pack = World.findField(World.mapFieldId);
        if (pack) {
          crumb(World.placeLabel(pack.area.id, pack.area.name), function () {
            World.mapLevel = 'fields';
            World.mapAreaId = pack.area.id;
            World.render(root, sideRoot, currentStageId, onPick);
          });
          crumb(World.placeLabel(pack.field.id, pack.field.name));
        }
        var stages = World.stagesInField(World.mapFieldId);
        World._pinGrid(body, stages.map(function (s) {
          var npcs = World.npcsAt(s.id, day);
          return {
            id: s.id, name: World.placeLabel(s.id, s.name), pin: PIN.field,
            here: s.id === currentStageId,
            faces: npcs.slice(0, 3).map(function (n) { return World.iconFor(n.id); })
          };
        }), currentStageId, {
          onPick: function (it) { onPick && onPick(it.id); }
        });
      }

      root.innerHTML = '';
      root.appendChild(crumbs);
      root.appendChild(body);
      if (sideRoot) World.renderSide(sideRoot, currentStageId);
    },

    renderSide: function (sideRoot, currentStageId) {
      var day = Config.section('state').day || 1;
      var list = World.npcsAt(currentStageId, day);
      sideRoot.innerHTML = '';
      if (!list.length) {
        sideRoot.innerHTML = '<div class="empty">' + I18n.t('world.empty') + '</div>';
        return;
      }
      list.forEach(function (n) {
        var row = document.createElement('div');
        row.className = 'npc-row';
        var img = document.createElement('img');
        img.src = World.iconFor(n.id);
        img.onerror = function () { img.style.visibility = 'hidden'; };
        var pin = document.createElement('img');
        pin.className = 'npc-pin';
        pin.src = PIN.char;
        pin.alt = '';
        var box = document.createElement('div');
        box.innerHTML = '<div class="npc-name"></div><div class="npc-note"></div>';
        box.querySelector('.npc-name').textContent = n.name;
        box.querySelector('.npc-note').textContent = n.note;
        row.appendChild(img);
        row.appendChild(pin);
        row.appendChild(box);
        sideRoot.appendChild(row);
      });
    },

    fillAreaSelect: function (sel, currentStageId) {
      var areaId = World.mapAreaId || World.areaOf(currentStageId) || (World.areas()[0] || {}).id;
      sel.innerHTML = '';
      World.areas().forEach(function (a) {
        var o = document.createElement('option');
        o.value = a.id; o.textContent = World.placeLabel(a.id, a.name);
        if (a.id === areaId) o.selected = true;
        sel.appendChild(o);
      });
    },

    jumpArea: function (areaId, currentStageId, onPick) {
      if (World.locked(areaId)) {
        if (window.App) App.toast(I18n.t('world.lockedToast'), true);
        return;
      }
      World.mapLevel = 'fields';
      World.mapAreaId = areaId;
      var root = document.getElementById('world-fields');
      var side = document.getElementById('world-npcs') || document.getElementById('world-side');
      if (root) World.render(root, side, currentStageId, onPick);
    }
  };

  global.World = World;
})(window);
