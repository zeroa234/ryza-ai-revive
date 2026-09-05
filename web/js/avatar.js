/* Spine rendering: Ryza (foreground) + stage background.

   The render path follows the official spine-ts 4.2 webgl example
   (ManagedWebGLRenderingContext + explicit Matrix4 MVP + PolygonBatcher +
   SkeletonRenderer). SceneRenderer's OrthoCamera is not used.

   Camera: scene and character share one orthographic window (Avatar._view).
   posture_camera.json gives the authored window per posture (sitting 1.93,
   standing 1.45) and a closer ASMR pair; _applyCamera shrinks and shifts that
   window until it fits inside the scene plate's painted box, so no viewport
   aspect can expose unpainted art. The character is mapped through the same
   window, which keeps her authored on-screen framing regardless of what the
   plate forced on the camera — see the camera section for the full reasoning.

   Emotion comes from gesture.json EmotionProfilesV4:
   - idle: intensityProfiles.*.basePoses, mixed with mixDurationMin/Max
   - face: expressionSets (absent weight = 1, explicit 0 = author-disabled),
     re-rolled on the pose-reroll tick while she is not talking
   - FX: intensityProfiles.*.effectSets → fxOnAnimNames / fxOffAnimNames
     (setup-pose cheek/nose_hi stay on until the OFF clip + slot hide)
   - gaze/finger: DriverDefs + lookAtBoneHierarchy + fingerTrack* / aim·roll */
