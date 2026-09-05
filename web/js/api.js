/* LLM + TTS transport. Both are OpenAI-compatible chat/completions.
   Nothing here touches the original backend — that channel is gone by design. */
(function (global) {
  'use strict';

  var EMOTIONS = ['neutral', 'happy', 'laughing', 'tease', 'shy',
                  'cuddle', 'sad', 'crying', 'angry'];
  var ATTITUDES = ['agree', 'deny', 'question'];

  /* Shipped DEFAULTS placeholders — never send these upstream (the server
     answers with a bare "unsupported model tts-model"); speak() rejects
     with NO_MODEL so the app can show a translated hint instead. */
  var PLACEHOLDER_MODELS = {
    'tts-model': 1, 'voice-clone-model': 1,
    'your-clone-model': 1, 'your-preset-model': 1
  };

  /* Genuine in-game phrasing recovered from the AOT snapshot — this anchors
     the speaking style far better than any paraphrase. */
  var STYLE_SAMPLES = [
    'あたしとお喋りでもしてリフレッシュしよっ',
    '今日は眠くなるまであなたとお喋りしたいなー',
    'あたしにも何が起こるか分からない',
    'どんな困難も乗り越えられるはずだから'
  ];

  /* Text-generation mode prompts (system prompt section). */
  var MODES = {
    chat: '自由な雑談。相手の話を聞いて、自然に会話を続ける。',
    story: '短い物語を一緒に進める。情景描写を少し入れつつ、会話を前に進める。',
    immersive: 'いま二人が一緒にいる状況を、五感を交えてゆっくり描く没入型の語り。',
    asmr: '静かで近い距離感。ゆっくり、やさしく、耳元で囁くような短い言葉。',
    text: 'テキストでのやり取り。簡潔にはっきりと。'
  };

  /* Voice direction per mode — SEPARATE from MODES on purpose: the LLM
     writes the line, but the TTS engine never sees that prompt, so without
     its own per-mode instruction every mode (ASMR especially) comes back
     sounding identically bright and normal. The user-editable base hint
     (tts.styleHint) says WHO the voice is; these say HOW it delivers the
     current mode. Overridable per mode via tts.modeHints[mode] (settings
     import/export JSON). Applied to:
       - openai/MiMo path: the style message before the assistant line
       - qwen path: input.instructions, but ONLY on qwen3-tts-instruct-*
         (plain flash / cloned-vc models don't take instructions). */
  var MODE_TTS = {
    chat: '',  /* base hint alone: bright everyday conversation */
    story: '物語を聞かせる語り手のように、落ち着いて温かく、行間で少し間を取って。',
    immersive: '今すぐそばで語りかけるように、優しくゆっくり、余韻を残す読み方で。',
    asmr: 'ASMRとして耳元でささやくように。ごく低速で、小さく、息混じりの柔らかなささやき声。文の区切りで長めに間を取る。',
    text: ''
  };

  /* Per-mode playback shaping for shells whose endpoint ignores voice
     direction (or as an extra layer): ASMR slows and softens the audio. */
  var MODE_PLAY_FX = {
    asmr: { rate: 0.93, gain: 0.82 },
    immersive: { rate: 0.97, gain: 0.95 }
  };

  function ttsStyleFor(mode, tts) {
    var base = String(tts.styleHint || '').trim();
    var over = (tts.modeHints && tts.modeHints[mode] != null)
      ? String(tts.modeHints[mode]).trim()
      : (MODE_TTS[mode] || '');
    return [base, over].filter(Boolean).join(' ');
  }

  /* True for shipped placeholders — never send upstream, never a real model. */
  function isPlaceholderModel(m) {
    return !m || !!PLACEHOLDER_MODELS[m];
  }

  function persona() {
    var c = Config.section('chara'), p = Config.section('profile');
    var lines = [];
    lines.push('あなたは『ライザ』（ライザリン・シュタウト）です。');
    lines.push('');
    lines.push('## キャラクター');
    lines.push('- 一人称は「あたし」。相手は「' + (c.callMe || '君') + '」と呼ぶ。');
    lines.push('- 明るく前向きで、少しおっちょこちょいな錬金術士。');
    lines.push('- 好奇心旺盛で調合と冒険が好き。困っている人を放っておけない。');
    if (c.personality) lines.push('- 性格：' + c.personality);
    if (c.likes) lines.push('- 好きなもの：' + c.likes);
    if (c.dislikes) lines.push('- 苦手なもの：' + c.dislikes);
    if (c.situation) lines.push('- 今の状況：' + c.situation);
    lines.push('- 参考になる実際の言い回し：');
    STYLE_SAMPLES.forEach(function (s) { lines.push('  - ' + s); });

    var prof = [];
    if (p.appearance) prof.push('見た目：' + p.appearance);
    if (p.background) prof.push('経歴：' + p.background);
    if (p.hobby) prof.push('趣味：' + p.hobby);
    if (p.interest) prof.push('関心事：' + p.interest);
    if (p.futureGoals) prof.push('今後の目標：' + p.futureGoals);
    if (p.personality) prof.push('性格：' + p.personality);
    if (prof.length) {
      lines.push('');
      lines.push('## 相手（ユーザー）について');
      prof.forEach(function (s) { lines.push('- ' + s); });
    }
    if (c.extra) {
      lines.push('');
      lines.push('## 追加設定');
      lines.push(c.extra);
    }
    return lines.join('\n');
  }

  function langName(lg) {
    return (window.I18n && I18n.LANG_NAMES && I18n.LANG_NAMES[lg]) || lg;
  }

  /* Mirrors World.llmDrivesClock — api.js must not require World to be loaded
     (nsfw_intent_regression loads api.js alone). Default / missing = real. */
  function llmDrivesClock() {
    try {
      if (window.World && typeof World.llmDrivesClock === 'function') {
        return World.llmDrivesClock();
      }
      return !!(window.Config && Config.section('app').timeMode === 'flow');
    } catch (e) { return false; }
  }

  /* First-line machine prefix filled with what's already on screen, so a
     copy-paste with no edits is a valid no-op. Screen fields live here;
     bags / exp / money / quest / memory stay in trailing <state>. */
  function screenTagLine() {
    var emotion = 'happy';
    var attitude = 'agree';
    var undress = 'off';
    var stage = 'stage_01_001_04';
    var tod = 'aft';
    try {
      var av = window.Avatar;
      if (av) {
        if (av._emotion && EMOTIONS.indexOf(av._emotion) !== -1) emotion = av._emotion;
        if (av._attitude && ATTITUDES.indexOf(av._attitude) !== -1) attitude = av._attitude;
      }
    } catch (e) {}
    try {
      if (window.Nsfw && Nsfw.active()) undress = 'on';
    } catch (e) {}
    try {
      var st = window.Config && Config.section('state');
      if (st) {
        if (st.stage) stage = String(st.stage);
        if (st.tod === 'mor' || st.tod === 'aft' || st.tod === 'eve' || st.tod === 'ngt') {
          tod = st.tod;
        }
      }
    } catch (e) {}
    var parts = [
      'emotion:' + emotion,
      'attitude:' + attitude,
      'undress:' + undress,
      'stage:' + stage
    ];
    if (llmDrivesClock()) parts.push('tod:' + tod);
    return '[' + parts.join('|') + ']';
  }

  /* Static prefix (persona + protocol). Must not include per-turn facts so
     OpenAI/Claude/vLLM prefix-cache can reuse it across turns. */
  function staticPrompt(mode, style, outLang, hasRpg) {
    var L = [persona()];
    L.push('');
    L.push('## 出力言語（厳守）');
    if (!outLang || outLang === 'ja') {
      L.push('日本語で話すこと。');
    } else {
      L.push('セリフ本文は必ず「' + langName(outLang) + '」で書くこと（ライザらしい元気な口調を' + langName(outLang) + 'でも維持）。');
      L.push('地名や人名は' + langName(outLang) + '表記を基本に、必要なら日本語を併記してよい。');
      L.push('先頭のタグ行と <state> は英キーのまま。');
    }
    L.push('');
    L.push('## 今回の会話モード');
    L.push(MODES[mode] || MODES.chat);
    if (style === 'text') {
      L.push('音声では読み上げないので、少し長めに書いてもよい。');
    } else {
      L.push('音声で読み上げる。短く、話し言葉だけで書く。');
    }
    if (mode === 'asmr') L.push('一文は短く。息づかいを意識して、ゆっくり。');
    L.push('');
    L.push('## 出力形式（厳守）');
    L.push('毎ターン1行目から書く。変わる欄だけ直す。');
    L.push('emotion: ' + EMOTIONS.join(' '));
    L.push('attitude: ' + ATTITUDES.join(' '));
    L.push('undress: on=脱いだ / off=着た。断るなら値を変えない。セリフで脱いだ/着たなら必ず合わせる。');
    L.push('stage: 移動なら一覧のidか地名。寝るなら sleep。');
    if (llmDrivesClock()) {
      L.push('tod: 時を進めるなら mor|aft|eve|ngt か +N時間。');
    }
    if (hasRpg) {
      L.push('荷物・金・経験・クエスト・記憶が動いたときだけ末尾に <state>：');
      L.push('<state>{"stamina_delta":-2,"exp_delta":10,"money_delta":50,"inventory_added":[{"id":"emeralia","count":1}],"quest":{"step_add":1}}</state>');
      L.push('key: stamina_delta exp_delta money_delta inventory_added|removed ryza_inventory_* memory_add quest{step_add,complete}');
    }
    return L.join('\n');
  }

  function dynamicPrompt(rpgContext, nsfwSection, sceneSection) {
    var L = [];
    if (sceneSection) L.push(sceneSection);
    if (rpgContext) L.push(rpgContext);
    if (nsfwSection) L.push(nsfwSection);
    L.push('次の行をコピーし、このターン変わった欄だけ直す：');
    L.push(screenTagLine());
    L.push('セリフ');
    return L.filter(Boolean).join('\n\n');
  }

  /* Live user turn only — not stored in App.history. Long chats bury the
     same line at the end of system; putting it next to the latest user
     text keeps emotion / undress / stage from decaying together. */
  function withTurnCue(userText) {
    return String(userText || '') +
      '\n\n次の行をコピーし、このターン変わった欄だけ直す：\n' +
      screenTagLine() + '\nセリフ';
  }

  /* What the model should see as its own previous reply: the canonical
     screen line (after this turn's side effects) + spoken text.
     Display / TTS / Memory stay on the spoken line. Do not echo <state>
     deltas — those are one-shot and would replay if copied. */
  function formatHistoryReply(spoken) {
    return screenTagLine() + '\n' + String(spoken || '').replace(/^\s+/, '');
  }

  function buildSystemPrompt(mode, style, rpgContext, outLang, nsfwSection, sceneSection, memorySection) {
    return [staticPrompt(mode, style, outLang, !!rpgContext), memorySection || '',
            dynamicPrompt(rpgContext, nsfwSection, sceneSection)]
      .filter(Boolean).join('\n\n');
  }

  /* Replies may carry a trailing machine block; it must never be displayed
     or spoken. (Client-side counterpart of the official state_updated /
     parsed_message pipeline.) */
  function extractState(body) {
    var state = null;
    var m = /<state>\s*([\s\S]*?)\s*<\/state>/i.exec(body);
    if (!m) m = /<state>\s*([\s\S]*)$/i.exec(body);   // forgotten closing tag
    if (m) {
      body = (body.slice(0, m.index) + body.slice(m.index + m[0].length)).trim();
      try {
        state = JSON.parse(m[1]
          .replace(/[{,]\s*\/\/[^\n]*/g, '')
          .replace(/,\s*([}\]])/g, '$1'));
      } catch (e) { state = null; }
      if (state && typeof state !== 'object') state = null;
    }
    return { text: body, state: state };
  }

  /* Split on pipes only — replacing '|' with spaces then splitting on
     whitespace used to drop `emotion: shy` / `undress: on` (the value became
     a separate token). Omit = null so the client keeps the last screen
     value; never default-apply neutral/agree. `nsfw` is still accepted as
     an alias for `undress`. */
  var KEEP = { keep: 1, same: 1, omit: 1, here: 1 };

  function parseTagFields(tag, dest) {
    String(tag || '').split(/[|｜,]/).forEach(function (part) {
      var m = /^\s*([A-Za-z_]+)\s*[:：]\s*(\S+)/.exec(part);
      if (!m) return;
      var k = m[1].toLowerCase();
      var v = m[2].replace(/[。．.]+$/, '').toLowerCase();
      if (k === 'emotion' && EMOTIONS.indexOf(v) !== -1) dest.emotion = v;
      else if (k === 'attitude' && ATTITUDES.indexOf(v) !== -1) dest.attitude = v;
      else if (k === 'undress' || k === 'nsfw') {
        if (KEEP[v]) dest.nsfw = null;
        else if (v === 'on' || v === '1' || v === 'true') dest.nsfw = true;
        else if (v === 'off' || v === '0' || v === 'false') dest.nsfw = false;
      } else if (k === 'stage' || k === 'place') {
        if (KEEP[v]) dest.stage = null;
        else dest.stage = v;
      } else if (k === 'tod') {
        if (KEEP[v]) dest.tod = null;
        else if (v === 'mor' || v === 'aft' || v === 'eve' || v === 'ngt') dest.tod = v;
        else if (/^\+?\d+/.test(v)) dest.advance = parseInt(v, 10);
      } else if (k === 'sleep') {
        if (v === 'on' || v === 'true' || v === '1' || v === 'yes') dest.stage = 'sleep';
      } else if (k === 'time_advance') {
        var n = parseInt(v, 10);
        if (!isNaN(n)) dest.advance = n;
      }
    });
  }

  function isMachineTag(tag) {
    return /(?:^|[|｜,\s])(?:emotion|attitude|undress|nsfw|stage|place|tod|sleep|time_advance)\s*[:：]/i.test('|' + tag);
  }

  function attachSceneTags(state, dest) {
    var s = (state && typeof state === 'object') ? state : {};
    var hit = !!state;
    if (dest.stage === 'sleep') { s.sleep = true; hit = true; }
    else if (dest.stage) { s.current_stage = dest.stage; hit = true; }
    if (dest.tod) { s.tod = dest.tod; hit = true; }
    if (dest.advance) { s.time_advance = dest.advance; hit = true; }
    return hit ? s : null;
  }

  function parseTaggedReply(text) {
    var dest = { emotion: null, attitude: null, nsfw: null, stage: null, tod: null, advance: null };
    var body = String(text || '').replace(/^\uFEFF/, '').trim();
    body = body.replace(/^```[\w-]*\s*\n?/, '').replace(/\n```\s*$/, '').trim();
    body = body.replace(/^<think\b[^>]*>[\s\S]*?<\/think>\s*/i, '');
    body = body.replace(/^<reasoning\b[^>]*>[\s\S]*?<\/reasoning>\s*/i, '');
    var n = 0;
    while (n++ < 3 && body.charAt(0) === '[') {
      var end = body.indexOf(']');
      if (end === -1) break;
      var tag = body.slice(1, end);
      if (!isMachineTag(tag)) break;
      parseTagFields(tag, dest);
      body = body.slice(end + 1).replace(/^\s+/, '');
    }
    var ex = extractState(body);
    return {
      emotion: dest.emotion, attitude: dest.attitude, nsfw: dest.nsfw,
      text: ex.text, state: attachSceneTags(ex.state, dest)
    };
  }

  function upstreamUrl(baseUrl, path) {
    return String(baseUrl || '').replace(/\/+$/, '') + path;
  }

  /* Three hosts ship a same-origin /_proxy: scripts/serve.py (loopback http),
     the desktop shell (ryza://app — desktop/main.js protocol handler) and the
     Android AssetServer (loopback http). The desktop scheme is a standard
     custom scheme, so location.origin is "ryza://app" — matching only the
     loopback regex silently disabled the proxy there and every LLM/TTS call
     died with the CORS toast. Match both; a foreign origin in a real browser
     still calls the endpoint directly. */
  function localProxy(target) {
    var or = String(location.origin || '');
    if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(or) &&
        !/^ryza:\/\/app$/i.test(or)) return target;
    return '/_proxy?u=' + encodeURIComponent(target);
  }

  /* DashScope uses {code, message}; OpenAI-compat uses {error:{message}}. */
  function apiErrorMessage(j, status, raw) {
    if (j) {
      var err = j.error;
      if (typeof err === 'string' && err) return err;
      if (err && typeof err === 'object') {
        var em = err.message || err.msg || '';
        var ec = err.code || err.type || '';
        if (em) return (ec ? ec + ': ' : '') + em;
        if (ec) return String(ec);
      }
      var msg = j.message || j.msg;
      var code = j.code;
      if (code === 'ERR_INSUFFICIENT_CREDITS' || status === 402) {
        var need = j.required_quota || j.requiredQuota;
        return (msg || '积分不足') + (need ? '（需要 ' + need + '）' : '');
      }
      if (msg && code && String(code) && String(code) !== '200') {
        return String(code) + ': ' + msg;
      }
      if (msg) return String(msg);
    }
    var snippet = raw ? String(raw).replace(/\s+/g, ' ').slice(0, 180) : '';
    return 'HTTP ' + status + (snippet ? ': ' + snippet : '');
  }

  function xhrJsonOk(xhr, j) {
    if (!(xhr.status >= 200 && xhr.status < 300 && j)) return false;
    if (j.code && String(j.code) && String(j.code) !== '200' &&
        !(j.output || j.data)) return false;
    return true;
  }

  function request(url, body, apiKey, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 120000;
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(new Error('网络请求失败（跨域或未走本地代理）')); };
      xhr.ontimeout = function () { reject(new Error('请求超时')); };
      xhr.send(JSON.stringify(body));
    });
  }

  function requestGet(url, apiKey, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('GET', url, true);
      xhr.timeout = timeoutMs || 30000;
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(new Error('网络请求失败（跨域或未走本地代理）')); };
      xhr.ontimeout = function () { reject(new Error('请求超时')); };
      xhr.send();
    });
  }

  function bufToText(buf) {
    try { return new TextDecoder('utf-8').decode(buf); } catch (e) {
      var u = new Uint8Array(buf || []), s = '', i;
      for (i = 0; i < u.length; i++) s += String.fromCharCode(u[i]);
      return s;
    }
  }

  function audioMimeFrom(buf, contentType) {
    var ct = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (ct.indexOf('audio/') === 0) return ct;
    if (ct.indexOf('mpeg') !== -1) return 'audio/mpeg';
    var u = new Uint8Array(buf || []);
    if (u.length >= 4 && u[0] === 0x52 && u[1] === 0x49 && u[2] === 0x46 && u[3] === 0x46) {
      return 'audio/wav';
    }
    if (u.length >= 3 && u[0] === 0x49 && u[1] === 0x44 && u[2] === 0x33) return 'audio/mpeg';
    if (u.length >= 2 && u[0] === 0xff && (u[1] & 0xe0) === 0xe0) return 'audio/mpeg';
    return '';
  }

  /* Fish Open API TTS returns audio bytes (or JSON metadata when cache=true). */
  function requestAudio(url, body, apiKey, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 180000;
      xhr.responseType = 'arraybuffer';
      xhr.setRequestHeader('Content-Type', 'application/json');
      if (apiKey) {
        xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
        xhr.setRequestHeader('api-key', apiKey);
      }
      xhr.onload = function () {
        var buf = xhr.response;
        var ct = xhr.getResponseHeader('Content-Type') || '';
        var mime = audioMimeFrom(buf, ct);
        if (xhr.status >= 200 && xhr.status < 300 && mime) {
          resolve(URL.createObjectURL(new Blob([buf], { type: mime })));
          return;
        }
        var raw = bufToText(buf);
        var j = null;
        try { j = JSON.parse(raw); } catch (e) {}
        if (xhr.status >= 200 && xhr.status < 300 && j && (j.audio_url || j.audioUrl)) {
          Api._downloadUrl(j.audio_url || j.audioUrl, apiKey).then(resolve, reject);
          return;
        }
        reject(new Error(apiErrorMessage(j, xhr.status, raw)));
      };
      xhr.onerror = function () { reject(new Error('网络请求失败（跨域或未走本地代理）')); };
      xhr.ontimeout = function () { reject(new Error('请求超时')); };
      xhr.send(JSON.stringify(body));
    });
  }

  function requestForm(url, form, apiKey, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', url, true);
      xhr.timeout = timeoutMs || 180000;
      if (apiKey) xhr.setRequestHeader('Authorization', 'Bearer ' + apiKey);
      xhr.onload = function () {
        var j = null;
        try { j = JSON.parse(xhr.responseText); } catch (e) {}
        if (xhrJsonOk(xhr, j)) resolve(j);
        else reject(new Error(apiErrorMessage(j, xhr.status, xhr.responseText)));
      };
      xhr.onerror = function () { reject(new Error('网络请求失败（跨域或未走本地代理）')); };
      xhr.ontimeout = function () { reject(new Error('请求超时')); };
      xhr.send(form);
    });
  }

  /* Same DashScope HTTP protocol, different hosts: official Beijing,
     Singapore, workspace MaaS, or a reverse-proxy that mirrors the
     /api/v1/services/... paths. Users paste whatever the console copied
     (host root, /api/v1, compatible-mode/v1, even a full TTS URL). */
  var QWEN_DEFAULT_BASE = 'https://dashscope.aliyuncs.com';
  var QWEN_TTS_MODELS = [
    'qwen3-tts-flash',
    'qwen3-tts-instruct-flash',
    'qwen3-tts-vc-2026-01-22',
    'qwen-audio-3.0-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'cosyvoice-v3-flash',
    'cosyvoice-v3.5-flash',
    'cosyvoice-v3.5-plus'
  ];
  var QWEN_TTS_VOICES = [
    'Cherry', 'Serena', 'Chelsie', 'Ethan', 'longanhuan_v3.6'
  ];

  function qwenApiRoot(baseUrl) {
    var s = String(baseUrl || '').trim();
    if (!s) s = QWEN_DEFAULT_BASE;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/api\/v1\/services\/[^?#]*/i, '');
    s = s.replace(/\/compatible-mode\/v1$/i, '');
    s = s.replace(/\/compatible-mode$/i, '');
    s = s.replace(/\/api\/v1$/i, '');
    /* OpenAI-compat copy-paste: https://gateway.example/v1 */
    if (!/\/api\/v1$/i.test(s)) s = s.replace(/\/v1$/i, '');
    return s.replace(/\/+$/, '');
  }

  function qwenTtsKind(model) {
    var m = String(model || '').toLowerCase();
    if (/voice-enrollment|qwen-voice-enrollment|qwen-voice-design/.test(m)) {
      return 'enroll';
    }
    if (/cosyvoice|qwen-audio/.test(m)) return 'speech';
    return 'multimodal';
  }

  function qwenTtsPath(model) {
    var k = qwenTtsKind(model);
    if (k === 'speech') return '/api/v1/services/audio/tts/SpeechSynthesizer';
    if (k === 'enroll') return '/api/v1/services/audio/tts/customization';
    return '/api/v1/services/aigc/multimodal-generation/generation';
  }

  function qwenTtsUrl(baseUrl, model) {
    return qwenApiRoot(baseUrl) + qwenTtsPath(model);
  }

  function qwenHttpsUrl(url) {
    return String(url || '').replace(/^http:\/\//i, 'https://');
  }

  /* Fish Audio Open API (https://docs.fishaudio.org). Credentials are
     separate from openai/qwen so switching providers never mixes keys.
     fishVoice is a speaker id (莱莎默认音色可改)；fishModel is the engine. */
  var FISH_DEFAULT_BASE = 'https://fishaudio.org/api/open/v1';
  var FISH_DEFAULT_VOICE = '';
  var FISH_TTS_MODELS = [
    'fishaudio-s21pro-flash',
    'fishaudio-s21pro',
    'fishaudio-s2pro',
    'fishaudio-s1',
    'minimax-2.8-turbo',
    'minimax-2.8-hd',
    'minimax-2.6-turbo',
    'minimax-2.6-hd',
    'qwen3-tts-flash',
    'qwen-audio-3.0-tts-plus',
    'qwen-audio-3.0-tts-flash',
    'cosyvoice-v3-flash',
    'doubao-tts-2.0'
  ];

  function fishApiRoot(baseUrl) {
    var s = String(baseUrl || '').trim();
    if (!s) return FISH_DEFAULT_BASE;
    s = s.replace(/\/+$/, '');
    s = s.replace(/\/speech\/tts\/jobs$/i, '');
    s = s.replace(/\/speech\/tts$/i, '');
    s = s.replace(/\/v1\/tts$/i, '');
    if (/api\.fish\.audio/i.test(s)) return FISH_DEFAULT_BASE;
    if (/^https?:\/\/fishaudio\.org$/i.test(s)) return FISH_DEFAULT_BASE;
    if (/^https?:\/\/fishaudio\.org\/v1$/i.test(s)) return FISH_DEFAULT_BASE;
    if (/\/api\/open\/v\d+$/i.test(s)) return s;
    if (/fishaudio\.org$/i.test(s)) return s + '/api/open/v1';
    return s;
  }

  function fishTtsUrl(baseUrl) {
    return fishApiRoot(baseUrl) + '/speech/tts';
  }

  function fishLanguage(lg) {
    var map = {
      ja: 'ja', zh: 'zh', 'zh-tw': 'zh-TW', en: 'en',
      hi: 'hi', id: 'id', 'pt-br': 'pt-BR'
    };
    return map[lg] || '';
  }

  function fishWantsInstruction(model) {
    return /qwen-audio/i.test(String(model || ''));
  }

  function fishWantsEmotion(model) {
    return /minimax/i.test(String(model || ''));
  }

  function fishEmotion() {
    var e = '';
    try { e = (window.Avatar && Avatar._emotion) || ''; } catch (err) { e = ''; }
    var map = {
      happy: 'happy', laughing: 'happy', tease: 'surprised',
      shy: 'calm', cuddle: 'calm', sad: 'sad', crying: 'sad',
      angry: 'angry', neutral: 'calm'
    };
    return map[e] || '';
  }

  /* Local Ryza samples for Open API clone. Prefer converted wav if present,
     otherwise the shipped Japanese prologue m4a (Fish accepts m4a). */
  function fishSampleUrls() {
    var tts = {};
    try { tts = (window.Config && Config.section('tts')) || {}; } catch (e) { tts = {}; }
    var urls = [], seen = {};
    function add(u) {
      u = String(u || '').trim();
      if (!u || seen[u]) return;
      seen[u] = 1;
      urls.push(u);
    }
    add(tts.reference);
    var i, n;
    for (i = 1; i <= 9; i++) {
      n = (i < 10 ? '0' : '') + i;
      add('assets/voice/ryza_wav/prologue_' + n + '.wav');
      add('assets/audio/prologue/jp/prologue_' + n + '.m4a');
    }
    return urls;
  }

  var _fishCloneWait = null;

  function qwenDefaultVoice(model, current) {
    var m = String(model || '').toLowerCase();
    var v = String(current || '').trim();
    var audioFamily = /qwen-audio|cosyvoice/.test(m);
    if (!v) return audioFamily ? 'longanhuan_v3.6' : 'Cherry';
    if (audioFamily && /^cherry$/i.test(v)) return 'longanhuan_v3.6';
    if (!audioFamily && /longanhuan/i.test(v) && /qwen3-tts|qwen-tts/.test(m)) {
      return 'Cherry';
    }
    return v;
  }

  function qwenWantsInstructions(model) {
    var m = String(model || '').toLowerCase();
    if (/qwen3-tts-vc|qwen-tts-vc/.test(m)) return false;
    if (/instruct/.test(m)) return true;
    if (/qwen-audio/.test(m)) return true;
    if (/cosyvoice-v3\.5|cosyvoice-v3-flash/.test(m)) return true;
    return false;
  }

  function isQwenHttpTtsModelId(id) {
    id = String(id || '').toLowerCase();
    if (/realtime/.test(id)) return false;
    return /tts|cosyvoice|qwen-audio|speech|voice-enrollment|qwen-voice/.test(id);
  }

  function parseQwenModelList(j) {
    var raw = (j && (j.data || j.models)) || [];
    if (!Array.isArray(raw) && j && j.output && Array.isArray(j.output.models)) {
      raw = j.output.models;
    }
    if (!Array.isArray(raw)) raw = [];
    var out = [], seen = {};
    raw.forEach(function (m) {
      var e = parseModelEntry(m);
      if (!e || !e.id || seen[e.id] || !isQwenHttpTtsModelId(e.id)) return;
      seen[e.id] = 1;
      out.push(e);
    });
    out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
    return out;
  }

  function choiceText(j) {
    var m = j && j.choices && j.choices[0] && j.choices[0].message;
    if (!m) return '';
    var c = m.content;
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(function (p) {
        return (p && (p.text || p.content || '')) || '';
      }).join('');
    }
    return '';
  }

  /* CJK-heavy estimator. Used only as a budget fence, not a billing meter. */
  function estTokens(s) {
    s = String(s || '');
    var n = 0, i, c;
    for (i = 0; i < s.length; i++) {
      c = s.charCodeAt(i);
      n += c > 127 ? 1.15 : 0.35;
    }
    return Math.ceil(n);
  }

  function estMessages(msgs) {
    var t = 0, i;
    for (i = 0; i < msgs.length; i++) t += 8 + estTokens(msgs[i] && msgs[i].content);
    return t;
  }

  function guessContext(id) {
    id = String(id || '').toLowerCase();
    if (/gpt-5|gpt-4\.1|o3|o4|o1/.test(id)) return 200000;
    if (/gpt-4o|gpt-4-turbo|chatgpt-4o/.test(id)) return 128000;
    if (/gpt-3\.5/.test(id)) return 16385;
    if (/claude/.test(id)) return 200000;
    if (/gemini/.test(id)) return 128000;
    if (/deepseek/.test(id)) return 65536;
    if (/qwen3|qwen2\.5|qwen2/.test(id)) return 32768;
    if (/qwen/.test(id)) return 32768;
    if (/llama-?3\.1|llama3\.1/.test(id)) return 131072;
    if (/mistral|mixtral/.test(id)) return 32768;
    return 0;
  }

  function parseContextField(m) {
    if (!m || typeof m !== 'object') return 0;
    var n = Number(m.context_length || m.max_model_len || m.context_window ||
                   m.max_context ||
                   (m.limit && (m.limit.context || m.limit.context_length)) ||
                   (m.top_provider && m.top_provider.context_length) ||
                   (m.meta && (m.meta.n_ctx || m.meta.max_model_len)) ||
                   (m.architecture && m.architecture.context_length) || 0);
    return n > 1024 ? Math.floor(n) : 0;
  }

  /* One UI ladder. Wire tokens differ per URL; map at send time.
     `default` = do not send an intensity field (endpoint native / unmodifiable). */
  var EFFORT_RANK = {
    default: -1,
    off: 0, none: 0, disabled: 0,
    low: 1, minimal: 1, min: 1,
    medium: 2, mid: 2,
    high: 3,
    xhigh: 4,
    max: 5
  };
  var EFFORT_UI = ['default', 'off', 'low', 'medium', 'high', 'max'];
  var QWEN_BUDGET = { low: 512, medium: 2048, high: 8192, max: 32768 };

  function normalizeEffort(v) {
    var s = String(v == null ? '' : v).toLowerCase().trim();
    if (!s) return 'default';
    if (s === 'none' || s === 'disabled' || s === 'false') return 'off';
    if (s === 'minimal' || s === 'min') return 'low';
    if (s === 'mid') return 'medium';
    if (s === 'extra-high' || s === 'extra_high' || s === 'extra high') return 'xhigh';
    return Object.prototype.hasOwnProperty.call(EFFORT_RANK, s) ? s : 'default';
  }

  function effortRank(v) {
    var n = normalizeEffort(v);
    return EFFORT_RANK[n] != null ? EFFORT_RANK[n] : -1;
  }

  /* Pick the closest token from `available` (provider vocabulary).
     Returns null for `default` or when there is nothing to send. */
  function mapEffort(wanted, available) {
    var w = normalizeEffort(wanted);
    if (w === 'default') return null;
    var list = [];
    if (Array.isArray(available)) {
      available.forEach(function (tok) {
        if (tok == null || tok === '') return;
        var s = String(tok);
        if (list.indexOf(s) === -1) list.push(s);
      });
    }
    if (!list.length) return null;
    var i, tok, d, r, best = null, bestD = 1e9, bestR = -1;
    var wr = effortRank(w);
    for (i = 0; i < list.length; i++) {
      tok = list[i];
      if (normalizeEffort(tok) === w) return tok;
    }
    if (wr < 0) return null;
    for (i = 0; i < list.length; i++) {
      tok = list[i];
      r = effortRank(tok);
      if (r < 0) continue;
      d = Math.abs(r - wr);
      if (d < bestD || (d === bestD && r > bestR)) {
        bestD = d;
        bestR = r;
        best = tok;
      }
    }
    return best;
  }

  function parseEffortList(m) {
    if (!m || typeof m !== 'object') return [];
    var out = [];
    function add(v) {
      if (v == null || v === '') return;
      var s = String(v);
      if (out.indexOf(s) === -1) out.push(s);
    }
    var raw = m.reasoning_options || m.reasoning_effort_options ||
              m.supported_reasoning_efforts || m.efforts;
    if (typeof raw === 'string') raw = [raw];
    if (Array.isArray(raw)) {
      raw.forEach(function (o) {
        if (o == null) return;
        if (typeof o === 'string') add(o);
        else if (Array.isArray(o.values) && (o.type === 'effort' || !o.type)) {
          o.values.forEach(add);
        }
      });
    }
    var params = m.supported_parameters || m.supported_params;
    if (typeof params === 'string') params = [params];
    return out;
  }

  function guessEffortList(id, style) {
    id = String(id || '').toLowerCase();
    if (style === 'glm' || /glm-?5/.test(id)) return ['low', 'high', 'max'];
    if (style === 'qwen') return ['off', 'low', 'medium', 'high', 'max'];
    if (style === 'openai' || style === 'openrouter' ||
        /^(o1|o3|o4|gpt-5)/.test(id) || /gpt-5/.test(id)) {
      return ['none', 'low', 'medium', 'high', 'xhigh'];
    }
    return [];
  }

  function protocolEffortList(style, meta, id) {
    if (meta && meta.efforts && meta.efforts.length) return meta.efforts;
    return guessEffortList(id, style);
  }

  function parseModelEntry(m) {
    if (!m) return null;
    if (typeof m === 'string') m = { id: m };
    var id = m.id || m.name || '';
    if (!id) return null;
    var params = m.supported_parameters || m.supported_params || [];
    if (typeof params === 'string') params = [params];
    var thinking = false;
    if (Array.isArray(params)) {
      thinking = params.indexOf('reasoning') !== -1 ||
                 params.indexOf('include_reasoning') !== -1 ||
                 params.indexOf('reasoning_effort') !== -1 ||
                 params.indexOf('enable_thinking') !== -1;
    }
    if (m.architecture && m.architecture.instruct_type === 'deepseek-r1') thinking = true;
    if (m.reasoning === true || m.thinking === true) thinking = true;
    var efforts = parseEffortList(m);
    if (efforts.length) thinking = true;
    var ro = m.reasoning_options;
    if (Array.isArray(ro)) {
      ro.forEach(function (o) {
        if (o && o.type === 'toggle') thinking = true;
      });
    }
    return {
      id: id,
      context: parseContextField(m) || guessContext(id),
      thinking: thinking,
      efforts: efforts
    };
  }

  function detectThinkingStyle(llm, meta, modelId) {
    var style = (llm && llm.thinkingStyle) || 'auto';
    if (style && style !== 'auto') return style;
    var url = String((llm && llm.baseUrl) || '');
    var id = String(modelId || (llm && llm.model) || (meta && meta.id) || '');
    if (meta && meta.style && meta.style !== 'auto') return meta.style;
    if (/openrouter\.ai/i.test(url)) return 'openrouter';
    if (/dashscope|aliyuncs/i.test(url)) return 'qwen';
    if (/bigmodel\.cn|zhipuai/i.test(url) || /glm-?5/i.test(id)) return 'glm';
    if (/qwq|qwen.*think/i.test(id)) return 'qwen';
    if (meta && meta.thinking) return /openrouter/i.test(url) ? 'openrouter' : 'openai';
    if (/^(o1|o3|o4|gpt-5)/i.test(id) || /reasoner|r1|qwq/i.test(id)) {
      return /qwen|dashscope/i.test(url + id) ? 'qwen' : 'openai';
    }
    return 'none';
  }

  function qwenBudget(mapped) {
    var n = normalizeEffort(mapped);
    if (n === 'off' || n === 'default') return 0;
    if (n === 'xhigh') n = 'max';
    return QWEN_BUDGET[n] || QWEN_BUDGET.medium;
  }

  function attachThinking(body, llm, meta) {
    var mode = (llm && llm.thinking) || 'auto';
    var id = String((llm && llm.model) || (body && body.model) || (meta && meta.id) || '');
    var style = detectThinkingStyle(llm, meta, id);
    var wanted = normalizeEffort(llm && llm.thinkingEffort);
    if (mode === 'off') wanted = 'off';
    if (style === 'none') return body;
    var available = protocolEffortList(style, meta, id);
    var mapped = mapEffort(wanted, available);

    if (wanted === 'default') {
      if (mode !== 'on') return body;
      if (style === 'qwen') {
        body.enable_thinking = true;
        return body;
      }
      if (style === 'glm') {
        body.thinking = { type: 'enabled' };
        return body;
      }
      return body;
    }

    if (style === 'openai') {
      if (mapped) body.reasoning_effort = mapped;
      return body;
    }
    if (style === 'openrouter') {
      if (mapped) body.reasoning = { effort: mapped };
      return body;
    }
    if (style === 'qwen') {
      if (wanted === 'off' || normalizeEffort(mapped) === 'off') {
        body.enable_thinking = false;
        return body;
      }
      body.enable_thinking = true;
      var budget = qwenBudget(mapped || wanted);
      if (budget > 0) body.thinking_budget = budget;
      return body;
    }
    if (style === 'glm') {
      body.thinking = { type: 'enabled' };
      if (mapped) body.reasoning_effort = mapped;
      return body;
    }
    return body;
  }

  var _modelMeta = null;

  function resolvedContext(llm) {
    var n = Number(llm && llm.contextWindow);
    if (n > 1024) return Math.floor(n);
    if (_modelMeta && _modelMeta.id === (llm && llm.model) && _modelMeta.context > 1024) {
      return _modelMeta.context;
    }
    return guessContext(llm && llm.model) || 32768;
  }

  var Api = {
    EMOTIONS: EMOTIONS,
    ATTITUDES: ATTITUDES,
    MODE_TTS: MODE_TTS,
    MODE_PLAY_FX: MODE_PLAY_FX,
    parseTaggedReply: parseTaggedReply,
    buildSystemPrompt: buildSystemPrompt,
    screenTagLine: screenTagLine,
    withTurnCue: withTurnCue,
    formatHistoryReply: formatHistoryReply,
    extractState: extractState,
    isPlaceholderModel: isPlaceholderModel,
    estTokens: estTokens,
    guessContext: guessContext,
    parseModelEntry: parseModelEntry,
    detectThinkingStyle: detectThinkingStyle,
    attachThinking: attachThinking,
    normalizeEffort: normalizeEffort,
    mapEffort: mapEffort,
    EFFORT_UI: EFFORT_UI,
    setModelMeta: function (m) { _modelMeta = m || null; },
    resolvedContext: function () { return resolvedContext(Config.section('llm')); },
    /* test seam: which calls get rewritten onto the same-origin /_proxy
       (nsfw_intent_regression asserts serve.py + ryza://app both route) */
    _localProxy: localProxy,
    QWEN_DEFAULT_BASE: QWEN_DEFAULT_BASE,
    QWEN_TTS_MODELS: QWEN_TTS_MODELS,
    QWEN_TTS_VOICES: QWEN_TTS_VOICES,
    _qwenApiRoot: qwenApiRoot,
    _qwenTtsUrl: qwenTtsUrl,
    _qwenHttpsUrl: qwenHttpsUrl,
    _qwenTtsKind: qwenTtsKind,
    _qwenDefaultVoice: qwenDefaultVoice,
    FISH_DEFAULT_BASE: FISH_DEFAULT_BASE,
    FISH_DEFAULT_VOICE: FISH_DEFAULT_VOICE,
    FISH_TTS_MODELS: FISH_TTS_MODELS,
    _fishApiRoot: fishApiRoot,
    _fishTtsUrl: fishTtsUrl,
    _fishLanguage: fishLanguage,
    _fishSampleUrls: fishSampleUrls,
    /* resolved per-mode TTS voice direction (base hint + mode layer) */
    ttsStyleFor: function (mode) { return ttsStyleFor(mode, Config.section('tts')); },

    /* resolved reply language (auto = UI) */
    replyLang: function () {
      return (window.Langs && Langs.llm()) || 'ja';
    },

    /* ------------------------------------------------- translate channel
       Used when the TTS language differs from the reply language: the
       displayed text stays, the spoken text is re-voiced in another
       language by the same LLM. */
    translate: function (text, toLang) {
      if (!text || !toLang || toLang === Api.replyLang()) {
        return Promise.resolve(text);
      }
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.resolve(text);
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')), {
        model: llm.model,
        messages: [
          { role: 'system', content: 'You are a translator for a Japanese anime game character (Ryza, cheerful young alchemist). Translate her line into ' + langName(toLang) + ', keeping the playful spoken tone, first-person feel and emotion. Output ONLY the translated line — no quotes, notes or tags.' },
          { role: 'user', content: text }
        ],
        temperature: 0.3,
        max_tokens: Math.max(80, (llm.maxTokens || 400))
      }, llm.apiKey, 60000).then(function (j) {
        var c = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
        return (c && String(c).trim()) || text;
      }).catch(function () { return text; });
    },

    /* ------------------------------------------------------------- LLM */
    chat: function (history, userText, opts) {
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      opts = opts || {};
      var st = Config.section('state');
      var outLang = opts.lang || Api.replyLang();
      var mem = '';
      try { if (window.Memory) mem = Memory.promptBlock() || ''; } catch (e) { mem = ''; }
      var system = buildSystemPrompt(opts.mode || st.mode, opts.style || st.style,
                                     opts.rpgContext || '', outLang, opts.nsfwSection || '',
                                     opts.sceneSection || '', mem);
      var keep = Math.max(0, (llm.historyTurns || 12) * 2);
      var hist = (history || []).slice(-keep);
      var ctx = resolvedContext(llm);
      var reserve = Math.max(256, Number(llm.maxTokens) || 400) + 96;
      var budget = Math.max(1024, ctx - reserve);
      function pack(h) {
        return [{ role: 'system', content: system }]
          .concat(h)
          .concat([{ role: 'user', content: withTurnCue(userText) }]);
      }
      var used = estMessages(pack(hist));
      while (hist.length > 2 && used > budget) {
        hist = hist.slice(2);
        used = estMessages(pack(hist));
      }
      if (used > budget * 0.85) {
        try { if (window.Memory) Memory.notifyPressure(); } catch (e) {}
      }
      var body = {
        model: llm.model, messages: pack(hist),
        temperature: Number(llm.temperature) || 0.9,
        max_tokens: Number(llm.maxTokens) || 400
      };
      attachThinking(body, llm, _modelMeta && _modelMeta.id === llm.model ? _modelMeta : null);
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')),
                     body, llm.apiKey).then(function (j) {
        return parseTaggedReply(choiceText(j));
      });
    },

    /* Short completion without persona / tags / thinking — memory rollup. */
    complete: function (system, user, opts) {
      opts = opts || {};
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      return request(localProxy(upstreamUrl(llm.baseUrl, '/chat/completions')), {
        model: llm.model,
        messages: [
          { role: 'system', content: String(system || '') },
          { role: 'user', content: String(user || '') }
        ],
        temperature: opts.temperature != null ? opts.temperature : 0.2,
        max_tokens: opts.maxTokens || 280
      }, llm.apiKey, opts.timeout || 60000).then(function (j) {
        return String(choiceText(j) || '').trim();
      });
    },

    listModels: function () {
      var llm = Config.section('llm');
      if (!llm.apiKey) return Promise.reject(new Error('NO_KEY'));
      if (!llm.baseUrl) return Promise.reject(new Error('NO_URL'));
      return requestGet(localProxy(upstreamUrl(llm.baseUrl, '/models')), llm.apiKey, 20000)
        .then(function (j) {
          var raw = (j && (j.data || j.models || j.data && j.data.data)) || [];
          if (!Array.isArray(raw)) raw = [];
          var out = [];
          raw.forEach(function (m) {
            var e = parseModelEntry(m);
            if (e) out.push(e);
          });
          out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
          var cur = out.filter(function (e) { return e.id === llm.model; })[0];
          _modelMeta = cur || (out[0] || null);
          return out;
        });
    },

    /* DashScope-compatible hosts rarely put TTS ids on /v1/models, so this
       also tries compatible-mode, then filters to HTTP (non-realtime) speech
       models. Empty result is not a failure — the user can type any id. */
    listQwenTtsModels: function () {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var root = qwenApiRoot(tts.qwenBaseUrl);
      var urls = [
        root + '/compatible-mode/v1/models',
        root + '/api/v1/models'
      ];
      function pull(i) {
        if (i >= urls.length) return Promise.resolve([]);
        return requestGet(localProxy(urls[i]), tts.qwenApiKey, 20000)
          .then(function (j) {
            var list = parseQwenModelList(j);
            if (list.length) return list;
            return pull(i + 1);
          })
          .catch(function () { return pull(i + 1); });
      }
      return pull(0);
    },

    /* ------------------------------------------------------------- TTS */
    /* Resolves to a Blob URL. Returns null when voice is disabled.
       provider: 'openai' (chat/completions + audio, MiMo-style),
       'qwen' (DashScope-compatible TTS), or 'fish' (Fish Audio Open API
       POST /speech/tts, binary audio). `mode` is the talk mode. */
    speak: function (text, lang, mode) {
      var tts = Config.section('tts');
      if (tts.mode === 'off') return Promise.resolve(null);
      mode = mode || (Config.section('state') || {}).mode || 'chat';
      /* Per-provider credentials: qwen has its own baseUrl/apiKey so a MiMo
         setup can never leak into a DashScope call (or back). */
      if ((tts.provider || 'openai') === 'qwen') return Api._qwenSpeak(text, lang, mode);
      if (tts.provider === 'fish') return Api._fishSpeak(text, lang, mode);
      if (!tts.apiKey) return Promise.reject(new Error('NO_KEY'));

      var audio = { format: tts.format || 'wav' };
      if (tts.mode === 'clone') {
        audio.voice = 'pending';   // filled in below, once the wav is base64'd
      } else {
        audio.voice = tts.presetVoice || 'Chloe';
      }

      var model = tts.mode === 'clone' ? tts.modelClone : tts.modelPreset;
      /* The shipped defaults are placeholders; sending them yields the
         server's confusing "unsupported model tts-model". Fail locally with
         a clear, translated toast instead. */
      if (isPlaceholderModel(model)) {
        return Promise.reject(new Error('NO_MODEL'));
      }
      var styleHint = ttsStyleFor(mode, tts);

      function send(voiceField) {
        audio.voice = voiceField;
        return request(localProxy(upstreamUrl(tts.baseUrl, '/chat/completions')), {
          model: model,
          messages: [
            { role: 'user', content: styleHint },
            { role: 'assistant', content: text }
          ],
          audio: audio
        }, tts.apiKey, 180000).then(function (j) {
          var msg = j.choices && j.choices[0] && j.choices[0].message;
          var data = msg && msg.audio && msg.audio.data;
          if (!data) throw new Error('接口未返回音频');
          return Api._b64ToUrl(data, tts.format === 'mp3' ? 'audio/mpeg' : 'audio/wav');
        });
      }

      if (tts.mode === 'clone') {
        return Api._fetchAsDataUrl(tts.reference).then(send);
      }
      return send(audio.voice);
    },

    /* ------------------------------------------- Qwen / Bailian (DashScope) */
    _qwenSpeak: function (text, lang, mode) {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var lg = lang || (window.Langs ? Langs.tts() : 'ja');
      var langType = window.Langs ? Langs.ttsLangType(lg) : 'Auto';
      var model = String(tts.qwenModel || 'qwen3-tts-flash').trim() || 'qwen3-tts-flash';
      var kind = qwenTtsKind(model);
      var voice = qwenDefaultVoice(model, tts.qwenVoice);
      var input = { text: text, voice: voice };
      if (kind === 'speech') {
        input.format = 'wav';
        input.sample_rate = 24000;
        if (/qwen-audio/i.test(model)) input.language_type = langType;
      } else {
        input.language_type = langType;
      }
      if (qwenWantsInstructions(model)) {
        var style = ttsStyleFor(mode || 'chat', tts);
        if (style) {
          if (kind === 'speech') input.instruction = style;
          else input.instructions = style;
        }
      }
      return request(localProxy(qwenTtsUrl(tts.qwenBaseUrl, model)), {
        model: model,
        input: input
      }, tts.qwenApiKey, 180000).then(function (j) {
        var aud = j && j.output && j.output.audio;
        var data = aud && String(aud.data || '').trim();
        var url = aud && aud.url;
        if (data) return Api._b64ToUrl(data, 'audio/wav');
        if (url) return Api._downloadUrl(url);
        throw new Error('Qwen TTS 未返回音频');
      });
    },

    /* DashScope often returns an http:// OSS URL. The local /_proxy only
       forwards https, and Android cleartext is blocked — rewrite first.
       Fish cached TTS URLs need the same Bearer key. */
    _downloadUrl: function (url, apiKey) {
      var headers = {};
      if (apiKey) headers.Authorization = 'Bearer ' + apiKey;
      return fetch(localProxy(qwenHttpsUrl(url)), { headers: headers }).then(function (r) {
        if (!r.ok) throw new Error('音频下载失败 HTTP ' + r.status);
        return r.blob();
      }).then(function (blob) { return URL.createObjectURL(blob); });
    },

    /* ------------------------------------------- Fish Audio Open API TTS */
    _fishSpeak: function (text, lang, mode) {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      function synth(voice) {
        var model = String(tts.fishModel || 'fishaudio-s21pro-flash').trim() ||
                    'fishaudio-s21pro-flash';
        var lg = lang || (window.Langs ? Langs.tts() : 'ja');
        var fmt = (tts.format === 'mp3') ? 'mp3' : 'wav';
        var body = {
          text: text,
          voiceId: voice,
          reference_id: voice,
          modelId: model,
          format: fmt
        };
        var fishLang = fishLanguage(lg);
        if (fishLang) body.language = fishLang;
        if (fishWantsInstruction(model)) {
          var style = ttsStyleFor(mode || 'chat', tts);
          if (style) body.instruction = style;
        }
        if (fishWantsEmotion(model)) {
          var emo = fishEmotion();
          if (emo) body.emotion = emo;
        }
        return requestAudio(localProxy(fishTtsUrl(tts.fishBaseUrl)), body, tts.fishApiKey, 180000);
      }
      var voice = String(tts.fishVoice || '').trim();
      if (voice) return synth(voice);
      if (_fishCloneWait) return _fishCloneWait.then(synth);
      _fishCloneWait = Api.fishCloneVoice().then(function (vid) {
        try { Config.set('tts.fishVoice', vid); } catch (e) {}
        _fishCloneWait = null;
        return vid;
      }, function (err) {
        _fishCloneWait = null;
        throw err;
      });
      return _fishCloneWait.then(synth);
    },

    listFishVoices: function () {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      var root = fishApiRoot(tts.fishBaseUrl);
      return requestGet(localProxy(root + '/voices?pageSize=100&includePersonal=true'),
                        tts.fishApiKey, 20000)
        .then(function (j) {
          var items = (j && j.items) || [];
          var out = [], seen = {};
          items.forEach(function (it) {
            if (!it) return;
            var id = it.voiceId || it.voice_id || it.id;
            if (!id || seen[id]) return;
            seen[id] = 1;
            out.push({ id: id, title: it.title || it.name || id });
          });
          return out;
        });
    },

    fishCloneVoice: function () {
      var tts = Config.section('tts');
      if (!tts.fishApiKey) return Promise.reject(new Error('NO_KEY'));
      return Promise.all(fishSampleUrls().map(function (url) {
        return fetch(url).then(function (r) {
          if (!r.ok) return null;
          return r.blob().then(function (blob) {
            if (!blob || !blob.size) return null;
            return { blob: blob, name: url.split('/').pop() || 'sample.wav' };
          });
        }).catch(function () { return null; });
      })).then(function (parts) {
        var files = parts.filter(Boolean);
        var wavs = files.filter(function (f) { return /\.wav$/i.test(f.name); });
        if (wavs.length) files = wavs;
        if (!files.length) {
          throw new Error('找不到本地莱莎原声（需要 assets/audio/prologue/jp/*.m4a 或 voice/ryza_wav/*.wav）');
        }
        var fd = new FormData();
        fd.append('name', 'ryza');
        fd.append('description', 'Local Ryza prologue clone');
        fd.append('visibility', 'private');
        fd.append('languages', JSON.stringify(['ja', 'zh', 'en']));
        files.forEach(function (f) { fd.append('audioFiles', f.blob, f.name); });
        return requestForm(localProxy(fishApiRoot(tts.fishBaseUrl) + '/voices'),
                           fd, tts.fishApiKey, 180000);
      }).then(function (j) {
        var vid = j && (j.voiceId || j.voice_id);
        if (!vid) throw new Error(apiErrorMessage(j, 200, '') || '未返回 voiceId');
        return vid;
      });
    },

    /* 声音复刻: register the shipped Ryza reference wav (data URI — the
       endpoint accepts base64 data URIs, no public hosting needed) and
       return the voice_id. target_model must match the synthesis model. */
    qwenCloneVoice: function () {
      var tts = Config.section('tts');
      if (!tts.qwenApiKey) return Promise.reject(new Error('NO_KEY'));
      var target = String(tts.qwenCloneTarget || 'qwen3-tts-vc-2026-01-22').trim();
      return Api._fetchAsDataUrl(tts.reference).then(function (dataUri) {
        return request(localProxy(qwenTtsUrl(tts.qwenBaseUrl, 'voice-enrollment')), {
          model: 'voice-enrollment',
          input: {
            action: 'create_voice',
            target_model: target,
            prefix: 'ryza',
            preferred_name: 'ryza',
            url: dataUri
          }
        }, tts.qwenApiKey, 120000);
      }).then(function (j) {
        var out = j && j.output;
        var vid = out && (out.voice_id || out.voice);
        if (!vid) throw new Error(apiErrorMessage(j, 200, '') || '未返回 voice_id');
        return vid;
      });
    },

    _b64ToUrl: function (b64, mime) {
      var bin = atob(b64), arr = new Uint8Array(bin.length), i;
      for (i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return URL.createObjectURL(new Blob([arr], { type: mime }));
    },

    /* Reference audio must reach the API as `data:audio/wav;base64,...`. */
    _fetchAsDataUrl: function (path) {
      return fetch(path).then(function (r) {
        if (!r.ok) throw new Error('无法读取参考音频：' + path);
        return r.arrayBuffer();
      }).then(function (buf) {
        var bytes = new Uint8Array(buf), s = '', i;
        for (i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return 'data:audio/wav;base64,' + btoa(s);
      });
    }
  };

  global.Api = Api;
})(window);