(function (global) {
  'use strict';

  var FALLBACK_LIP = 'facial_mouth_002_scrub_02';
  var FALLBACK_IDLE = ['motion_A_001_idle', 'motion_A_002_idle', 'motion_A_005_idle',
                       'motion_A_006_idle', 'motion_A_024_idle', 'motion_A_025_idle'];
  /* posture_camera.json is relative: zoom 1.93 (sitting) is the reference the
     table's world units were authored against, and it frames 1720 world units
     of height on the reference viewport. Everything else scales from that, so
     the stage never resizes when the costume or the posture changes. */
  var REF_ZOOM = 1.93;
  var REF_H = 1720;

  var RIM_VS = [
    'attribute vec2 a_pos;',
    'attribute vec2 a_uv;',
    'varying vec2 v_uv;',
    'void main(){ v_uv=a_uv; gl_Position=vec4(a_pos,0.0,1.0); }'
  ].join('\n');
  var RIM_FS = [
    '#ifdef GL_ES',
    'precision mediump float;',
    '#endif',
    'varying vec2 v_uv;',
    'uniform sampler2D u_texture;',
    'uniform vec2 u_texel;',
    'uniform vec2 u_light;',
    'uniform vec3 u_rimColor;',
    'uniform float u_rimOpacity;',
    'uniform float u_glowPower;',
    'void main(){',
    '  vec4 c=texture2D(u_texture,v_uv);',
    '  if(c.a<0.02){ gl_FragColor=vec4(0.0); return; }',
    '  float acc=0.0;',
    '  for(int i=1;i<=6;i++){',
    '    float t=float(i)/6.0;',
    '    float a2=texture2D(u_texture, v_uv + u_light*t*u_texel).a;',
    '    acc += (1.0-a2)*pow(1.0-t, u_glowPower);',
    '  }',
    '  acc/=6.0;',
    '  gl_FragColor=vec4(u_rimColor*acc*u_rimOpacity, acc*u_rimOpacity);',
    '}'
  ].join('\n');

  function pickAnim(data, name) {
    if (!name || !data) return null;
    if (data.findAnimation(name)) return name;
    if (!/_idle$/.test(name) && data.findAnimation(name + '_idle')) return name + '_idle';
    if (!/_active$/.test(name) && data.findAnimation(name + '_active')) return name + '_active';
    var stripped = name.replace(/_(idle|active)$/, '');
    if (stripped !== name && data.findAnimation(stripped)) return stripped;
    return null;
  }

  /* One WebGL context. Two stacked WebGL canvases flicker on Windows. */
  function makeHost(canvasId) {
    var canvas = document.getElementById(canvasId);
    var ctx;
    try {
      ctx = new spine.ManagedWebGLRenderingContext(canvas, {
        alpha: false, premultipliedAlpha: false, antialias: false
      });
    } catch (e) { return null; }
    if (!ctx || !ctx.gl) return null;
    return {
      canvas: canvas, ctx: ctx, gl: ctx.gl,
      shader: spine.Shader.newTwoColoredTextured(ctx),
      batcher: new spine.PolygonBatcher(ctx),
      sr: new spine.SkeletonRenderer(ctx),
      mvp: new spine.Matrix4()
    };
  }

  function makeLayer(host) {
    return {
      canvas: host.canvas, ctx: host.ctx, gl: host.gl,
      shader: host.shader, batcher: host.batcher, sr: host.sr,
      mvp: host.mvp,
      assets: new spine.AssetManager(host.ctx),
      skeleton: null, state: null, data: null,
      bounds: null, ready: false,
      /* painted-plate box of the scene, measured once per skeleton */
      _cover: null, _coverDone: false,
      cssW: 0, cssH: 0, dpr: 1
    };
  }

  var Avatar = {
    host: null,
    avatar: null,
    scene: null,
    gesture: null,
    postureCam: null,
    sceneConfig: null,
    skinsIndex: null,
    _loadedSkelId: '',
    /* atlas page variant currently requested ('default' or e.g. 'nsfw').
       Resolved per-costume by variantPageUrls — never a hardcoded skin id. */
    _atlasVariant: 'default',
    _variantMiss: {},
    _emotion: 'neutral',
    _attitude: 'agree',
    _talking: false,
    _idleTimer: 0,
    _idleGap: 6,
    _blinkTimer: 0,
    _last: 0,
    _eyeOpen: null,
    _eyeClosed: null,
    _mouthIdle: null,
    _lipSync: FALLBACK_LIP,
    _view: { left: 0, bottom: 0, worldW: 1, worldH: 1, cssW: 1, cssH: 1 },
    /* the authored (unclamped) window _view was solved from — _placeCharacter
       maps the character through it so her framing survives the clamp */
    _viewAuth: null,
    /* head bone's setup-pose local Y for the loaded skin (eyeline align) */
    _headLocal: null,
    /* sofa_root (etc.) bind-pose world pos — sitting stays on the midground */
    _midBind: null,
    _env: null,
    _look: { yaw: 0, pitch: 0, roll: 0, ty: 0, tp: 0, tr: 0, hold: 2, trans: 0.8, t: 0 },
    _pointer: { x: 0, y: 0, on: false },
    _ptrSm: { x: 0, y: 0 },
    _ptrInit: false,
    _lipOpen: 0,
    _lipHold: 0,
    _drivers: null,
    _fxOn: false,
    _fxKey: '',
    _fft: null,
    _poseType: '',
    _sittingId: 'sitting_normal',
    _armG: null,
    _torsoG: null,
    _legG: null,
    _legLG: null,
    _legRG: null,
    _addMuted: false,
    _mutedSnap: null,
    _hideChara: false,
    _skelHash: '',
    _lookHist: [],
    _lookClock: 0,
    _fbo: null,
    _fboTex: null,
    _fboW: 0,
    _fboH: 0,
    _rimShader: null,
    _quadBuf: null,
    _typeMap: null,
    _lookMul: 1,
    /* frozen pointer reference during one-shots (see _applyLook) */
    _faceRef: null,
    _pokeMouthHold: false,
    /* FX pick memo (emotion|band) so one reply does not re-roll blush twice */
    _fxPick: null,
    /* gaze driver cycle: { band, spec, left } honours ambientBindings
       repeatMin/repeatMax (source repeats the same driver pattern) */
    _lookCyc: null,
    /* pointer-follow weight 0..1, eased with projectConfig.gazeReturnToFront
       (source returns gaze to front over 0.4–0.8 s, never snaps) */
    _ptrW: 0,
    _ptrN: 0,
    _dt: 0,
    _blinkMode: 'blink',
    _closedDur: 0,
    _closedHold: 0,
    _exprBand: '',
    _rollSm: 0,
    /* Continuous tension (projectConfig.tensionConfig): ramps to 1 while
       talking, then decays high → mid → low at the band's decay rate.
       Drives gaze bindings, torso weights and blink cadence. */
    _tension: 0,

    /* ------------------------------------------------------------- setup */
    init: function (onReady) {
      Avatar.host = makeHost('scene-canvas');
      if (!Avatar.host) {
        App && App.toast('此浏览器不支持 WebGL，立绘无法显示', true);
        return;
      }
      Avatar.scene = makeLayer(Avatar.host);
      Avatar.avatar = makeLayer(Avatar.host);
      window.addEventListener('resize', function () { Avatar.resize(); });
      if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', function () { Avatar.resize(); });
      }
      requestAnimationFrame(Avatar._loop);
      Avatar._bindPointer();
      Promise.all([
        fetch('assets/data/posture_camera.json').then(function (r) { return r.json(); }),
        fetch('assets/_index/skins.json').then(function (r) { return r.json(); })
      ]).then(function (res) {
        Avatar.postureCam = res[0];
        Avatar.skinsIndex = res[1] || [];
        onReady && onReady();
      }).catch(function () { onReady && onReady(); });
    },

    /* Layout-px → viewport-px scale for an element inside #phone (Electron
       UI zoom, see App._fitUi). Self-measured so it is correct under BOTH
       zoom conventions: standardised Chrome ≥128 reports the rect in
       viewport px (ratio = zoom), older WebViews report it in layout px
       (ratio = 1 — and they never get zoomed anyway, the gate is Electron).
       Every clientX/Y→layout conversion divides by this; the canvas backing
       store multiplies its dpr by it. */
    _cssZoom: function (el) {
      if (!el || !el.clientWidth || !el.getBoundingClientRect) return 1;
      var w = el.getBoundingClientRect().width;
      return (w > 0 && w / el.clientWidth) || 1;
    },

    resize: function () {
      var host = Avatar.host;
      if (!host) return;
      var dpr = Math.max(1, window.devicePixelRatio || 1) * Avatar._cssZoom(host.canvas);
      var w = Math.max(1, Math.floor(host.canvas.clientWidth));
      var h = Math.max(1, Math.floor(host.canvas.clientHeight));
      var bw = Math.max(1, Math.floor(w * dpr));
      var bh = Math.max(1, Math.floor(h * dpr));
      if (host.canvas.width !== bw || host.canvas.height !== bh) {
        host.canvas.width = bw;
        host.canvas.height = bh;
      }
      if (host.gl) host.gl.viewport(0, 0, bw, bh);
      [Avatar.scene, Avatar.avatar].forEach(function (L) {
        if (!L) return;
        L.cssW = w; L.cssH = h; L.dpr = dpr;
      });
      /* one pass: _applyCamera solves the window and places the character */
      Avatar._applyCamera();
    },

    outfitOf: function (id) {
      return String(id || 'crf_skn_002_0001').replace(/_(01|99)$/, '');
    },

    /* --------------------------------------------------- posture (source) */
    /* Which skeleton to show.
       The gesture files are the authority on what each skin IS:
         crf_skn_002_0001_01 → name 座りライザ（普通座り）, projectConfig
                               .postureKey = posture_sitting (barefoot, vest +
                               shorts, folded leg chain)
         crf_skn_002_0001_99 → name ライザ(3の通常)_立ち,  projectConfig
                               .postureKey = posture_standing (jacket, long
                               socks, boots, straight 1704u leg chain)
       so sitting ⇒ _01 and standing ⇒ _99, and the DEFAULT is standing — the
       original starts on her feet, which is the whole reason the reversed
       default read as "the models are swapped from the start".
       The scene's `midgroundPostures` is NOT a constraint on that: 196 of the
       200 shipped scene/time combinations list posture_sitting only (the
       midground furniture — sofa_root etc. — was authored for her seated), and
       gating the skin on it would make sitting unavoidable everywhere. It
       decides only where the sit/stand toggle is OFFERED, i.e. where a
       midground exists for both. */
    _scenePostures: function () {
      var cfg = Avatar.sceneConfig && Avatar.sceneConfig.config;
      return (cfg && cfg.midgroundPostures) || [];
    },

    postureKey: function () {
      /* The stored choice is honoured ONLY where the scene has a midground for
         both postures. Everywhere else the default (standing) applies — and it
         must be the scene that decides, not the saved value: reading a stale
         posture_sitting after leaving 隠れ家前 used to render the sitting skin
         (at the sitting camera) on the next stage until the stage after that. */
      if (!Avatar.supportsBothPostures()) return 'posture_standing';
      try {
        var want = Config.section('state').posture;
        if (want === 'posture_standing' || want === 'posture_sitting') return want;
      } catch (e) { /* Config not ready */ }
      return 'posture_standing';
    },

    /* Which posture the skeleton ACTUALLY on screen represents. During a
       posture or stage swap the requested posture and the loaded skin disagree
       for a moment (loadScene re-solves the camera before loadSkin has swapped
       the skeleton) — placing the old skeleton with the new posture's camera
       flashed a 1.488× sitting model on the next stage. */
    _loadedPosture: function () {
      var id = Avatar._loadedSkelId || '';
      var m = /_(01|99)$/.exec(id);
      return m ? (m[1] === '99' ? 'posture_standing' : 'posture_sitting')
               : Avatar.postureKey();
    },

    /* True only on stages whose scene lists both postures — in the shipped
       pack that is 隠れ家前 / stage_01_002_01, at every time of day. */
    supportsBothPostures: function () {
      return Avatar._scenePostures().length > 1;
    },

    /* The posture a scene's midground was drawn for first — used for the
       posture-independent background window, see _applyCamera. */
    _primaryPosture: function () {
      var m = Avatar._scenePostures();
      return m[0] || 'posture_standing';
    },

    _asmrOn: function () {
      try { return Config.section('state').mode === 'asmr'; } catch (e) { return false; }
    },

    resolveSkel: function (outfitId) {
      var skins = Avatar.skinsIndex || [];
      var outfit = Avatar.outfitOf(outfitId);
      var wantSuf = Avatar.postureKey() === 'posture_standing' ? '99' : '01';
      var otherSuf = wantSuf === '99' ? '01' : '99';
      /* Only 0001 ships skeletons (0002/0003/0004 are preview-only), so the
         wanted posture usually falls back to the same outfit's other skin
         before it falls back to a different outfit at all. */
      var order = [outfit + '_' + wantSuf, outfit + '_' + otherSuf,
                   'crf_skn_002_0001_' + wantSuf, 'crf_skn_002_0001_' + otherSuf];
      var i, id, hit;
      for (i = 0; i < order.length; i++) {
        id = order[i];
        hit = skins.filter(function (x) { return x.id === id && x.hasSpine && x.skel; })[0];
        if (hit) return hit;
      }
      return skins.filter(function (x) { return x.hasSpine && x.skel; })[0] || null;
    },

    _skinEntry: function (id) {
      var skins = Avatar.skinsIndex || [], i;
      for (i = 0; i < skins.length; i++) if (skins[i].id === id) return skins[i];
      return null;
    },

    /* Sanitize a variant tag so it can only be a filename suffix. */
    _cleanVariant: function (name) {
      var n = String(name || 'default').toLowerCase();
      if (!n || n === 'default' || n === 'off' || n === 'none') return '';
      return /^[a-z0-9_]{1,32}$/.test(n) ? n : '';
    },

    /* Candidate URLs for one atlas page's variant texture.
       Any future costume works the same way:
         1. skins.json entry.variants[name] (string, or {pageName: url})
         2. `{atlasDir}/{pageBase}{name}.png`   e.g. crf_skn_002_0001_99nsfw.png
         3. `{atlasDir}/{pageBase}_{name}.png`  e.g. crf_skn_002_0002_01_nsfw.png
       Avatar does not know which outfits exist — missing files stay on the
       default page (intent can still be on, so a later wearable costume applies). */
    variantPageUrls: function (atlasUrl, pageName, variant) {
      variant = Avatar._cleanVariant(variant);
      if (!variant) return [];
      var dir = String(atlasUrl || '').replace(/[^/]+$/, '');
      var page = String(pageName || '');
      var dot = page.lastIndexOf('.');
      var base = dot >= 0 ? page.slice(0, dot) : page;
      var ext = dot >= 0 ? page.slice(dot) : '.png';
      var out = [], seen = {};
      function add(u) {
        if (!u || seen[u]) return;
        seen[u] = 1;
        out.push(u);
      }
      var s = Avatar._skinEntry(Avatar._loadedSkelId);
      var ov = s && s.variants && s.variants[variant];
      if (typeof ov === 'string') add(ov);
      else if (ov && typeof ov === 'object') add(ov[page] || ov[base] || ov['*']);
      add(dir + base + variant + ext);
      add(dir + base + '_' + variant + ext);
      return out;
    },

    setAtlasVariant: function (name, cb) {
      Avatar._atlasVariant = Avatar._cleanVariant(name) ? Avatar._cleanVariant(name) : 'default';
      Avatar._applyAtlasVariant(cb);
    },

    _disposeVariantTex: function (L) {
      if (!L || !L._atlasVarTex) return;
      L._atlasVarTex.forEach(function (t) {
        if (t && t.dispose) try { t.dispose(); } catch (e) { /* gl gone */ }
      });
      L._atlasVarTex = null;
      L._atlasVarName = '';
    },

    /* Own Image+GLTexture path — must NOT go through AssetManager.loadTexture:
       a 404 would stick in assets.errors and the next loadSkin poll would
       treat the whole skeleton as failed. */
    _loadPageImage: function (L, url, cb) {
      if (!L || !url || typeof Image === 'undefined' || !spine || !spine.GLTexture) {
        cb(null); return;
      }
      var img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = function () {
        try { cb(new spine.GLTexture(L.ctx, img)); }
        catch (e) { cb(null); }
      };
      img.onerror = function () { cb(null); };
      img.src = url;
    },

    _tryPageUrls: function (L, urls, cb) {
      var i = 0;
      (function next() {
        if (i >= urls.length) { cb(null); return; }
        var url = urls[i++];
        var miss = (Avatar._loadedSkelId || '') + '\0' + url;
        if (Avatar._variantMiss[miss]) { next(); return; }
        Avatar._loadPageImage(L, url, function (tex) {
          if (tex) { cb(tex); return; }
          Avatar._variantMiss[miss] = 1;
          next();
        });
      })();
    },

    _applyAtlasVariant: function (cb) {
      var L = Avatar.avatar;
      var done = function () { cb && cb(null); };
      if (!L || !L._atlas || !L.ctx) { done(); return; }
      var pages = L._atlas.pages || [];
      if (!pages.length) { done(); return; }
      if (!L._atlasBaseTex) {
        L._atlasBaseTex = pages.map(function (p) { return p.texture; });
      }
      var variant = Avatar._cleanVariant(Avatar._atlasVariant);
      if (!variant) {
        for (var i = 0; i < pages.length; i++) {
          if (L._atlasBaseTex[i]) pages[i].setTexture(L._atlasBaseTex[i]);
        }
        done();
        return;
      }
      if (L._atlasVarName === variant && L._atlasVarTex &&
          L._atlasVarTex.length === pages.length) {
        for (var j = 0; j < pages.length; j++) {
          if (L._atlasVarTex[j]) pages[j].setTexture(L._atlasVarTex[j]);
        }
        done();
        return;
      }
      var pending = pages.length, loaded = new Array(pages.length), any = false;
      function finish() {
        pending--;
        if (pending > 0) return;
        if (!any) { done(); return; }
        Avatar._disposeVariantTex(L);
        L._atlasVarName = variant;
        L._atlasVarTex = loaded;
        for (var k = 0; k < pages.length; k++) {
          if (loaded[k]) pages[k].setTexture(loaded[k]);
        }
        done();
      }
      pages.forEach(function (page, idx) {
        var urls = Avatar.variantPageUrls(L._atlasUrl, page.name, variant);
        Avatar._tryPageUrls(L, urls, function (tex) {
          if (tex) { loaded[idx] = tex; any = true; }
          finish();
        });
      });
    },

    /* ------------------------------------------------------------- camera */
    /* One orthographic window (Avatar._view) maps world units to the canvas
       and is shared by the scene plate and the character.

       posture_camera.json supplies the AUTHORED window per posture (sitting
       zoom 1.93 / standing 1.45) plus a closer ASMR pair. Two of its
       assumptions do not survive contact with the shipped art:

       1. the standing window is 2289u tall, but the only dual-posture stage
          (隠れ家前 / stage_01_002_01) paints far_bg over y 629..2701 — 2072u —
          and its second quad (`floor`, a foreground strip at y −2701..−1064)
          leaves the band between them UNPAINTED. The standing window's bottom
          edge walked into that band: a black bar across the lower third of the
          screen, and a different window centre per posture, so the background
          visibly jumped when the player toggled sit/stand;
       2. worldW is worldH × canvas aspect, so any wide viewport (landscape
          desktop, tablet) walks outside the plate on both sides.

       So the window actually used is the authored window of the scene's
       PRIMARY posture — never enlarged, shrunk and shifted until it fits
       inside the plate's painted box (`_coverFor`). No black bars at any
       aspect ratio, and because the window does not depend on the player's
       choice the background no longer moves on a posture toggle. The
       character is mapped through that window by `_placeCharacter` so she
       keeps the on-screen framing the table asks for. Sitting on a midground
       (`sofa_root`) keeps world X/Y so she does not float off the furniture. */
    _coverFor: function (L) {
      if (!L || !L.skeleton) return null;
      if (L._coverDone) return L._cover || null;
      var best = null, slots = L.skeleton.slots, i, j, slot, att, verts, n;
      L.skeleton.updateWorldTransform(spine.Physics.none);
      for (i = 0; i < slots.length; i++) {
        slot = slots[i];
        /* Alpha is deliberately ignored: the scene's only animation is a fade,
           so measuring mid-fade must not call the plate empty. */
        if (!slot.bone.active || !slot.data.visible) continue;
        att = slot.getAttachment && slot.getAttachment();
        if (!att || att instanceof spine.BoundingBoxAttachment ||
            att instanceof spine.ClippingAttachment ||
            att instanceof spine.PathAttachment ||
            att instanceof spine.PointAttachment) continue;
        verts = [];
        try {
          if (att instanceof spine.RegionAttachment) {
            att.computeWorldVertices(slot, verts, 0, 2);
          } else if (att.worldVerticesLength) {
            att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
          } else { continue; }
        } catch (e) { continue; }
        n = verts.length;
        if (n < 6) continue;
        var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
        for (j = 0; j < n; j += 2) {
          if (!isFinite(verts[j]) || !isFinite(verts[j + 1])) { x1 = -1e9; break; }
          if (verts[j] < x0) x0 = verts[j];
          if (verts[j] > x1) x1 = verts[j];
          if (verts[j + 1] < y0) y0 = verts[j + 1];
          if (verts[j + 1] > y1) y1 = verts[j + 1];
        }
        if (!(x1 > x0) || !(y1 > y0)) {
          /* A RegionAttachment keeps its four corners in an `offset` cache
             filled by updateRegion(); that cache can still be empty the first
             time we look (scene load happens before the first draw, and a
             headless harness has no real atlas). Derive the same box from the
             attachment size and the bone matrix rather than reporting "no
             plate" — a missed cover means a missed clamp means black bars. */
          if (!(att instanceof spine.RegionAttachment) || !att.width || !att.height ||
              !isFinite(slot.bone.a)) continue;
          var hw = att.width / 2, hh = att.height / 2, bn = slot.bone;
          var corners = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]];
          x0 = y0 = 1e9; x1 = y1 = -1e9;
          for (j = 0; j < 4; j++) {
            var px = corners[j][0] * bn.a + corners[j][1] * bn.b + bn.worldX;
            var py = corners[j][0] * bn.c + corners[j][1] * bn.d + bn.worldY;
            if (px < x0) x0 = px;
            if (px > x1) x1 = px;
            if (py < y0) y0 = py;
            if (py > y1) y1 = py;
          }
          if (!(x1 > x0) || !(y1 > y0)) continue;
        }
        /* The LARGEST quad, not the union: a far-away foreground strip would
           otherwise pretend the gap under the backdrop is covered. */
        if (!best || (x1 - x0) * (y1 - y0) > best.w * best.h) {
          best = { x0: x0, x1: x1, y0: y0, y1: y1, w: x1 - x0, h: y1 - y0 };
        }
      }
      L._coverDone = true;
      L._cover = best;
      return best;
    },

    /* Authored window for one posture (+ the ASMR close-up when on). */
    _camParams: function (postureKey, asmr) {
      var pack = (Avatar.postureCam &&
                  Avatar.postureCam[postureKey || Avatar.postureKey()]) ||
                 (Avatar.postureCam && Avatar.postureCam.posture_sitting) || {};
      var base = pack.base || { offsetX: 0, offsetY: 0, scale: 1,
                                cameraZoom: REF_ZOOM, cameraPanX: 0, cameraPanY: 900 };
      var zoom = Number(base.cameraZoom); if (!(zoom > 0.2)) zoom = REF_ZOOM;
      var panX = Number(base.cameraPanX) || 0;
      var panY = Number(base.cameraPanY) || 0;
      var a = (asmr === undefined ? Avatar._asmrOn() : asmr) && pack.asmr;
      if (a) {
        var az = Number(a.cameraZoom);
        /* ASMR zoom is the APK table (sitting 3.5 / standing 2.5). Do not
           invent a smaller zoom — the original close-up is that tight.
           asmr.cameraPanY (~3200) is a different space and would aim at
           empty sky, so we lift toward the face instead. */
        if (az > 0.2) { panY += (az / zoom - 1) * 280; zoom = az; }
        if (a.cameraPanX != null) panX = Number(a.cameraPanX) || 0;
      }
      var tight = zoom / REF_ZOOM;
      if (tight > 1.05) panY = panY + (tight - 1) * 140;
      var worldH = REF_H / Math.max(0.45, tight);
      /* Normal-mode framing corrections (LOCAL calibration, same family as
         the REF_H derivation — the official zoom→world-height mapping is
         not in the package). Measured against the shipped screenshots:
         standing must fit headwear→knees with margin (×1.42 of the derived
         2289u); sitting rides ×1.25 so she doesn't fill the frame head→chest
         next to the standing shot (she is sofa-locked in world space, so
         only the window — not her placement — changes). ASMR close-ups keep
         the authored table values. */
      if (!a) {
        var pk = postureKey || Avatar.postureKey();
        /* Face-size calibration against the official shots (menu screenshot:
           head box ≈ 18% of screen height, rabbit-bow top ~1%, thigh bottom
           ~89% — everything fits ONLY at that size; at our earlier 1.42 the
           face was ~31% and bow-vs-thighs became a zero-sum choice).
           Screen face = BB_head box × scale / (authored window × factor):
           standing 617×1.488/(2289×1.53)=0.263; the sitting factor keeps
           parity through the skins' world-box ratio (655/617 × 1.488/1.0):
           655/(1720×1.60)=0.238. LOCAL calibration — the official
           zoom→world-height mapping is not in the package. */
        if (pk === 'posture_standing') worldH *= 1.53;
        else if (pk === 'posture_sitting') worldH *= 1.45;
      }
      var L = Avatar.scene || Avatar.avatar;
      var aspect = (L && L.cssW && L.cssH) ? L.cssW / L.cssH : 0.5;
      var worldW = worldH * aspect;
      return {
        offsetX: Number(base.offsetX) || 0,
        offsetY: Number(base.offsetY) || 0,
        scale: Number(base.scale) || 1,
        zoom: zoom, panX: panX, panY: panY,
        worldW: worldW, worldH: worldH,
        left: panX - worldW / 2, bottom: panY - worldH / 2
      };
    },

    /* Solve the window to use, then place the character inside it. */
    _applyCamera: function () {
      var host = Avatar.host, L = Avatar.scene || Avatar.avatar;
      if (!host || !L || !L.cssW || !L.cssH) return;
      var active = Avatar._camParams(Avatar._loadedPosture());
      /* The background is framed by the scene's own posture, not the player's
         choice, so toggling sit/stand cannot move it. On single-posture scenes
         the two are the same window anyway. */
      var win = Avatar.supportsBothPostures()
        ? Avatar._camParams(Avatar._primaryPosture(), Avatar._asmrOn())
        : active;
      var cover = Avatar._coverFor(Avatar.scene);
      if (cover && cover.w > 0 && cover.h > 0) {
        var aspect = L.cssW / L.cssH;
        /* Panel-aware slack: the bottom log panel (officially opaque) hides
           art-less ground, so the window may extend below the painted plate
           by exactly what the panel covers. This is what lets the SITTING
           window keep its authored 1720u bottom (359) — the official sitting
           shot shows her lap because the sofa is drawn below far_bg's edge,
           and _coverFor (largest quad) doesn't see it. Top/left/right stay
           hard-clamped; height may exceed the plate only by the covered
           share. */
        var frac = Avatar._panelFrac || 0;
        var h = Math.min(win.worldH,
          Math.min(cover.h / Math.max(0.4, 1 - frac), cover.w / aspect));
        var w = h * aspect;
        var bottom = win.bottom;
        var floorY = cover.y0 - h * frac;
        if (bottom < floorY) bottom = floorY;
        /* h ≤ cover.h/(1-frac) above makes top+floor simultaneously
           satisfiable, so the top clamp is unconditional now (the old
           cover.h >= h guard skipped it for tall windows and let the top
           edge poke above the art) */
        if (bottom > cover.y1 - h) bottom = cover.y1 - h;
        var left = win.left + (win.worldW - w) / 2;
        if (left < cover.x0) left = cover.x0;
        if (cover.w >= w && left > cover.x1 - w) left = cover.x1 - w;
        win = { left: left, bottom: bottom, worldW: w, worldH: h };
      }
      Avatar._view = {
        left: win.left, bottom: win.bottom,
        worldW: win.worldW, worldH: win.worldH, cssW: L.cssW, cssH: L.cssH
      };
      Avatar._viewAuth = active;
      host.mvp.ortho2d(win.left, win.bottom, win.worldW, win.worldH);
      if (host.gl) host.gl.viewport(0, 0, host.canvas.width, host.canvas.height);
      Avatar._placeCharacter();
    },

    /* Head bone's local Y (skeleton space, scale 1, setup pose) for the skin
       that is currently loaded. Needed to align her eyeline — see
       _placeCharacter. Cheap: one throwaway skeleton, once per skin load. */
    _measureHeadLocal: function () {
      var L = Avatar.avatar;
      Avatar._headLocal = null;
      if (!L || !L.data) return;
      try {
        var sk = new spine.Skeleton(L.data);
        sk.updateWorldTransform(spine.Physics.pose);
        var b = sk.findBone('head');
        if (b) Avatar._headLocal = b.worldY;
      } catch (e) { /* no head bone → skip the alignment */ }
    },

    /* Place the character so her on-screen framing is what the table asks
       for, whatever the plate did to the camera. Called every frame:
       chara_root rides the scene's parallax. Sitting on sofa_root keeps
       world-space X/Y (source: chara_root_offset / sofa compensation) —
       remapping Y through the camera is what floated her off the seat. */
    _placeCharacter: function () {
      var L = Avatar.avatar, S = Avatar.scene;
      if (!L || !L.skeleton) return;
      var cam = Avatar._camParams(Avatar._loadedPosture());
      var x = cam.offsetX, y = cam.offsetY;
      if (S && S.skeleton) {
        var bone = S.skeleton.findBone('chara_root');
        if (bone) { x += bone.worldX; y += bone.worldY; }
        if (Avatar._seatedOnMid()) {
          var mid = S.skeleton.findBone(Avatar._midBind.name);
          if (mid) {
            x += mid.worldX - Avatar._midBind.x;
            y += mid.worldY - Avatar._midBind.y;
          }
        }
      }
      var v = Avatar._view, a = Avatar._viewAuth;
      var k = (v && v.worldH && a && a.worldH) ? v.worldH / a.worldH : 1;
      var sx, sy, sc = cam.scale * k;
      if (Avatar._seatedOnMid()) {
        sx = x;
        sy = y;        /* furniture-locked: she sits ON the sofa, no lift —
                          the source's whole point (sitting stays on sofa) */
      } else {
        sx = (v && a) ? v.left + (x - a.left) * k : x;
        sy = (v && a) ? v.bottom + (y - a.bottom) * k : y;
        /* Eyeline only when she is not locked to furniture. Target = the
           head-BONE fraction of the window (measured live): standing 0.67
           lands the BB_head box top ≈ 118px with the rabbit-bow fully in
           frame; sitting keeps the table's own 0.70 (no push fires within
           ±0.10). ASMR keeps its tight 0.50 close-up. */
        if (Avatar._headLocal != null && v && v.worldH > 0) {
          var target = Avatar._asmrOn() ? 0.50
            : (Avatar._loadedPosture() === 'posture_standing' ? 0.70 : 0.71);
          var frac = (sy + Avatar._headLocal * sc - v.bottom) / v.worldH;
          if (Math.abs(frac - target) > 0.10) sy += (target - frac) * v.worldH;
        }
      }
      L.skeleton.x = sx;
      L.skeleton.y = sy;
      L.skeleton.scaleX = L.skeleton.scaleY = sc;
    },

    _seatedOnMid: function () {
      return Avatar._loadedPosture() === 'posture_sitting' &&
             Avatar._midBind && Avatar._midBind.name;
    },

    /* Bind-pose world of the midground seat (sofa_root). Source
       `_currentSofaRootCompensationOffset` — character follows the sofa
       when parallax moves it, instead of sitting in empty air. */
    _cacheMidBind: function (L) {
      Avatar._midBind = null;
      if (!L || !L.skeleton) return;
      try {
        L.skeleton.setToSetupPose();
        L.skeleton.updateWorldTransform(spine.Physics.none);
        var b = L.skeleton.findBone('sofa_root');
        if (b) Avatar._midBind = { name: 'sofa_root', x: b.worldX, y: b.worldY };
      } catch (e) { Avatar._midBind = null; }
    },

    screenToWorld: function (cssX, cssY) {
      var v = Avatar._view;
      return {
        x: v.left + (cssX / Math.max(1, v.cssW)) * v.worldW,
        y: v.bottom + ((v.cssH - cssY) / Math.max(1, v.cssH)) * v.worldH
      };
    },

    _pointInPoly: function (x, y, verts) {
      var inside = false, n = Math.floor(verts.length / 2), i, j, xi, yi, xj, yj;
      for (i = 0, j = n - 1; i < n; j = i++) {
        xi = verts[i * 2]; yi = verts[i * 2 + 1];
        xj = verts[j * 2]; yj = verts[j * 2 + 1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-9) + xi)) {
          inside = !inside;
        }
      }
      return inside;
    },

    /* Part priority when several BB_* boxes overlap (they do — the author's
       boxes are generous rectangles). Specific parts win, body is the catch-all. */
    _PART_PRIORITY: ['head', 'breast', 'weast', 'arm_l', 'arm_r', 'body'],

    _bbMap: function () {
      return (Avatar.gesture && Avatar.gesture.projectConfig &&
              Avatar.gesture.projectConfig.hitPartNames) || {
        BB_head: 'head', BB_body: 'body', BB_arm_L: 'arm_l', BB_arm_R: 'arm_r',
        BB_weast: 'weast', BB_breast: 'breast'
      };
    },

    /* World-space polygon of a slot's bounding-box attachment, or null. */
    _bbPoly: function (slotName) {
      var L = Avatar.avatar;
      if (!L || !L.skeleton) return null;
      var slot = L.skeleton.findSlot(slotName);
      if (!slot || !slot.bone || !slot.bone.active) return null;
      var att = slot.getAttachment && slot.getAttachment();
      if (!att || !att.worldVerticesLength || !att.computeWorldVertices) return null;
      var verts = [];
      try {
        att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
      } catch (e) { return null; }
      return verts.length >= 6 ? verts : null;
    },

    /* Is the world point on a *visible* part of the character? The BB_* boxes
       reach far outside the drawn silhouette, so a bare box test lets clicks
       in empty space next to her trigger reactions. Any rendered region/mesh
       covering the point counts (setup-hidden FX/BB/clip slots don't). */
    _onCharacter: function (x, y) {
      var L = Avatar.avatar;
      if (!L || !L.skeleton) return false;
      var slots = L.skeleton.slots, i, slot, att, verts, n;
      for (i = 0; i < slots.length; i++) {
        slot = slots[i];
        if (!slot.bone.active || !slot.data.visible) continue;
        if (slot.color.a < 0.05) continue;
        att = slot.getAttachment && slot.getAttachment();
        if (!att) continue;
        if (att instanceof spine.BoundingBoxAttachment ||
            att instanceof spine.ClippingAttachment ||
            att instanceof spine.PathAttachment ||
            att instanceof spine.PointAttachment) continue;
        verts = [];
        try {
          if (att instanceof spine.RegionAttachment) {
            att.computeWorldVertices(slot, verts, 0, 2);
          } else if (att.worldVerticesLength) {
            att.computeWorldVertices(slot, 0, att.worldVerticesLength, verts, 0, 2);
          } else {
            continue;
          }
        } catch (e) { continue; }
        n = verts.length;
        if (n >= 6 && Avatar._pointInPoly(x, y, verts)) return true;
      }
      return false;
    },

    /* Exact tap-to-part mapping: inside the highest-priority BB_* polygon
       AND on the visible silhouette. Anything else returns null — there is
       deliberately no bone-radius fallback anymore (the old 220u circle
       swallowed half the background and was the misfire source). */
    hitPartAt: function (cssX, cssY) {
      var L = Avatar.avatar;
      if (!L || !L.ready || !L.skeleton) return null;
      var w = Avatar.screenToWorld(cssX, cssY);
      if (!Avatar._onCharacter(w.x, w.y)) return null;
      var map = Avatar._bbMap();
      var byPart = {}, slotName;
      for (slotName in map) {
        if (!Object.prototype.hasOwnProperty.call(map, slotName)) continue;
        var poly = Avatar._bbPoly(slotName);
        if (poly && Avatar._pointInPoly(w.x, w.y, poly)) byPart[map[slotName]] = true;
      }
      for (var i = 0; i < Avatar._PART_PRIORITY.length; i++) {
        if (byPart[Avatar._PART_PRIORITY[i]]) return Avatar._PART_PRIORITY[i];
      }
      return null;
    },

    /* ------------------------------------------------------- asset loading */
    _loadSpine: function (L, skelUrl, atlasUrl, done) {
      var a = L.assets;
      if (L === Avatar.avatar) {
        Avatar._disposeVariantTex(L);
        L._atlas = null;
        L._atlasUrl = '';
        L._atlasBaseTex = null;
      }
      a.removeAll();
      a.errors = {};
      a.loadBinary(skelUrl);
      a.loadTextureAtlas(atlasUrl);
      var tries = 0;
      (function poll() {
        if (a.isLoadingComplete()) {
          if (a.hasErrors()) { done(new Error('素材加载失败：' + skelUrl)); return; }
          try {
            var atlas = a.require(atlasUrl);
            var loader = new spine.AtlasAttachmentLoader(atlas);
            var bin = new spine.SkeletonBinary(loader);
            bin.scale = 1;
            var data = bin.readSkeletonData(a.require(skelUrl));
            L.data = data;
            L.skeleton = new spine.Skeleton(data);
            L.state = new spine.AnimationState(new spine.AnimationStateData(data));
            L.state.data.defaultMix = 0.12;
            /* new skeleton ⇒ its painted plate box has to be re-measured */
            L._cover = null;
            L._coverDone = false;
            if (L === Avatar.avatar) {
              Avatar._skelHash = String(data.hash || '').toLowerCase();
              L._atlas = atlas;
              L._atlasUrl = atlasUrl;
              L._atlasBaseTex = null;
            }
            L.ready = true;
            done(null);
          } catch (e) { done(e); }
          return;
        }
        if (++tries > 900) { done(new Error('加载超时：' + skelUrl)); return; }
        setTimeout(poll, 50);
      })();
    },

    loadSkin: function (skinId, cb) {
      var L = Avatar.avatar;
      if (!L) return;
      var apply = function (skins) {
        Avatar.skinsIndex = skins || Avatar.skinsIndex || [];
        var s = Avatar.resolveSkel(skinId);
        if (!s || !s.hasSpine || !s.skel) {
          var err = new Error('preview-only skin');
          cb && cb(err);
          return;
        }
        if (Avatar._loadedSkelId === s.id && L.ready) { cb && cb(null); return; }
        L.ready = false;
        var gP = s.gesture
          ? fetch(s.gesture).then(function (r) { return r.ok ? r.json() : null; })
          : Promise.resolve(null);
        gP.then(function (g) {
          Avatar.gesture = g;
          Avatar._loadSpine(L, s.skel, s.atlas, function (err) {
            if (err) { App && App.toast(err.message, true); cb && cb(err); return; }
            Avatar._loadedSkelId = s.id;
            Avatar._fxKey = '';
            Avatar._fxPick = null;
            Avatar._lookCyc = null;
            Avatar._ptrW = 0;
            Avatar._ptrN = 0;
            Avatar._closedHold = 0;
            Avatar._rollSm = 0;
            Avatar._drivers = null;
            Avatar._fxOn = false;
            Avatar._poseType = '';
            Avatar._faceRef = null;
            Avatar._exitMixCache = null;
            Avatar._armG = null;
            Avatar._torsoG = null;
            Avatar._legG = null;
            Avatar._legLG = null;
            Avatar._legRG = null;
            Avatar._addMuted = false;
            Avatar._mutedSnap = null;
            Avatar._typeMap = null;
            Avatar._sittingId = Avatar._sittingFromPosture();
            Avatar._measureHeadLocal();
            Avatar.setEmotion(Avatar._emotion, Avatar._attitude, true);
            Avatar._playWind();
            Avatar.resize();
            if (Avatar._cleanVariant(Avatar._atlasVariant)) Avatar._applyAtlasVariant();
            cb && cb(null);
          });
        }).catch(function (e) {
          App && App.toast('皮肤加载失败：' + e.message, true);
          cb && cb(e);
        });
      };
      if (Avatar.skinsIndex) apply(Avatar.skinsIndex);
      else fetch('assets/_index/skins.json').then(function (r) { return r.json(); }).then(apply)
        .catch(function (e) { cb && cb(e); });
    },

    loadScene: function (stageId, tod, cb) {
      var L = Avatar.scene;
      if (!L) return;
      fetch('assets/_index/scenes.json').then(function (r) { return r.json(); })
        .then(function (scenes) {
          var stage = scenes[stageId];
          var entry = stage && (stage[tod] || stage[Object.keys(stage)[0]]);
          if (!entry) throw new Error('没有这个场景：' + stageId + '/' + tod);
          L.ready = false;
          var cfgP = entry.config
            ? fetch(entry.config).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
            : Promise.resolve(null);
          return cfgP.then(function (cfg) {
            Avatar.sceneConfig = cfg;
            Avatar._loadSpine(L, entry.skel, entry.atlas, function (err) {
              if (err) { cb && cb(err); return; }
              /* Scene clips are only fade in/out (1s). Looping fade_in restarts
                 from transparent every second — that is the background flicker. */
              var fade = pickAnim(L.data, 'anm_fade_in') ||
                         pickAnim(L.data, 'anm_fade_in_all');
              if (fade) {
                var tr = L.state.setAnimation(0, fade, false);
                tr.mixDuration = 0;
              }
              Avatar._applySceneConstraints(L, cfg);
              Avatar._cacheMidBind(L);
              Avatar.resize();
              var outfit = (window.Config && Config.section('state').skin) || 'crf_skn_002_0001';
              Avatar.loadSkin(outfit, cb);
            });
          });
        })
        .catch(function (e) { cb && cb(e); });
    },

    /* JSON stores mixes as percents (7.5, 100); the .skel already has 0–1.
       Re-apply so a rebuilt scene still matches the authored parallax. */
    _applySceneConstraints: function (L, cfg) {
      var ov = cfg && cfg.config && cfg.config.constraintOverrides;
      if (!ov || !L || !L.skeleton) return;
      var list = L.skeleton.transformConstraints || [];
      var i, c, n, o, pct;
      function asMix(v) {
        if (v == null) return null;
        pct = Number(v);
        return pct > 1.5 ? pct / 100 : pct;
      }
      for (i = 0; i < list.length; i++) {
        c = list[i];
        n = (c.data && c.data.name) || c.name;
        o = ov[n];
        if (!o) continue;
        if (o.translateMixX != null) c.mixX = asMix(o.translateMixX);
        if (o.translateMixY != null) c.mixY = asMix(o.translateMixY);
        if (o.scaleMixX != null) c.mixScaleX = asMix(o.scaleMixX);
        if (o.scaleMixY != null) c.mixScaleY = asMix(o.scaleMixY);
      }
    },

    /* --------------------------------------------------------- expression */
    _profile: function (emotion) {
      var g = Avatar.gesture;
      var map = g && g.emotionalGesture && g.emotionalGesture.EmotionProfilesV4;
      if (!map) return null;
      return map[emotion] || map.neutral || null;
    },

    _intensityBand: function () {
      if (Avatar._talking || Avatar._tension > 0.66) return 'strong';
      var mode = '';
      try { mode = Config.section('state').mode; } catch (e) {}
      return mode === 'asmr' ? 'weak' : 'normal';
    },

    _intensity: function (prof) {
      var ip = prof && prof.intensityProfiles;
      if (!ip) return null;
      var want = ip[Avatar._intensityBand()];
      return want || ip.normal || ip.strong || ip.weak || null;
    },

    _oneShots: function (emotion, attitude) {
      var prof = Avatar._profile(emotion);
      if (!prof) return [];
      var list = (prof.fixedGestureBindingsByAttitude || {})[attitude] || [];
      var picked = list.filter(function (x) { return (x.weight || 0) > 0 && x.oneShotAnimation; });
      var hit = Util.weighted(picked, function (x) { return x.weight; });
      return hit ? [hit.oneShotAnimation] : [];
    },

    _mixRange: function (emotion) {
      var p = Avatar._profile(emotion);
      var a = Number(p && p.mixDurationMin); if (!(a > 0)) a = 0.4;
      var b = Number(p && p.mixDurationMax); if (!(b > 0)) b = a;
      if (b < a) b = a;
      return { min: a, max: b };
    },

    /* The MixDurationPoses table (distance mix data) */
    _mixBag: function () {
      return Avatar.gesture && Avatar.gesture.emotionalGesture &&
             Avatar.gesture.emotionalGesture.MixDurationPoses;
    },

    _mixHashOk: function () {
      var bag = Avatar._mixBag();
      var src = Util.hashHex(bag && bag.sourceHash);
      var live = Util.hashHex(Avatar._skelHash);
      if (!src || !live) return false;
      if (src === live) return true;
      if (Util.swapHashHalves(src) === live) return true;
      if (src.slice(-live.length) === live || live.slice(-src.length) === src) return true;
      return false;
    },

    _hasPoseBones: function (name) {
      var poses = Avatar._mixBag() && Avatar._mixBag().animPoses;
      var p = poses && poses[name];
      if (!p) return false;
      var k;
      for (k in p) if (Object.prototype.hasOwnProperty.call(p, k) && p[k] && p[k].length >= 2) return true;
      return false;
    },

    _poseDist: function (fromName, toName) {
      var poses = Avatar._mixBag() && Avatar._mixBag().animPoses;
      var pa = poses && poses[fromName], pb = poses && poses[toName];
      if (!pa || !pb) return 0;
      var sum = 0, n = 0, bone, a, b, dx, dy;
      for (bone in pa) {
        if (!Object.prototype.hasOwnProperty.call(pa, bone)) continue;
        if (/control_|_IK|template_|aim_|roll_/i.test(bone)) continue;
        a = pa[bone]; b = pb[bone];
        if (!a || !b || a.length < 2 || b.length < 2) continue;
        dx = a[0] - b[0]; dy = a[1] - b[1];
        sum += Math.sqrt(dx * dx + dy * dy);
        n++;
      }
      return n ? sum / n : 0;
    },

    /* Idle↔idle. Distance mix only when MixDurationPoses.sourceHash matches
       the live skeleton hash; otherwise same-type short mix / cross-type random. */
    _mixBetween: function (fromName, toName, emotion) {
      var r = Avatar._mixRange(emotion);
      var sat = Number(Avatar._pc().mixDurationSaturationRatio);
      if (!(sat > 0)) sat = 0.1;
      var close = r.min * sat;
      if (!fromName || !toName || fromName === toName) return close;
      /* Gesture MixDurationPoses is shipped with this skel. Use bone distance
         when the table has both clips; hash match is preferred but not required. */
      if (Avatar._mixHashOk() ||
          (Avatar._hasPoseBones(fromName) && Avatar._hasPoseBones(toName))) {
        var dist = Avatar._poseDist(fromName, toName);
        var t = 1 - Math.exp(-(dist || 0) / 180);
        return close + t * (r.max - close);
      }
      var fromTypes = Avatar._poseTypesOf(fromName);
      var toTypes = Avatar._poseTypesOf(toName);
      var same = fromTypes.some(function (t) { return toTypes.indexOf(t) >= 0; });
      if (same) return close + Math.random() * (r.min * (1 - sat));
      return r.min + Math.random() * (r.max - r.min);
    },

    /* One-shots overlay the base idle (fixedBasePoseMode). Enter is the
       saturation mix; empty delay 0 so fade starts at clip end, not 0.2s in. */
    _overlayMix: function (emotion) {
      var r = Avatar._mixRange(emotion);
      var sat = Number(Avatar._pc().mixDurationSaturationRatio);
      if (!(sat > 0)) sat = 0.1;
      return r.min * sat;
    },

    _entryLive: function (tr) {
      if (!tr || !tr.animation) return false;
      if (/^<empty>/i.test(tr.animation.name || '')) return false;
      return tr.animation.duration > 0;
    },

    _oneShotBusy: function () {
      return Avatar._trackBusy(1) || Avatar._trackBusy(6);
    },

    _trackBusy: function (idx) {
      var st = Avatar.avatar && Avatar.avatar.state;
      var tr = st && st.getCurrent(idx);
      if (!tr) return false;
      if (Avatar._entryLive(tr)) return true;
      if (tr.mixingFrom && Avatar._entryLive(tr.mixingFrom)) return true;
      return false;
    },

    _idleName: function () {
      var tr = Avatar.avatar && Avatar.avatar.state && Avatar.avatar.state.getCurrent(0);
      return (tr && tr.animation && tr.animation.name) || '';
    },

    _sittingFromPosture: function () {
      var p = Avatar._loadedPosture() || '';
      if (/agura/i.test(p)) return 'sitting_agura';
      if (/stand/i.test(p)) return 'standing';
      return 'sitting_normal';
    },

    _restGroupId: function () {
      var cfg = Avatar._pc().armInOutPartConfig || {};
      var by = (cfg.idleGroupIds && cfg.idleGroupIds.byPosture) || {};
      return by[Avatar._sittingId] || by.default || '';
    },

    _weighted: function (items, weightOf) {
      return Util.weighted(items, weightOf);
    },

    _basePoses: function () {
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      return (inten && inten.basePoses) || [];
    },

    _animTypeMap: function () {
      if (Avatar._typeMap) return Avatar._typeMap;
      var map = {}, g = Avatar.gesture;
      var profiles = g && g.emotionalGesture && g.emotionalGesture.EmotionProfilesV4;
      var em, ip, k, poses, i, p;
      if (profiles) {
        for (em in profiles) {
          if (!Object.prototype.hasOwnProperty.call(profiles, em)) continue;
          ip = (profiles[em] && profiles[em].intensityProfiles) || {};
          for (k in ip) {
            if (!Object.prototype.hasOwnProperty.call(ip, k)) continue;
            poses = (ip[k] && ip[k].basePoses) || [];
            for (i = 0; i < poses.length; i++) {
              p = poses[i];
              if (p && p.id && p.poseTypeIds && p.poseTypeIds.length) map[p.id] = p.poseTypeIds;
            }
          }
        }
      }
      Avatar._typeMap = map;
      return map;
    },

    _poseTypesOf: function (animId) {
      var mapped = Avatar._animTypeMap()[animId];
      if (mapped && mapped.length) return mapped;
      var poses = Avatar._basePoses(), i, p;
      for (i = 0; i < poses.length; i++) {
        p = poses[i];
        if (p && p.id === animId && p.poseTypeIds && p.poseTypeIds.length) return p.poseTypeIds;
      }
      return ['posetype_01_freehand'];
    },

    _pickPoseType: function (prev) {
      var sets = (Avatar.gesture && Avatar.gesture.emotionalGesture &&
                  Avatar.gesture.emotionalGesture.PoseTypeSets) || [];
      var cand = sets.filter(function (s) { return s.previousId === prev; });
      if (!cand.length) return prev || 'posetype_01_freehand';
      var pick = Avatar._weighted(cand, function (s) { return Number(s.weight) || 0; });
      return (pick && pick.newId) || prev || 'posetype_01_freehand';
    },

    _typesOfPose: function (p) {
      if (p && p.poseTypeIds && p.poseTypeIds.length) return p.poseTypeIds;
      return (p && Avatar._animTypeMap()[p.id]) || [];
    },

    _idlesForType: function (data, poseType) {
      var sit = Avatar._sittingId || 'sitting_normal';
      var poses = Avatar._basePoses();
      function sitOk(p) {
        var sits = p && p.applicableSittingIds;
        if (sits && sits.length && sits.indexOf(sit) < 0) return false;
        return true;
      }
      var typed = poses.filter(function (p) {
        if (!p || !p.id || !pickAnim(data, p.id) || !sitOk(p)) return false;
        var ids = Avatar._typesOfPose(p);
        if (!poseType) return true;
        return ids.length > 0 && ids.indexOf(poseType) >= 0;
      }).map(function (p) {
        var w = Number(p.weight);
        return { name: pickAnim(data, p.id), w: w > 0 ? w : 1 };
      }).filter(function (x) { return !!x.name; });
      if (typed.length) return typed;
      if (poseType && poseType !== 'posetype_01_freehand') {
        return Avatar._idlesForType(data, 'posetype_01_freehand');
      }
      return FALLBACK_IDLE.map(function (n) {
        var hit = pickAnim(data, n);
        return hit ? { name: hit, w: 1 } : null;
      }).filter(Boolean);
    },

    _ioClip: function (data, activeName, phase) {
      if (!activeName) return null;
      /* The direction lives in armInOutPartConfig (gesture.json), not on the
         project root — read it where it is, keep old root lookup as a nod. */
      var root = Avatar._pc();
      var cfg = root.armInOutPartConfig || {};
      var dir = cfg.samePartDetourDirection || root.samePartDetourDirection || 'up';
      var base = String(activeName).replace(/_active$/, '');
      return pickAnim(data, base + '_' + phase + '_' + dir) ||
             pickAnim(data, base + '_' + phase + '_up') ||
             pickAnim(data, base + '_' + phase + '_down');
    },

    _motionGroups: function () {
      return (Avatar.gesture && Avatar.gesture.emotionalGesture &&
              Avatar.gesture.emotionalGesture.MotionGroups) || [];
    },

    _groupApplies: function (g, idleName) {
      if (!g) return false;
      var sit = Avatar._sittingId || 'sitting_normal';
      if (g.ApplicableSittingIDs) {
        var sits = String(g.ApplicableSittingIDs).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        if (sits.length && sits.indexOf(sit) < 0) return false;
      }
      if (!g.ApplicablePoseIds) return true;
      var ids = String(g.ApplicablePoseIds).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      return !ids.length || ids.indexOf(idleName) >= 0;
    },

    _occKind: function (g) {
      var o = String((g && g.OccupancyLetters) || '').toUpperCase().replace(/[^A-Z]/g, '');
      if (o === 'I') return 'legL';
      if (o === 'J') return 'legR';
      if (o === 'C') return 'leg';
      if (o === 'FG' || o === 'GF' || o === 'B' || /[BFG]/.test(o)) return 'arm';
      if (o.indexOf('E') >= 0 || o.indexOf('H') >= 0) return 'torso';
      return '';
    },

    /* Lookup by GroupId. The runtime reaches groups through _pickLayerGroup
       (weighted, posture/pose filtered); this direct lookup exists for
       scripts/motion_regression.js, which asserts the occupancy-letter → track
       mapping straight from the data. */
    _findGroup: function (id) {
      if (!id) return null;
      var list = Avatar._motionGroups(), i;
      for (i = 0; i < list.length; i++) if (list[i].GroupId === id) return list[i];
      return null;
    },

    _layerTracks: function (kind) {
      if (kind === 'torso') return [11, 12];
      if (kind === 'leg') return [13, 14];
      if (kind === 'legL') return [13];
      if (kind === 'legR') return [14];
      return [8, 9];
    },

    _layerGet: function (kind) {
      if (kind === 'torso') return Avatar._torsoG;
      if (kind === 'leg') return Avatar._legG;
      if (kind === 'legL') return Avatar._legLG;
      if (kind === 'legR') return Avatar._legRG;
      return Avatar._armG;
    },

    _layerSet: function (kind, g) {
      if (kind === 'torso') Avatar._torsoG = g || null;
      else if (kind === 'leg') Avatar._legG = g || null;
      else if (kind === 'legL') Avatar._legLG = g || null;
      else if (kind === 'legR') Avatar._legRG = g || null;
      else Avatar._armG = g || null;
    },

    _sameAnims: function (a, b) {
      if (!a && !b) return true;
      if (!a || !b) return false;
      return (a.AnimName_1 || '') === (b.AnimName_1 || '') &&
             (a.AnimName_2 || '') === (b.AnimName_2 || '');
    },

    _rankBlend: function (prev, next) {
      var fallback = Number(next && next.BlendTime); if (!(fallback > 0)) fallback = 0.6;
      var cfg = Avatar._pc().armInOutPartConfig || {};
      var by = cfg.byGroupId || {};
      var pos = cfg.rankPositions || {};
      function rp(gid, side) {
        var rec = by[gid], r = rec && rec[side];
        if (r == null) return 0;
        var p = pos[String(r)];
        return Number(p) || 0;
      }
      var nid = next && next.GroupId, pid = prev && prev.GroupId;
      if (!nid || !by[nid]) return fallback;
      var dist = Math.max(
        Math.abs(rp(nid, 'left') - rp(pid, 'left')),
        Math.abs(rp(nid, 'right') - rp(pid, 'right'))
      );
      var lo = Number(cfg.minSeconds); if (!(lo > 0)) lo = 0.4;
      var hi = Number(cfg.maxSeconds); if (!(hi > lo)) hi = 1;
      var ref = Number(cfg.pairStartDelayReferenceDistance); if (!(ref > 0)) ref = 0.35;
      return lo + Math.min(1, dist / ref) * (hi - lo);
    },

    _layerWeightOk: function (kind, g, poseType) {
      if (!g) return false;
      if (kind === 'arm') {
        var w = Number(Avatar._armWeights(poseType)[g.GroupId]);
        return w > 0 || g.GroupId === Avatar._restGroupId();
      }
      if (kind === 'torso') return Number(Avatar._torsoWeights(poseType)[g.GroupId]) > 0;
      return (Number(g.GroupWeight) || 0) > 0 || (Number(g.VariantWeight) || 0) > 0;
    },

    _tensionRate: function (band) {
      var tc = Avatar._pc().tensionConfig || {};
      var dr = tc.decayRates || {};
      var v = Number(dr[band]);
      if (!(v > 0)) v = Number(tc.defaultDecayRate);
      if (!(v > 0)) v = 0.02;
      return Util.clamp(v, 0.002, 0.5);
    },

    _tensionBand: function () {
      var v = Avatar._tension;
      return v > 0.66 ? 'high' : (v > 0.33 ? 'mid' : 'low');
    },

    _tensionBag: function () {
      var prof = Avatar._profile(Avatar._emotion);
      var tps = prof && prof.tensionProfiles;
      if (!tps) return null;
      var band = Avatar._tensionBand();
      if (!tps[band]) band = tps.low ? 'low' : (tps.high ? 'high' : 'mid');
      return tps[band] || tps.low || tps.high || null;
    },

    _armWeights: function (poseType) {
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      var by = (inten && inten.armGroupWeightsByPoseType) || {};
      return by[poseType] || by[''] || (inten && inten.armGroupWeights) || {};
    },

    _torsoWeights: function (poseType) {
      var bag = Avatar._tensionBag();
      if (!bag) return {};
      var by = bag.torsoWaistGroupWeightsByPoseType;
      if (by) return by[poseType] || by[''] || bag.torsoWaistGroupWeights || {};
      return bag.torsoWaistGroupWeights || {};
    },

    _pickLayerGroup: function (kind, idleName, poseType, preferRest) {
      var restId = kind === 'arm' ? Avatar._restGroupId() : '';
      var data0 = Avatar.avatar && Avatar.avatar.data;
      function resolvable(g) {
        if (!data0) return true;
        return !!(pickAnim(data0, g.AnimName_1) || pickAnim(data0, g.AnimName_2));
      }
      if (preferRest && restId) {
        var rest = Avatar._motionGroups().filter(function (g) {
          return g.GroupId === restId && Avatar._occKind(g) === kind &&
                 Avatar._groupApplies(g, idleName) && resolvable(g);
        });
        if (rest.length) {
          return Avatar._weighted(rest, function (g) { return Number(g.VariantWeight) || 1; });
        }
      }
      var weights = kind === 'torso' ? Avatar._torsoWeights(poseType)
                  : kind === 'leg' ? null
                  : Avatar._armWeights(poseType);
      var groups = Avatar._motionGroups().filter(function (g) {
        if (Avatar._occKind(g) !== kind || !Avatar._groupApplies(g, idleName)) return false;
        /* Some authored groups reference clips the animator retired
           (…_active_ignore); playing those tracks would silently drop the
           limb to the base pose. Only groups with a resolvable clip can win. */
        if (!resolvable(g)) return false;
        if (weights) return Number(weights[g.GroupId]) > 0;
        return (Number(g.GroupWeight) || 0) > 0;
      });
      var pick = Avatar._weighted(groups, function (g) {
        var w = weights ? (Number(weights[g.GroupId]) || 0) : (Number(g.GroupWeight) || 0);
        return w * (Number(g.VariantWeight) || 1);
      });
      if (pick) return pick;
      if (restId) {
        return Avatar._motionGroups().filter(function (g) {
          return g.GroupId === restId && Avatar._occKind(g) === kind && resolvable(g);
        })[0] || null;
      }
      return null;
    },

    _stampAdd: function (tr, mix, alpha, speed) {
      if (!tr) return;
      tr.mixDuration = mix;
      tr.alpha = alpha;
      tr.timeScale = speed;
      /* Occupancy clips key full limb poses; MixBlend.add on those
         doubles the bind pose and shoots the arms into pillars. */
      if (spine.MixBlend) tr.mixBlend = spine.MixBlend.replace;
    },

    _queueAddTrack: function (track, activeName, alpha, speed, blend, leaving, startDelay) {
      var L = Avatar.avatar, data = L.data, st = L.state;
      var act = pickAnim(data, activeName);
      var route = Avatar._pc().enableArmInOutRouting !== false;
      var inn = route ? Avatar._ioClip(data, activeName, 'in') : null;
      var out = (route && leaving) ? Avatar._ioClip(data, leaving, 'out') : null;
      var mix = Number(blend); if (!(mix > 0)) mix = 0.6;
      var a = parseFloat(alpha); if (!(a > 0)) a = 1;
      var ts = parseFloat(speed); if (!(ts > 0)) ts = 1;
      var delay = Number(startDelay) > 0 ? Number(startDelay) : 0;
      var cur = st.getCurrent(track);
      /* Pair delay must keep the previous limb clip applying. Empty mix=0
         snaps to setup; addAnimation() on a looping current never starts. */
      var hold = delay > 0 && Avatar._entryLive(cur);

      function enqueue(name, loop, first) {
        var tr;
        if (first && hold) {
          cur.loop = false;
          cur.trackEnd = cur.trackTime + delay;
          tr = st.addAnimation(track, name, loop, 0);
        } else if (first) {
          tr = st.setAnimation(track, name, loop);
        } else {
          tr = st.addAnimation(track, name, loop, 0);
        }
        Avatar._stampAdd(tr, mix, a, ts);
        return tr;
      }

      if (out) {
        enqueue(out, false, true);
        if (inn) enqueue(inn, false, false);
        if (act) enqueue(act, true, false);
        else st.addEmptyAnimation(track, mix, 0);
        return;
      }
      if (inn) {
        enqueue(inn, false, true);
        if (act) enqueue(act, true, false);
        return;
      }
      if (act) {
        enqueue(act, true, true);
        return;
      }
      if (hold) {
        cur.loop = false;
        cur.trackEnd = cur.trackTime + delay;
        st.addEmptyAnimation(track, mix, 0);
      } else {
        st.setEmptyAnimation(track, mix);
      }
    },

    _pairDelay: function () {
      var cfg = Avatar._pc().armInOutPartConfig || {};
      var lo = Number(cfg.pairStartDelayMinSeconds);
      var hi = Number(cfg.pairStartDelayMaxSeconds);
      if (!(lo > 0)) lo = 0.2;
      if (!(hi > lo)) hi = lo + 0.15;
      return lo + Math.random() * (hi - lo);
    },

    _applyLayer: function (tracks, group, prev, immediate) {
      var L = Avatar.avatar;
      var t0 = tracks[0], t1 = tracks.length > 1 ? tracks[1] : null;
      if (!group) {
        L.state.setEmptyAnimation(t0, immediate ? 0 : 0.45);
        if (t1 != null) L.state.setEmptyAnimation(t1, immediate ? 0 : 0.45);
        return;
      }
      if (!immediate && Avatar._sameAnims(prev, group)) return;
      var leaving1 = null, leaving2 = null;
      if (prev && prev.GroupId !== group.GroupId) {
        leaving1 = prev.AnimName_1; leaving2 = prev.AnimName_2;
      }
      var blend = immediate ? 0 : Avatar._rankBlend(prev, group);
      Avatar._queueAddTrack(t0, group.AnimName_1, group.Alpha1, group.Speed1, blend, leaving1, 0);
      if (t1 == null) return;
      if (group.AnimName_2) {
        Avatar._queueAddTrack(t1, group.AnimName_2, group.Alpha2 || group.Alpha1,
                              group.Speed2 || group.Speed1, blend, leaving2, immediate ? 0 : Avatar._pairDelay());
      } else {
        L.state.setEmptyAnimation(t1, immediate ? 0 : blend);
      }
    },

    _ADD_TRACKS: [8, 9, 11, 12, 13, 14],

    _muteAdditives: function (on) {
      var L = Avatar.avatar;
      if (!L || !L.state) return;
      if (!!on === !!Avatar._addMuted) return;
      Avatar._addMuted = !!on;
      if (on) {
        Avatar._mutedSnap = {
          arm: Avatar._armG, torso: Avatar._torsoG, leg: Avatar._legG,
          legL: Avatar._legLG, legR: Avatar._legRG
        };
        Avatar._ADD_TRACKS.forEach(function (t) { L.state.setEmptyAnimation(t, 0.18); });
        return;
      }
      var snap = Avatar._mutedSnap; Avatar._mutedSnap = null;
      function restore(kind) {
        var g = snap && snap[kind];
        if (g && Avatar._groupApplies(g, Avatar._idleName())) {
          Avatar._applyLayer(Avatar._layerTracks(kind), g, null, false);
          Avatar._layerSet(kind, g);
          return g;
        }
        Avatar._layerSet(kind, null);
        return null;
      }
      restore('arm');
      restore('torso');
      if (restore('leg')) {
        Avatar._layerSet('legL', null);
        Avatar._layerSet('legR', null);
      } else {
        restore('legL');
        restore('legR');
      }
      if (!Avatar._armG && !Avatar._torsoG && !Avatar._legG && !Avatar._legLG && !Avatar._legRG) {
        Avatar._syncAdditives(Avatar._idleName(), Avatar._poseType, false, false, false);
      }
    },

    _syncAdditives: function (idleName, poseType, immediate, preferRest, keepIfOk) {
      var L = Avatar.avatar;
      if (!L || !L.state || Avatar._addMuted) return;
      function syncKind(kind, rest) {
        var cur = Avatar._layerGet(kind);
        var pick = null;
        if (keepIfOk && cur && Avatar._occKind(cur) === kind &&
            Avatar._groupApplies(cur, idleName) && Avatar._layerWeightOk(kind, cur, poseType)) {
          pick = cur;
        } else {
          pick = Avatar._pickLayerGroup(kind, idleName, poseType, rest);
        }
        if (pick !== cur || immediate) {
          Avatar._applyLayer(Avatar._layerTracks(kind), pick, cur, immediate);
          Avatar._layerSet(kind, pick);
        }
        return pick;
      }
      syncKind('arm', preferRest);
      syncKind('torso', false);
      /* C (both legs) excludes I/J (left/right). */
      var both = syncKind('leg', false);
      if (both) {
        Avatar._layerSet('legL', null);
        Avatar._layerSet('legR', null);
      } else {
        syncKind('legL', false);
        syncKind('legR', false);
      }
    },

    _playWind: function () {
      var L = Avatar.avatar;
      if (!L || !L.data || !L.state) return;
      var prefix = Avatar._pc().windAnimationPrefix || 'effect_wind';
      var anims = L.data.animations || [], i, name = null;
      for (i = 0; i < anims.length; i++) {
        if (anims[i].name && anims[i].name.indexOf(prefix) === 0) { name = anims[i].name; break; }
      }
      if (!name) return;
      var tr = L.state.setAnimation(10, name, true);
      tr.mixDuration = 0.4;
      if (spine.MixBlend) tr.mixBlend = spine.MixBlend.add;
    },

    _pickExpr: function () {
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      var sets = (inten && inten.expressionSets) || [];
      if (!sets.length) return {
        eyeOpen: inten && inten.eyeBase, eyeClosed: null,
        eyebrow: inten && inten.eyebrowBase, mouth: inten && inten.mouthBase
      };
      /* weight is OPTIONAL in the data (absent = 1); an explicit 0 is the
         author switching a face off — 18 of the 30 standing happy/weak sets
         and half of tease/weak are. Never fall back to a disabled set: with
         nothing live, _applyFace uses the band's eye/eyebrow/mouthBase. */
      var live = sets.filter(function (s) {
        return s.weight == null || Number(s.weight) > 0;
      });
      if (!live.length) return null;
      return Avatar._weighted(live, function (s) {
        return Number(s.weight) > 0 ? Number(s.weight) : 1;
      });
    },

    _pc: function () {
      return (Avatar.gesture && Avatar.gesture.projectConfig) || {};
    },

    _effectNames: function () {
      /* Memo per (emotion, band): setEmotion + setTalking both fire _syncFx
         in the same reply; without the memo the blush/tear set re-rolled
         twice per utterance (visible FX churn). */
      var memoKey = Avatar._emotion + '|' + Avatar._intensityBand();
      if (Avatar._fxPick && Avatar._fxPick.key === memoKey) return Avatar._fxPick.names;
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      var sets = (inten && inten.effectSets) || [];
      var live = sets.filter(function (s) {
        var n = (s && s.names) || [];
        if (!n.length) return false;
        return s.weight == null || Number(s.weight) > 0;
      });
      var pick = Avatar._weighted(live, function (s) {
        return Number(s.weight) > 0 ? Number(s.weight) : 1;
      });
      var names = pick ? ((pick.names || []).slice()) : [];
      Avatar._fxPick = { key: memoKey, names: names };
      return names;
    },

    _hideFxSlots: function (keepOn) {
      var sk = Avatar.avatar && Avatar.avatar.skeleton;
      if (!sk || !sk.slots) return;
      var i, slot, n;
      for (i = 0; i < sk.slots.length; i++) {
        slot = sk.slots[i];
        n = slot.data && slot.data.name || '';
        /* Setup Multiply highlights (cheek_line / nose_hi) blow out under
           straight-alpha. Overlay blush/pale/tear stay visible when FX is on. */
        if (/nose_hi|cheek_line/.test(n)) {
          slot.setAttachment(null);
          continue;
        }
        if (!keepOn && /face_cheek|face_pale|face_tear|face_sweat|mouth_drool/.test(n)) {
          slot.setAttachment(null);
        }
      }
    },

    /* Setup pose keeps cheek_line / nose_hi attached. Empty mix on track 5
       returns to that pose, so OFF clips must be held and slots cleared. */
    _syncFx: function (immediate) {
      var L = Avatar.avatar;
      if (!L || !L.ready || !L.state) return;
      var names = Avatar._effectNames();
      var key = names.slice().sort().join(',');
      if (key === Avatar._fxKey && !immediate) return;
      Avatar._fxKey = key;
      var pc = Avatar._pc();
      var onMap = pc.fxOnAnimNames || {};
      var offMap = pc.fxOffAnimNames || {};
      var st = L.state, data = L.data, mix = immediate ? 0 : 0.28, clip, tr, i;

      if (!names.length) {
        Avatar._fxOn = false;
        clip = pickAnim(data, offMap.blush001) || pickAnim(data, 'facial_add_blush_000_off');
        if (clip) {
          tr = st.setAnimation(5, clip, false);
          tr.mixDuration = mix;
        } else {
          st.setEmptyAnimation(5, mix);
        }
        st.setEmptyAnimation(7, mix);
        st.setEmptyAnimation(15, mix);
        st.setEmptyAnimation(16, mix);
        Avatar._hideFxSlots();
        return;
      }

      Avatar._fxOn = true;
      clip = pickAnim(data, onMap[names[0]] || names[0]);
      if (clip) {
        tr = st.setAnimation(5, clip, true);
        tr.mixDuration = mix;
      } else {
        st.setEmptyAnimation(5, mix);
      }
      /* Extra names in the same set (blush + tear) go on 7, 15, 16. */
      var extra = [7, 15, 16];
      for (i = 1; i < names.length && i - 1 < extra.length; i++) {
        clip = pickAnim(data, onMap[names[i]] || names[i]);
        if (clip) st.setAnimation(extra[i - 1], clip, true).mixDuration = mix;
        else st.setEmptyAnimation(extra[i - 1], mix);
      }
      for (; i - 1 < extra.length; i++) st.setEmptyAnimation(extra[i - 1], mix);
    },

    _animTimeScale: function () {
      var prof = Avatar._profile(Avatar._emotion);
      var ts = (prof && Number(prof.baseAnimTimeScale)) || 1;
      var perf = Avatar.gesture && Avatar.gesture.emotionalGesture &&
                 Avatar.gesture.emotionalGesture.performanceConfig;
      var mul = perf && perf.intensitySpeedMultipliers;
      if (mul) {
        var band = Avatar._intensityBand();
        if (band !== 'normal' && Number(mul[band]) > 0) ts *= Number(mul[band]);
      }
      return ts;
    },

    _rerollIdle: function () {
      var L = Avatar.avatar;
      if (!L || !L.ready || !L.state) return;
      var cur = L.state.getCurrent(0);
      if (cur && cur.mixingFrom) return;
      if (Avatar._oneShotBusy()) return;
      var mixingLayer = Avatar._ADD_TRACKS.some(function (t) {
        var tr = L.state.getCurrent(t);
        return tr && tr.mixingFrom;
      });
      if (mixingLayer) return;
      var fromName = cur && cur.animation && cur.animation.name;
      var prevType = Avatar._poseType || (fromName && Avatar._poseTypesOf(fromName)[0]) || 'posetype_01_freehand';
      var nextType = Avatar._pickPoseType(prevType);
      var idle = Avatar._idlesForType(L.data, nextType);
      if (!idle.length) {
        idle = Avatar._idlesForType(L.data, 'posetype_01_freehand');
        nextType = 'posetype_01_freehand';
      }
      if (!idle.length) { Avatar._idleTimer = 0; return; }
      var pickIdle = Util.weighted(idle, function (x) { return x.w; });
      var name = pickIdle ? pickIdle.name : null;
      if (!name) { Avatar._idleTimer = 0; return; }
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      var a = (inten && inten.poseRerollIntervalMin) || 5;
      var b = (inten && inten.poseRerollIntervalMax) || 8;
      Avatar._idleGap = a + Math.random() * Math.max(0, b - a);
      Avatar._idleTimer = 0;
      Avatar._poseType = nextType;
      /* Periodic expression re-roll. The AOT snapshot carries the symbol
         IntensitySettings.ExpressionRerollMin (and expressionRerollInterval
         Min/Max as profile fields), but the shipped JSON leaves them out, so
         the pose-reroll tick is the only cadence we can read from the pack.
         Without it the face was only ever re-rolled on an emotion change or a
         band flip, which is why the ASMR-only mouth shapes in
         intensityProfiles.weak (facial_mouth_010 / _015) practically never
         appeared. Never mid-speech: that would cut a lip-synced line. */
      if (!Avatar._talking) Avatar._applyFace(false);
      var keep = nextType === prevType;
      if (fromName === name) {
        if (!keep) Avatar._syncAdditives(name, nextType, false, false, false);
        return;
      }
      var mix = Avatar._mixBetween(fromName, name, Avatar._emotion);
      var tr = L.state.setAnimation(0, name, true);
      tr.mixDuration = mix;
      tr.timeScale = Avatar._animTimeScale();
      Avatar._syncAdditives(name, nextType, false, false, keep);
    },

    _driverSpec: function (id) {
      if (!Avatar._drivers) {
        Avatar._drivers = {};
        var defs = (Avatar.gesture && Avatar.gesture.emotionalGesture &&
                    Avatar.gesture.emotionalGesture.DriverDefs) || [];
        defs.forEach(function (d) {
          try { Avatar._drivers[d.Id] = JSON.parse(d.Spec); } catch (e) {}
        });
      }
      return id ? Avatar._drivers[id] : null;
    },

    _pickLook: function () {
      var prof = Avatar._profile(Avatar._emotion);
      var tps = prof && prof.tensionProfiles;
      var band = Avatar._tensionBand();
      if (tps && !tps[band]) band = tps.low ? 'low' : 'high';
      else if (!tps) band = null;
      var bindings = (band && tps[band] && tps[band].ambientBindings) || [];
      /* Source cycles ambientBindings by (emotion, band) with per-binding
         repeatMin/repeatMax: the same head/eye pattern plays N times before
         a new driver is rolled. Keep the pattern within a band; when the
         band changes (talk start/stop) start a new pattern cleanly. */
      var spec = null, i, hit = null;
      var cyc = Avatar._lookCyc;
      if (cyc && cyc.band === band && cyc.left > 0 && cyc.spec) {
        cyc.left--;
        spec = cyc.spec;
      } else {
        var cand = bindings.filter(function (x) { return (x.weight || 0) > 0; });
        hit = Util.weighted(cand.length ? cand : bindings, function (x) { return x.weight || 0; });
        spec = hit ? Avatar._driverSpec(hit.driverDefId) : null;
        var lo = Math.round(Number(hit && hit.repeatMin) || 1);
        var hi = Math.round(Number(hit && hit.repeatMax) || lo);
        if (!(lo > 0)) lo = 1;
        if (hi < lo) hi = lo;
        Avatar._lookCyc = {
          band: band, spec: spec,
          left: lo + Math.floor(Math.random() * (hi - lo + 1)) - 1
        };
      }
      if (!spec && bindings.length) spec = Avatar._driverSpec(bindings[0].driverDefId);
      var look = Avatar._look;
      look.fromY = look.yaw; look.fromP = look.pitch; look.fromR = look.roll;
      look.t = 0;
      if (!spec) {
        look.ty = 0; look.tp = 0; look.tr = 0;
        look.trans = 0.8; look.hold = 2;
        return;
      }
      function rnd(a, b) {
        a = Number(a) || 0; b = Number(b) || 0;
        return a + Math.random() * (b - a);
      }
      var isEyeDrv = spec.driver === 'eye';
      /* 78 of 98 drivers are lookAtUser — their yaw/pitch windows straddle
         0 (front, i.e. at the player), so the random pick already reads as
         "looking at you". Keep the window as authored. */
      look.ty = rnd(spec.yawMin, spec.yawMax);
      look.tp = rnd(spec.pitchMin, spec.pitchMax);
      look.tr = rnd(spec.rollMin, spec.rollMax);
      look.trans = Math.max(0.05, rnd(spec.transitionMin, spec.transitionMax));
      look.hold = Math.max(0.2, rnd(spec.holdMin, spec.holdMax));
      look.followers = spec.followers || [];
      look.eyeDrv = isEyeDrv;
    },

    _bindPointer: function () {
      var hit = document.getElementById('avatar-hit');
      if (!hit || hit._lookBound) return;
      hit._lookBound = true;
      var on = function (ev) {
        var rect = hit.getBoundingClientRect();
        var z = Avatar._cssZoom(hit);
        Avatar._pointer.x = (ev.clientX - rect.left) / z;
        Avatar._pointer.y = (ev.clientY - rect.top) / z;
        Avatar._pointer.on = true;
      };
      hit.addEventListener('pointerdown', on);
      hit.addEventListener('pointermove', on);
      hit.addEventListener('pointerleave', function () { Avatar._pointer.on = false; });
    },

    _updateLook: function (dt) {
      var look = Avatar._look;
      look.t += dt;
      if (look.t > look.trans + look.hold) Avatar._pickLook();
      var u = look.trans > 0 ? Math.min(1, look.t / look.trans) : 1;
      u = u * u * (3 - 2 * u);
      look.yaw = (look.fromY || 0) + ((look.ty || 0) - (look.fromY || 0)) * u;
      look.pitch = (look.fromP || 0) + ((look.tp || 0) - (look.fromP || 0)) * u;
      look.roll = (look.fromR || 0) + ((look.tr || 0) - (look.fromR || 0)) * u;
      /* DriverDefs rollFollowSpeed: head roll trails the yaw/pitch step with
         its own exponential follow — the lag is what reads as "alive" neck
         motion instead of a rigid whole-head swipe. */
      var cyc = Avatar._lookCyc;
      var rfs = (cyc && cyc.spec && Number(cyc.spec.rollFollowSpeed)) || 5;
      if (!(rfs > 0)) rfs = 5;
      Avatar._rollSm += (look.roll - Avatar._rollSm) * (1 - Math.exp(-dt * rfs));

      Avatar._lookClock += dt;
      Avatar._lookHist.push({ t: Avatar._lookClock, y: look.yaw, p: look.pitch, r: Avatar._rollSm });
      while (Avatar._lookHist.length > 1 && Avatar._lookHist[0].t < Avatar._lookClock - 2.8) {
        Avatar._lookHist.shift();
      }
      /* wantMul: suppress the look system while a one-shot owns the aim
         bones. Two exits used to be visibly separate beats: the 0.15→1.0
         recovery started only after the reaction had fully drained, and its
         tau was shorter than everything else's — so after the 0.3 s exit
         fade had already settled, the head chased the (still hovering)
         cursor ONE MORE TIME. Now it starts at the same 60 % point of the
         exit fade as the limb un-mute, and recovers slower (0.3 s), so all
         exit quantities converge as a single motion. */
      var wantMul = (Avatar._oneShotBusy() && !Avatar._pokeUnmuteReady()) ? 0.15 : 1;
      var mulTau = wantMul > Avatar._lookMul ? 0.3 : 0.18;
      Avatar._lookMul += (wantMul - Avatar._lookMul) * (1 - Math.exp(-dt / mulTau));

      var pc = Avatar._pc();
      var w = Avatar.screenToWorld(Avatar._pointer.x, Avatar._pointer.y);
      var k = 1 - Math.exp(-dt / Math.max(0.02, Number(pc.fingerTrackDelay) || 0.1));
      if (Avatar._pointer.on) {
        if (!Avatar._ptrInit) {
          /* Seed the smoothed point at the FACE, not at the raw cursor:
             the offset starts at 0 and eases toward the pointer, so a
             cursor that appears mid-canvas glides in instead of teleporting
             the eye/head IK targets (the "occasional twitch"). */
          var sk = Avatar.avatar && Avatar.avatar.skeleton;
          var fb = sk && (sk.findBone(pc.fingerTrackCenterBone || 'rig_face') ||
                         sk.findBone('head'));
          if (fb) {
            Avatar._ptrSm.x = fb.worldX;
            Avatar._ptrSm.y = fb.worldY;
            Avatar._ptrN = 0;
          } else {
            Avatar._ptrSm.x = w.x;
            Avatar._ptrSm.y = w.y;
          }
          Avatar._ptrInit = true;
        } else {
          Avatar._ptrSm.x += (w.x - Avatar._ptrSm.x) * k;
          Avatar._ptrSm.y += (w.y - Avatar._ptrSm.y) * k;
        }
      } else {
        Avatar._ptrInit = false;
      }
    },

    _lookAt: function (delay) {
      var want = Avatar._lookClock - (Number(delay) || 0);
      var h = Avatar._lookHist;
      if (!h.length) return { y: Avatar._look.yaw, p: Avatar._look.pitch, r: Avatar._look.roll };
      var i;
      for (i = h.length - 1; i >= 0; i--) {
        if (h[i].t <= want) return { y: h[i].y, p: h[i].p, r: h[i].r };
      }
      return { y: h[0].y, p: h[0].p, r: h[0].r };
    },

    _boneOf: function (kind, part) {
      var rig = Avatar.gesture && Avatar.gesture.rigConfig;
      var slots = rig && rig[kind];
      var name = slots && slots[part] && slots[part].bone;
      var sk = Avatar.avatar.skeleton;
      return sk.findBone(name || ('control_' + (kind === 'aimSlots' ? 'aim_' : 'roll_') + part));
    },

    /* smooth gate for fingerTrack thresholds (see _applyLook) */
    _ptrRamp: function (n, thr, sc) {
      var lo = thr * 0.6, hi = thr * 1.4;
      if (!(hi > lo) || n <= lo) return 0;
      if (n >= hi) return sc;
      var u = (n - lo) / (hi - lo);
      return sc * (u * u * (3 - 2 * u));
    },

    _applyLook: function () {
      var L = Avatar.avatar;
      if (!L || !L.skeleton) return;
      var pc = Avatar._pc();
      var look = Avatar._look;
      var yaw = look.yaw, pitch = look.pitch, roll = Avatar._rollSm;
      var mul = Avatar._lookMul;
      yaw *= mul; pitch *= mul; roll *= mul;
      var fEyeX = 0, fEyeY = 0, fHeadX = 0, fHeadY = 0, fBodyX = 0, fBodyY = 0;
      var maxR = Number(pc.fingerTrackMaxRange) || 514;
      var on = Avatar._pointer.on;
      /* gazeReturnToFront (source config): pointer influence must ENTER and
         EXIT over 0.4–0.8 s, scaled by distance. Before this, fEye/fHead/
         fBody snapped to the full pointer offset the frame the cursor hit
         #avatar-hit and to 0 the frame it left — a one-frame teleport of the
         eye/head IK targets. That is the reported "偶发性抽动". */
      var gr = pc.gazeReturnToFront || {};
      var gcfg = on ? (gr.entry || {}) : (gr.exit || {});
      var gmn = Number(gcfg.minSeconds); if (!(gmn > 0)) gmn = 0.4;
      var gmx = Number(gcfg.maxSeconds); if (!(gmx >= gmn)) gmx = Math.max(gmn, 0.8);
      var gsp = Number(gcfg.secondsPerDistance); if (!(gsp > 0)) gsp = 0.8;
      if (on) {
        var face = L.skeleton.findBone(pc.fingerTrackCenterBone || 'rig_face') ||
                   L.skeleton.findBone('head');
        if (face) {
          /* While a one-shot owns the head, the face bone is dragged far from
             idle by the reaction clip. Measuring the cursor against that
             moving bone made the pointer offset swing with the gesture and
             snap back at the end — a second bounce riding on top of the exit
             fade (the "点击反应↔注视打架" suspect). Freeze the reference at
             the last pre-gesture position; after the drain, live tracking
             resumes within a few units of the same point. */
          var fx, fy;
          if (Avatar._oneShotBusy()) {
            if (!Avatar._faceRef) Avatar._faceRef = { x: face.worldX, y: face.worldY };
            fx = Avatar._faceRef.x; fy = Avatar._faceRef.y;
          } else {
            Avatar._faceRef = { x: face.worldX, y: face.worldY };
            fx = face.worldX; fy = face.worldY;
          }
          var dx = Avatar._ptrSm.x - fx;
          var dy = Avatar._ptrSm.y - fy;
          var dist = Math.sqrt(dx * dx + dy * dy);
          var n = maxR > 0 ? dist / maxR : 0;
          if (n > 1) { dx /= n; dy /= n; n = 1; }
          Avatar._ptrN = n;
          fEyeX = dx; fEyeY = dy;
          /* fingerTrackHead/BodyThreshold are gates in the data, but a hard
             0→scale switch snapped the head target ~40 units and the body
             target ~85 units in one frame whenever the cursor crossed the
             ring — the reported "特定位置卡模型/重影". Ramp each contribution
             smoothly across a ±40% window around its threshold instead. */
          fHeadX = dx * Avatar._ptrRamp(n, Number(pc.fingerTrackHeadThreshold) || 0.11,
                                        Number(pc.fingerTrackHeadScale) || 0.7);
          fHeadY = dy * Avatar._ptrRamp(n, Number(pc.fingerTrackHeadThreshold) || 0.11,
                                        Number(pc.fingerTrackHeadScale) || 0.7);
          fBodyX = dx * Avatar._ptrRamp(n, Number(pc.fingerTrackBodyThreshold) || 0.3,
                                        Number(pc.fingerTrackBodyScale) || 0.55);
          fBodyY = dy * Avatar._ptrRamp(n, Number(pc.fingerTrackBodyThreshold) || 0.3,
                                        Number(pc.fingerTrackBodyScale) || 0.55);
        }
      }
      var wantPtr = on ? 1 : 0;
      var sec = Util.clamp(gsp * Math.max(0.25, Avatar._ptrN), gmn, gmx);
      var dtL = Avatar._dt > 0 ? Avatar._dt : 0.016;
      Avatar._ptrW += (wantPtr - Avatar._ptrW) * (1 - Math.exp(-dtL / sec));
      if (!on && Avatar._ptrW < 0.004) Avatar._ptrW = 0;
      fEyeX *= Avatar._ptrW; fEyeY *= Avatar._ptrW;
      fHeadX *= Avatar._ptrW; fHeadY *= Avatar._ptrW;
      /* A one-shot (track 1) owns the aim bones during the gesture — the
         finger term must shrink with the ambient look (_lookMul 0.15) or the
         head fights between the gesture pose and the cursor. */
      fEyeX *= mul; fEyeY *= mul;
      fHeadX *= mul; fHeadY *= mul;
      fBodyX *= mul; fBodyY *= mul;
      fBodyX *= Avatar._ptrW; fBodyY *= Avatar._ptrW;
      var unit = 110;
      var bodyScale = 0.55, neckScale = 0.55, bodyDelay = 0, neckDelay = 0, headDelay = 0;
      (look.followers || []).forEach(function (f) {
        if (!f) return;
        var sc = Number(f.scale);
        if (f.part === 'body') {
          bodyScale = (sc || sc === 0) ? sc : 0.55;
          bodyDelay = Number(f.delay) || 0;
        }
        if (f.part === 'neck') {
          neckScale = (sc || sc === 0) ? sc : 0.55;
          neckDelay = Number(f.delay) || 0;
        }
        if (f.part === 'head') headDelay = Number(f.delay) || 0;
      });
      var headL = Avatar._lookAt(headDelay);
      var bodyL = Avatar._lookAt(bodyDelay);
      var neckL = Avatar._lookAt(neckDelay);
      function scaleLook(s, m) { return { y: s.y * m, p: s.p * m, r: s.r * m }; }
      headL = scaleLook(headL, mul);
      bodyL = scaleLook(bodyL, mul);
      neckL = scaleLook(neckL, mul);

      /* driver:'eye' patterns move the eye targets fully and barely tilt
         the head; driver:'head' patterns lead with head + body followers.
         The authored aim-bone deltas are tiny (±7–20 units), so keep the
         rad→world scale modest. */
      var eyeDrv = !!look.eyeDrv;
      var eyeK = eyeDrv ? 0.18 : 0.35;
      var headK = eyeDrv ? 0.18 : 1;

      /* Targets first, then ONE eased application per bone.
         Both reported snaps came from transients in the *inputs*:
         - the eye↔head driver switch changes the gains instantly;
         - a re-picked driver changes followers[].delay, so _lookAt()
           jumps to a different history sample (up to ~0.35 s of motion
           ≈ 48 world units in one frame).
         Easing the applied contribution (τ=0.12 s) absorbs every source
         instead of patching them one by one — this is the fix for the
         "某些角度还是会闪/重影" report. */
      var tgt = {};
      tgt.eye = [yaw * eyeK * unit + fEyeX, -pitch * eyeK * unit * 0.85 + fEyeY];
      tgt.head = [headL.y * headK * unit + fHeadX, -headL.p * headK * unit * 0.85 + fHeadY];
      tgt.body = [bodyL.y * bodyScale * headK * unit + fBodyX,
                  -bodyL.p * bodyScale * 0.8 * headK * unit * 0.85 + fBodyY];
      tgt.center = [yaw * 0.4 * headK * unit + fHeadX * 0.5,
                    -pitch * 0.4 * headK * unit * 0.85 + fHeadY * 0.5];
      tgt.r_head = [headL.r * headK * 16, 0];
      tgt.r_neck = [neckL.r * neckScale * headK * 16 * neckScale, 0];
      tgt.r_body = [bodyL.r * bodyScale * headK * 16 * bodyScale * 0.6, 0];
      if (!(pc.lockSittingAxis)) tgt.r_body2 = [bodyL.r * 0.2 * headK * 16 * 0.2, 0];

      if (!Avatar._aimSm) Avatar._aimSm = {};
      var aK = 1 - Math.exp(-dtL / 0.12);
      Object.keys(tgt).forEach(function (k) {
        var t = tgt[k];
        if (!isFinite(t[0]) || !isFinite(t[1])) return;      /* never poison the smoother */
        var sm = Avatar._aimSm[k];
        if (!sm || !isFinite(sm[0]) || !isFinite(sm[1])) {
          sm = Avatar._aimSm[k] = [t[0], t[1]];
        } else {
          var dx = (t[0] - sm[0]) * aK, dy = (t[1] - sm[1]) * aK;
          /* Slew-rate cap. Plain exponential smoothing bounds a step only to
             aK×gap — a driver re-pick across the full yaw window still lands
             as a >12u snap, the exact transient class §3.8 exists to kill
             (the sweep gate flaked ~1-in-6 on it). 600 u/s ⇒ ~10 u/frame at
             60 fps; normal ambient motion never comes close to the cap. */
          var cap = 600 * dtL, mag = Math.hypot(dx, dy);
          if (mag > cap) { dx *= cap / mag; dy *= cap / mag; }
          sm[0] += dx;
          sm[1] += dy;
        }
        if (k.charAt(0) === 'r') {
          var rb = Avatar._boneOf('rollSlots', k.slice(2));
          if (rb) rb.rotation += sm[0];
        } else {
          var ab = Avatar._boneOf('aimSlots', k);
          if (ab) { ab.x += sm[0]; ab.y += sm[1]; }
        }
      });
    },

    _voiceDb: function () {
      var an = window.App && App._voiceAnalyser;
      if (!an || !App.audio || App.audio.paused) return null;
      var buf = Avatar._fft || (Avatar._fft = new Uint8Array(an.fftSize));
      an.getByteTimeDomainData(buf);
      var sum = 0, i, v;
      for (i = 0; i < buf.length; i++) {
        v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      return 20 * Math.log10(Math.max(1e-6, Math.sqrt(sum / buf.length)));
    },

    _applyLip: function (dt) {
      var L = Avatar.avatar;
      if (!L || !L.state) return;
      var pc = Avatar._pc().lipSyncClosure || {};
      var target = 0, db, amp, i, env;
      if (Avatar._talking) {
        if (Avatar._env) {
          /* Pre-recorded alarm/prologue clips ship a sibling .env.json —
             that envelope is the authored mouth curve, so it wins over
             live RMS (which only exists for TTS blob playback). */
          Avatar._env.t += dt;
          env = Avatar._env;
          i = env.window > 0 ? Math.floor(env.t / env.window) : 0;
          amp = env.samples[Math.min(i, env.samples.length - 1)] || 0;
          target = Math.max(0, amp);
          if (env.duration > 0 && env.t >= env.duration) Avatar.setTalking(false);
        } else {
          db = Avatar._voiceDb();
          if (db != null && pc.opennessMappingEnabled !== false) {
            var lo = Number(pc.opennessFloorDb); if (!(lo < 0) && lo !== 0) lo = -40;
            var hi = Number(pc.opennessCeilingDb); if (!(hi > lo)) hi = -3;
            target = (db - lo) / (hi - lo);
          } else {
            target = 0;
          }
        }
      }
      if (target < 0) target = 0;
      if (target > 1) target = 1;
      target *= Number(pc.opennessOutputScale) || 1;
      var ms = (Avatar._lipOpen < target ? pc.opennessAttackMs : pc.opennessReleaseMs) ||
               (Avatar._lipOpen < target ? 20 : 60);
      var k = 1 - Math.exp(-dt / Math.max(0.008, ms / 1000));
      if (pc.minHoldMs && target < Avatar._lipOpen - (pc.dipThreshold || 0.1) && Avatar._lipHold > 0) {
        Avatar._lipHold -= dt;
      } else {
        Avatar._lipOpen += (target - Avatar._lipOpen) * k;
        if (target >= Avatar._lipOpen) Avatar._lipHold = (pc.minHoldMs || 50) / 1000;
      }
      var lipTr = L.state.getCurrent(4);
      if (!lipTr || !Avatar._talking) return;
      if (pc.enabled !== false && lipTr.animation) {
        lipTr.timeScale = 0;
        lipTr.trackTime = Avatar._lipOpen * lipTr.animation.duration * 0.98;
      } else {
        lipTr.timeScale = 0.25 + Avatar._lipOpen * 2.2;
      }
    },

    setEmotion: function (emotion, attitude, immediate) {
      var L = Avatar.avatar;
      var names = ['neutral', 'happy', 'laughing', 'tease', 'shy',
                   'cuddle', 'sad', 'crying', 'angry'];
      var atts = ['agree', 'deny', 'question'];
      /* Invalid / omitted fields keep the last face — parseTaggedReply uses
         null for omit, and a missed tag must not reset to neutral/agree. */
      if (names.indexOf(emotion) >= 0) Avatar._emotion = emotion;
      if (atts.indexOf(attitude) >= 0) Avatar._attitude = attitude;
      if (!L || !L.ready || !L.state) return;

      var st = L.state, data = L.data;
      var prof = Avatar._profile(Avatar._emotion);
      var inten = Avatar._intensity(prof);
      var timeScale = Avatar._animTimeScale();
      var sat = Number(Avatar._pc().mixDurationSaturationRatio);
      if (!(sat > 0)) sat = 0.1;
      st.data.defaultMix = (Number(prof && prof.mixDurationMin) || 1) * sat;
      Avatar._lipSync = (prof && prof.lipSyncScrubClip) || FALLBACK_LIP;
      Avatar._idleGap = ((inten && inten.poseRerollIntervalMin) || 5) +
                        Math.random() * (((inten && inten.poseRerollIntervalMax) || 8) -
                                         ((inten && inten.poseRerollIntervalMin) || 5));
      Avatar._sittingId = Avatar._sittingFromPosture();

      /* fixedBasePoseMode: emotion / one-shot must not swap the looping A_* idle. */
      var cur0 = st.getCurrent(0);
      var hasIdle = cur0 && cur0.animation && cur0.animation.name;
      if (!hasIdle) {
        var poseType = Avatar._poseType || 'posetype_01_freehand';
        var idle = Avatar._idlesForType(data, poseType);
        if (idle.length) {
          var pi = Util.weighted(idle, function (x) { return x.w; });
          var idleName = pi && pi.name;
          if (idleName) {
            var tr0 = st.setAnimation(0, idleName, true);
            tr0.mixDuration = 0;
            tr0.timeScale = timeScale;
            Avatar._poseType = Avatar._poseTypesOf(idleName)[0] || poseType;
            Avatar._syncAdditives(idleName, Avatar._poseType, true, true, false);
          }
        }
      } else {
        cur0.timeScale = timeScale;
      }

      var shots = Avatar._oneShots(Avatar._emotion, Avatar._attitude)
        .map(function (n) { return pickAnim(data, n); }).filter(Boolean);
      if (shots.length && !immediate) {
        var tr = st.setAnimation(1, shots[0], false);
        tr.mixDuration = Avatar._overlayMix(Avatar._emotion);
        if (spine.MixBlend) tr.mixBlend = spine.MixBlend.replace;
        var fade = Number(Avatar._pc().tapReactionExitMix);
        if (!(fade > 0)) fade = 0.3;
        st.addEmptyAnimation(1, fade, 0);
        Avatar._syncAdditives(hasIdle || Avatar._idleName(), Avatar._poseType, false, false, true);
      } else if (hasIdle) {
        Avatar._syncAdditives(hasIdle, Avatar._poseType || Avatar._poseTypesOf(hasIdle)[0], !!immediate, false, !immediate);
      }

      Avatar._applyFace(!!immediate);
      Avatar._exprBand = Avatar._intensityBand();
      Avatar._syncFx(!!immediate);
      Avatar._lookCyc = null;   /* new emotion → fresh gaze pattern */
      Avatar._pickLook();
      Avatar._blinkTimer = Avatar._nextBlinkGap();
    },

    _applyFace: function (immediate) {
      var L = Avatar.avatar;
      if (!L || !L.ready || !L.state) return;
      var st = L.state, data = L.data;
      var inten = Avatar._intensity(Avatar._profile(Avatar._emotion));
      var mixEye = immediate ? 0 : ((inten && inten.mixDurationEye) || 0.25);
      var mixBrow = immediate ? 0 : ((inten && inten.mixDurationEyebrow) || 0.25);
      var expr = Avatar._pickExpr();
      var closedCfg = Avatar._pc().closedEyeAnimation;
      Avatar._eyeOpen = pickAnim(data, expr && expr.eyeOpen) || pickAnim(data, inten && inten.eyeBase);
      Avatar._eyeClosed = pickAnim(data, expr && expr.eyeClosed) || pickAnim(data, closedCfg);
      var brow = pickAnim(data, expr && expr.eyebrow) || pickAnim(data, inten && inten.eyebrowBase);
      Avatar._mouthIdle = pickAnim(data, expr && expr.mouth) || pickAnim(data, inten && inten.mouthBase);
      if (Avatar._eyeOpen) st.setAnimation(2, Avatar._eyeOpen, true).mixDuration = mixEye;
      if (brow) st.setAnimation(3, brow, true).mixDuration = mixBrow;
      /* A live tap parks track 4 (see poke); putting the idle mouth back
         mid-gesture would re-introduce the unkeyed-bone shear. */
      if (!Avatar._talking && Avatar._mouthIdle && !Avatar._pokeMouthHold) {
        st.setAnimation(4, Avatar._mouthIdle, true).mixDuration = immediate ? 0 : 0.25;
      }
    },

    setTalking: function (on) {
      var L = Avatar.avatar;
      Avatar._talking = !!on;
      if (Avatar._talking) Avatar._tension = 1;
      if (!on) Avatar._env = null;
      if (!L || !L.ready || !L.state) return;
      var data = L.data, st = L.state;
      var lip = pickAnim(data, Avatar._lipSync) || pickAnim(data, FALLBACK_LIP);
      if (Avatar._talking) Avatar._pokeMouthHold = false;
      if (Avatar._talking && lip) {
        st.setAnimation(4, lip, true).mixDuration = 0.12;
      } else if (Avatar._mouthIdle && !Avatar._pokeMouthHold) {
        st.setAnimation(4, Avatar._mouthIdle, true).mixDuration = 0.2;
      }
      var tr0 = st.getCurrent(0);
      if (tr0) tr0.timeScale = Avatar._animTimeScale();
      /* expressionSets are content-identical between normal↔strong for 7 of
         9 emotions (only shy/tease differ): re-rolling the face on every talk
         toggle was churn, not source behaviour. Only re-apply when the two
         bands' sets actually differ; emotion changes still re-roll normally. */
      var bandNow = Avatar._intensityBand();
      var bandPrev = Avatar._exprBand || bandNow;
      Avatar._exprBand = bandNow;
      if (bandNow !== bandPrev && Avatar._exprSetsDiffer(bandPrev, bandNow)) {
        Avatar._applyFace(false);
      }
      Avatar._syncFx(false);
      if (Avatar._talking) Avatar._lookAtUserNow();
      if (!Avatar._addMuted) {
        Avatar._syncAdditives(Avatar._idleName(), Avatar._poseType, false, false, true);
      }
    },

    _exprSetsDiffer: function (a, b) {
      var prof = Avatar._profile(Avatar._emotion);
      var ip = (prof && prof.intensityProfiles) || {};
      function sig(band) {
        var sets = (ip[band] && ip[band].expressionSets) || [];
        return sets.map(function (s) {
          return [s.eyeOpen, s.eyeClosed, s.eyebrow, s.mouth].join(',');
        }).sort().join('|');
      }
      return sig(a) !== sig(b);
    },

    /* gazeEntries ({direction:'lookAtUser', holdSeconds:3.0, weight:1}) exist
       in every emotion × band — authored: when she starts talking she looks
       at you for a beat before the ambient pattern resumes. The transition
       time comes from gazeReturnToFront.entry. */
    _lookAtUserNow: function () {
      var bag = Avatar._tensionBag();
      var ge = ((bag && bag.gaze) || {}).gazeEntries || [];
      var at = null, i;
      for (i = 0; i < ge.length; i++) {
        if (ge[i].direction === 'lookAtUser' && (Number(ge[i].weight) || 0) > 0) {
          at = ge[i]; break;
        }
      }
      if (!at) { Avatar._pickLook(); return; }
      var gr = Avatar._pc().gazeReturnToFront || {};
      var ent = gr.entry || {};
      var sp = Number(ent.secondsPerDistance); if (!(sp > 0)) sp = 0.8;
      var mn = Number(ent.minSeconds); if (!(mn > 0)) mn = 0.4;
      var mx = Number(ent.maxSeconds); if (!(mx >= mn)) mx = Math.max(mn, 0.8);
      var look = Avatar._look;
      var dist = Math.abs(look.yaw) + Math.abs(look.pitch) + Math.abs(look.roll);
      look.fromY = look.yaw; look.fromP = look.pitch; look.fromR = look.roll;
      look.ty = 0; look.tp = 0; look.tr = 0;
      look.trans = Util.clamp(sp * Math.max(0.25, dist), mn, mx);
      look.hold = Number(at.holdSeconds) > 0 ? Number(at.holdSeconds) : 3;
      look.t = 0;
      look.eyeDrv = false;
      Avatar._lookCyc = null;   /* ambient pattern resumes after the hold */
    },

    /* alarm .env.json: durationMs / windowMs / envelope[] drive mouth timeScale. */
    setTalkingEnvelope: function (env) {
      Avatar.setTalking(true);
      if (!env || !env.envelope || !env.envelope.length) return;
      Avatar._env = {
        samples: env.envelope,
        duration: (Number(env.durationMs) || 0) / 1000,
        window: (Number(env.windowMs) || 20) / 1000,
        t: 0
      };
    },

    setHidden: function (on) {
      Avatar._hideChara = !!on;
      var hit = document.getElementById('avatar-hit');
      if (hit) hit.style.pointerEvents = on ? 'none' : '';
    },

    /* ASMR ⇄ other modes flips the intensity band (weak). Re-apply the
       face/FFX/speed without interrupting the current pose. */
    onModeChange: function () {
      if (!Avatar.avatar || !Avatar.avatar.ready || !Avatar.avatar.state) return;
      var tr0 = Avatar.avatar.state.getCurrent(0);
      if (tr0) tr0.timeScale = Avatar._animTimeScale();
      Avatar._fxPick = null;
      Avatar._applyFace(false);
      Avatar._exprBand = Avatar._intensityBand();
      Avatar._syncFx(false);
      if (!Avatar._addMuted) {
        Avatar._syncAdditives(Avatar._idleName(), Avatar._poseType, false, false, true);
      }
    },

    /* Exit fade for tap reactions. The source's tapReactionExitMix (0.3 s)
       is the FLOOR, not the value: the shipped motion_touch_A_* clips all
       END mid-gesture — measured end-vs-idle displacement is 170–490 world
       units on the arm chain, so a fixed 0.3 s return whips the arm down at
       up to ~1600 u/s (the reported 「点击后的动作恢复不自然」). Scale the
       fade with the actual displacement; per-clip result is cached. */
    _pokeExitMix: function (anim) {
      var pcfg = (Avatar.gesture && Avatar.gesture.projectConfig) || {};
      var base = Number(pcfg.tapReactionExitMix);
      if (!(base > 0)) base = 0.3;
      if (!anim || !anim.duration) return base;
      var cache = Avatar._exitMixCache || (Avatar._exitMixCache = {});
      if (cache[anim.name] != null) return cache[anim.name];
      var mix = base;
      try {
        var data = Avatar.avatar.data;
        var sk = new spine.Skeleton(data);
        var asd = new spine.AnimationStateData(data);
        asd.defaultMix = 0;
        var st = new spine.AnimationState(asd);
        var idle = Avatar._idleName();
        if (!idle || !data.findAnimation(idle)) {
          idle = (data.findAnimation('motion_A_001_idle') && 'motion_A_001_idle') ||
                 (data.animations[0] && data.animations[0].name);
        }
        st.setAnimation(0, idle, false);
        st.update(0); st.apply(sk); sk.updateWorldTransform(spine.Physics.pose);
        var ref = sk.bones.map(function (b) { return [b.worldX, b.worldY]; });
        st.setAnimation(1, anim.name, false);
        st.update(anim.duration); st.apply(sk);
        sk.updateWorldTransform(spine.Physics.pose);
        var maxD = 0;
        for (var i = 0; i < sk.bones.length; i++) {
          var b = sk.bones[i];
          var d = Math.hypot(b.worldX - ref[i][0], b.worldY - ref[i][1]);
          if (d > maxD) maxD = d;
        }
        mix = Util.clamp(base + maxD / 1400, base, 0.65);
      } catch (e) { mix = base; }
      cache[anim.name] = mix;
      return mix;
    },

    poke: function (partName) {
      var L = Avatar.avatar;
      if (!L || !L.ready || !partName) return null;
      var reactions = (Avatar.gesture && Avatar.gesture.emotionalGesture &&
                       Avatar.gesture.emotionalGesture.TapReactions) || [];
      /* Only reactions mapped to the tapped part. The old "no match → any
         reaction" fallback made misses and unmapped parts still flinch. */
      var list = reactions.filter(function (r) { return r.PartName === partName; });
      if (!list.length) return null;
      var pick = list[Math.floor(Math.random() * list.length)];
      var anim = pickAnim(L.data, pick.OverlayID);
      if (!anim) return null;
      var pc = Avatar._pc();
      var enter = Number(pc.tapReactionEnterMix);
      if (!(enter >= 0)) enter = 0.2;
      /* The source's enter mix is 0: a poke from rest cuts straight in. But
         when a NEW reaction lands on top of one still playing or still
         fading out, a hard cut drops the limb to the new clip's first frame
         mid-gesture — chained taps felt worse than the old flat 0.2. Cross-
         fade only in that overlap case. */
      if (enter === 0 && Avatar._trackBusy(6)) enter = 0.15;
      Avatar._muteAdditives(true);
      /* Tap clips key mouth_01 (open) plus a SUBSET of the mouth chain
         (A_001: mouth2/3/4/5 translate only). MixBlend.replace leaves
         unkeyed bones at the idle-mouth pose. Sad/crying idles (004/005/006)
         park extra translate/scale/rotate on face_mouth, mouth6, mouth7_ex
         and scale on mouth2/3 — those leftovers shear mouth_01 as soon as
         look-at turns the head off the clip's authored side. Other
         expression mouths sit near setup, so the mix is invisible.
         Empty track 4 for the gesture so tap applies on bind pose. */
      Avatar._clearMouthForPoke(enter);
      var tr = L.state.setAnimation(6, anim, false);
      tr.mixDuration = enter;
      L.state.addEmptyAnimation(6, Avatar._pokeExitMix(anim), 0);
      return pick.OverlayID;
    },

    _clearMouthForPoke: function (mix) {
      var L = Avatar.avatar;
      if (!L || !L.state || Avatar._talking) return;
      var m = Number(mix);
      if (!(m >= 0)) m = 0.08;
      L.state.setEmptyAnimation(4, m);
      Avatar._pokeMouthHold = true;
    },

    _restoreMouthAfterPoke: function () {
      if (!Avatar._pokeMouthHold) return;
      if (Avatar._trackBusy(6)) return;
      Avatar._pokeMouthHold = false;
      if (Avatar._talking) return;
      var L = Avatar.avatar;
      if (!L || !L.state || !Avatar._mouthIdle) return;
      L.state.setAnimation(4, Avatar._mouthIdle, true).mixDuration = 0.2;
    },

    /* Un-mute timing for the tap exit. The limb/occupancy layers used to come
       back on the first frame after the exit fade fully drained: the body
       landed on the bare idle, then shifted again as the layers blended in —
       a two-phase "bounce" the user felt as 退出点击突兀. Letting the layers
       re-blend from ~60 % into the fade turns the two moves into one settle.
       (tapReactionExitMix stays the source's authority; we only overlap.) */
    _pokeUnmuteReady: function () {
      var L = Avatar.avatar;
      var st = L && L.state;
      if (!st) return false;
      if (!Avatar._oneShotBusy()) return true;
      var tr = st.getCurrent(6);
      if (!tr || !tr.mixingFrom || !Avatar._entryLive(tr.mixingFrom)) return false;
      if (!/<empty>/i.test((tr.animation && tr.animation.name) || '')) return false;
      var dur = Math.max(1e-6, Number(tr.mixDuration) || 0.3);
      return (Number(tr.mixTime) || 0) / dur >= 0.6;
    },

    /* --------------------------------------------------------------- loop */
    _loop: function (now) {
      requestAnimationFrame(Avatar._loop);
      var dt = Avatar._last ? Math.min((now - Avatar._last) / 1000, 0.05) : 0;
      Avatar._last = now;

      var host = Avatar.host;
      if (host && Avatar.scene) {
        var cw = Math.max(1, Math.floor(host.canvas.clientWidth));
        var ch = Math.max(1, Math.floor(host.canvas.clientHeight));
        var cdpr = Math.max(1, window.devicePixelRatio || 1) * Avatar._cssZoom(host.canvas);
        if (cw !== Avatar.scene.cssW || ch !== Avatar.scene.cssH || cdpr !== Avatar.scene.dpr) {
          Avatar.resize();
        }
      }

      if (Avatar.scene && Avatar.scene.ready && Avatar.scene.skeleton) {
        Avatar.scene.state.update(dt);
        Avatar.scene.state.apply(Avatar.scene.skeleton);
        Avatar.scene.skeleton.update(dt);
        /* Scene parallax is transform constraints, not physics. Physics.update
           on the 4000×5400 stage makes far layers shimmer every frame. */
        Avatar.scene.skeleton.updateWorldTransform(spine.Physics.none);
      }
      if (Avatar.avatar && Avatar.avatar.ready && Avatar.avatar.skeleton) {
        /* Place first, then one Physics.update. A second Physics.none pass
           discarded the simulated pose every frame and made actions jitter. */
        Avatar._placeCharacter();
        Avatar._updateLook(dt);
        Avatar.avatar.state.update(dt);
        /* Scrub the mouth track *after* state.update so dt does not overwrite
           openness, and *before* apply so this frame's draw sees it. */
        Avatar._applyLip(dt);
        Avatar.avatar.state.apply(Avatar.avatar.skeleton);
        Avatar.avatar.skeleton.update(dt);
        Avatar._hideFxSlots(Avatar._fxOn);
        Avatar._applyLook();
        Avatar.avatar.skeleton.updateWorldTransform(spine.Physics.update);
      }

      Avatar._dt = dt;

      /* tension: toward 1 while talking (fast), decays high→mid→low via
         projectConfig.tensionConfig.decayRates (per-frame @60fps units). */
      var tgtT = Avatar._talking ? 1 : 0;
      var tBand = tgtT > Avatar._tension ? 'high' : Avatar._tensionBand();
      var tRate = Avatar._tensionRate(tBand);
      var nk = 1 - Math.exp(-tRate * 60 * dt);
      Avatar._tension += (tgtT - Avatar._tension) * nk;

      Avatar._idleTimer += dt;
      if (Avatar._idleTimer > Avatar._idleGap && Avatar.avatar && Avatar.avatar.ready) {
        Avatar._rerollIdle();
      }

      if (Avatar._addMuted && Avatar._pokeUnmuteReady()) {
        Avatar._muteAdditives(false);
      }
      Avatar._restoreMouthAfterPoke();

      if (Avatar._closedHold > 0) Avatar._closedHold -= dt;
      Avatar._blinkTimer -= dt;
      if (Avatar._blinkTimer <= 0 && Avatar.avatar && Avatar.avatar.ready &&
          Avatar._eyeOpen && Avatar._eyeClosed && !Avatar._oneShotBusy() &&
          !(Avatar._closedHold > 0)) {
        Avatar._blinkTimer = Avatar._nextBlinkGap();
        var st = Avatar.avatar.state;
        var fast = Avatar._blinkMode === 'blinkFast';
        var blink = st.setAnimation(2, Avatar._eyeClosed, false);
        blink.mixDuration = fast ? 0.03 : 0.04;
        /* 'closed' mode: hold the shut pose for durationSeconds before the
           open clip is queued back in (delay counts from the closed clip,
           which is a 0-length pose key). */
        var shut = Avatar._blinkMode === 'closed' ? (Avatar._closedDur || 1.5) : 0;
        var back = st.addAnimation(2, Avatar._eyeOpen, true, shut);
        back.mixDuration = fast ? 0.06 : 0.08;
        if (shut > 0) Avatar._closedHold = shut + back.mixDuration;
      }

      if (Avatar._env && Avatar.avatar && Avatar.avatar.state && !Avatar._talking) {
        Avatar._env = null;
      }

      Avatar._draw();
    },

    _drawSkeleton: function (L, pma) {
      var host = Avatar.host;
      host.sr.premultipliedAlpha = !!pma;
      host.batcher.begin(host.shader);
      host.sr.draw(host.batcher, L.skeleton);
      host.batcher.end();
    },

    _nextBlinkGap: function () {
      var bag = Avatar._tensionBag();
      var entries = bag && bag.gaze && bag.gaze.eyeModeEntries;
      /* blink / blinkFast / closed all drive eye modes in the source table
         ('closed' = a long 1.5 s eyes-shut beat, weighted ~10%). */
      var cand = (entries || []).filter(function (e) {
        var w = Number(e.weight) || 0;
        return w > 0 && (e.mode === 'blink' || e.mode === 'blinkFast' || e.mode === 'closed');
      });
      var pick = Avatar._weighted(cand, function (e) { return Number(e.weight) || 0; });
      Avatar._blinkMode = pick ? pick.mode : 'blink';
      Avatar._closedDur = (pick && pick.mode === 'closed') ?
        (Number(pick.durationSeconds) || 1.5) : 0;
      if (!pick) return 2.4 + Math.random() * 3.2;
      var iv = Number(pick.intervalSeconds);
      if (!(iv > 0)) iv = pick.mode === 'blinkFast' ? 1.4 : (pick.mode === 'closed' ? 5.5 : 3);
      var j = Number(pick.jitterSeconds); if (!(j > 0)) j = pick.mode === 'closed' ? 1.5 : 0;
      var gap = iv + (Math.random() * 2 - 1) * j;
      if (pick.mode === 'blinkFast') gap *= 0.55;
      return Math.max(0.45, gap);
    },

    /* Multiply maps (hair shadow) need a PMA second pass. Overlay FX
       (blush / pale / tear) is straight-alpha pink: drawing it as Multiply
       does dst*(rgb+1-a) and the blush itself blows out. Draw those as Normal. */
    _isSetupMul: function (n) {
      return /nose_hi|cheek_line/.test(n);
    },
    _isOverlayMul: function (n) {
      return /face_cheek|face_pale|face_tear|face_sweat|mouth_drool/.test(n);
    },

    _drawLayer: function (L) {
      if (!L || !L.ready || !L.skeleton) return;
      var sk = L.skeleton, i, slot, n, att;
      var savedBlend = [], savedMul = [], savedA = [], savedSetup = [];
      for (i = 0; i < sk.slots.length; i++) {
        slot = sk.slots[i];
        n = (slot.data && slot.data.name) || '';
        if (Avatar._isSetupMul(n)) {
          att = slot.getAttachment();
          savedSetup.push({ slot: slot, att: att });
          if (att) slot.setAttachment(null);
          continue;
        }
        if (slot.data.blendMode === 2 && Avatar._isOverlayMul(n)) {
          savedBlend.push({ slot: slot, blend: slot.data.blendMode });
          slot.data.blendMode = 0;
          continue;
        }
        if (slot.data.blendMode === 2) {
          att = slot.getAttachment();
          savedMul.push({ slot: slot, att: att });
          if (att) slot.setAttachment(null);
        }
      }
      try {
        Avatar._drawSkeleton(L, false);
        for (i = 0; i < savedMul.length; i++) {
          if (savedMul[i].att) savedMul[i].slot.setAttachment(savedMul[i].att);
        }
        if (savedMul.length) {
          for (i = 0; i < sk.slots.length; i++) {
            slot = sk.slots[i];
            n = (slot.data && slot.data.name) || '';
            if (slot.data.blendMode === 2 && !Avatar._isSetupMul(n) && !Avatar._isOverlayMul(n)) continue;
            savedA.push({ slot: slot, a: slot.color.a });
            slot.color.a = 0;
          }
          Avatar._drawSkeleton(L, true);
        }
      } finally {
        for (i = 0; i < savedA.length; i++) savedA[i].slot.color.a = savedA[i].a;
        for (i = 0; i < savedBlend.length; i++) {
          savedBlend[i].slot.data.blendMode = savedBlend[i].blend;
        }
      }
    },

    _lightCfg: function () {
      return (Avatar.sceneConfig && Avatar.sceneConfig.config && Avatar.sceneConfig.config.light) || null;
    },

    _ensureFbo: function () {
      var host = Avatar.host, gl = host && host.gl;
      if (!gl) return false;
      var w = host.canvas.width, h = host.canvas.height;
      if (Avatar._fbo && Avatar._fboW === w && Avatar._fboH === h) return true;
      if (Avatar._fbo) {
        gl.deleteFramebuffer(Avatar._fbo);
        gl.deleteTexture(Avatar._fboTex);
        Avatar._fbo = null; Avatar._fboTex = null;
      }
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      var fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
      var ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.bindTexture(gl.TEXTURE_2D, null);
      if (!ok) { gl.deleteFramebuffer(fbo); gl.deleteTexture(tex); return false; }
      Avatar._fbo = fbo; Avatar._fboTex = tex; Avatar._fboW = w; Avatar._fboH = h;
      if (!Avatar._rimShader) {
        try { Avatar._rimShader = new spine.Shader(host.ctx, RIM_VS, RIM_FS); }
        catch (e) { return false; }
      }
      if (!Avatar._quadBuf) {
        Avatar._quadBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, Avatar._quadBuf);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
          -1, -1, 0, 0,  1, -1, 1, 0,  -1, 1, 0, 1,  1, 1, 1, 1
        ]), gl.STATIC_DRAW);
      }
      return true;
    },

    _blitRim: function () {
      var host = Avatar.host, gl = host.gl, light = Avatar._lightCfg();
      var sh = Avatar._rimShader, prog = sh && sh.getProgram();
      if (!prog || !Avatar._fboTex) return;
      var n = Number(light && light.color) >>> 0;
      var cr = ((n >>> 16) & 255) / 255, cg = ((n >>> 8) & 255) / 255, cb = (n & 255) / 255;
      var deg = Number(light && light.direction);
      if (!(deg === deg)) deg = 220;
      var rad = deg * Math.PI / 180;
      var glow = Number(light && light.rimGlowWidth); if (!(glow > 0)) glow = 12;
      var power = Number(light && light.rimGlowPower); if (!(power > 0)) power = 2.4;
      var opac = Number(light && light.rimOpacity); if (!(opac >= 0)) opac = 0.7;
      if (light && light.rimEnabled === false) opac = 0;

      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      sh.bind();
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, Avatar._fboTex);
      sh.setUniformi('u_texture', 0);
      sh.setUniform2f('u_texel', 1 / Avatar._fboW, 1 / Avatar._fboH);
      sh.setUniform2f('u_light', Math.cos(rad) * glow, Math.sin(rad) * glow);
      sh.setUniform3f('u_rimColor', cr, cg, cb);
      sh.setUniformf('u_rimOpacity', opac);
      sh.setUniformf('u_glowPower', power);

      gl.bindBuffer(gl.ARRAY_BUFFER, Avatar._quadBuf);
      var locP = gl.getAttribLocation(prog, 'a_pos');
      var locU = gl.getAttribLocation(prog, 'a_uv');
      gl.enableVertexAttribArray(locP);
      gl.vertexAttribPointer(locP, 2, gl.FLOAT, false, 16, 0);
      gl.enableVertexAttribArray(locU);
      gl.vertexAttribPointer(locU, 2, gl.FLOAT, false, 16, 8);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.disableVertexAttribArray(locP);
      gl.disableVertexAttribArray(locU);
      sh.unbind();
    },

    _draw: function () {
      var host = Avatar.host;
      if (!host || !host.gl) return;
      var gl = host.gl;
      var hide = Avatar._hideChara;
      var light = Avatar._lightCfg();
      var rimOn = !hide && light && light.rimEnabled !== false;
      try {
        if (Config && Config.section('app').rim === false) rimOn = false;
      } catch (e) {}
      /* Warm floor clear color: normal scenes' far_bg mesh covers the whole
         window so this never shows; only 隠れ家前's 1693u parallax gap
         (wall ends at world Y 629, floor starts at −1064) exposes it, and
         there it reads as shadowed floor instead of a black void. Behind
         the character always — it can never cover her. */
      gl.clearColor(0.16, 0.11, 0.07, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      host.shader.bind();
      host.shader.setUniformi(spine.Shader.SAMPLER, 0);
      host.shader.setUniform4x4f(spine.Shader.MVP_MATRIX, host.mvp.values);
      Avatar._drawLayer(Avatar.scene);

      if (hide) {
        host.shader.unbind();
        return;
      }
      Avatar._drawLayer(Avatar.avatar);
      if (rimOn && Avatar._ensureFbo()) {
        host.shader.unbind();
        gl.bindFramebuffer(gl.FRAMEBUFFER, Avatar._fbo);
        gl.viewport(0, 0, Avatar._fboW, Avatar._fboH);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        host.shader.bind();
        host.shader.setUniformi(spine.Shader.SAMPLER, 0);
        host.shader.setUniform4x4f(spine.Shader.MVP_MATRIX, host.mvp.values);
        Avatar._drawLayer(Avatar.avatar);
        host.shader.unbind();
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, host.canvas.width, host.canvas.height);
        Avatar._blitRim();
      } else {
        host.shader.unbind();
      }
    }
  };

  global.Avatar = Avatar;
})(window);
