/* Settings store. Everything lives in localStorage; there is no server.
   The original app's account/subscription backend and its Firebase sign-in
   are intentionally absent — this build boots straight into the game and never
   calls anything but the endpoints the player types into Settings.

   Defaults are neutral on purpose: this file ships inside the desktop/
   Android packages, so no personal endpoint belongs here. Fill yours via
   Settings, or via an uncommitted config/providers.json (dev server only —
   scripts/privacy_check.py fails the build if it ever reaches a package). */
(function (global) {
  'use strict';

  var KEY = 'ryza.settings.v1';

  var DEFAULTS = {
    /* ---- LLM (OpenAI-compatible) ---- */
    llm: {
      baseUrl: '',
      model: 'gpt-4o-mini',
      apiKey: '',
      temperature: 0.9,
      maxTokens: 400,
      historyTurns: 12,
      contextWindow: 0,            // 0 = guess from model id / /v1/models
      thinking: 'auto',            // auto | off | on
      thinkingEffort: 'default',   // default | off | low | medium | high | max  (xhigh→max)
      thinkingStyle: 'auto',       // auto | none | openai | openrouter | qwen | glm
      lang: 'auto'                   // 回复语言（auto=跟随界面）
    },

    /* Two-layer conversation memory (web/js/memory.js). */
    memory: {
      enabled: true,
      turnsPerSession: 8,          // exchanges per 会话 card
      sessionCap: 8,               // 会话 cards before they fold into one 总结
      summaryCap: 8                // 总结 cards before they fold into one same-layer 总结
    },

    /* ---- TTS providers ----
       provider 'openai': any OpenAI-compatible chat/completions + audio.voice
                          (e.g. Xiaomi MiMo voice-clone).
       provider 'qwen'  : DashScope-compatible TTS (official, workspace, or
                          a third-party host with the same /api/v1/services
                          paths). Model id is free-typed; qwen3-tts-* uses
                          multimodal-generation, qwen-audio-* / cosyvoice-*
                          use SpeechSynthesizer.
       provider 'fish'  : Fish Audio (https://api.fish.audio, engine named in a
                          `model` header). fishVoice empty = clone from local
                          Ryza prologue samples on first speak (older Open API
                          only); fishModel empty = the surface's own default
                          (s2.1-pro-free on the current API).
                          fishVoiceAsmr = a SECOND voice id used in ASMR mode. */
    /* Speech input: the transcription endpoint (provider registry row kind
       'stt'). Kept apart from `app.stt`, which is only the on/off master switch
       — this section is the transport, so it has its own endpoint and key like
       every other provider (switching hosts must not carry a stale key along). */
    stt: {
      provider: 'whisper',
      baseUrl: '',                   // player's own OpenAI-compatible endpoint
      apiKey: '',
      model: 'whisper-1',
      /* 'auto' prefers the browser recogniser when it exists (streaming and
         zero-config) and falls back to our own capture + this endpoint. Force it
         either way if a host's recogniser misbehaves without saying so. */
      engine: 'auto'
    },
    tts: {
      provider: 'openai',
      baseUrl: '',
      apiKey: '',
      mode: 'clone',                 // 'clone' | 'preset' | 'off'
      modelClone: 'voice-clone-model',
      modelPreset: 'tts-model',
      presetVoice: 'Chloe',
      format: 'wav',
      // Ryza's own take, shipped inside the APK.
      reference: 'assets/voice/ryza_wav/prologue_08.wav',
      /* Base voice identity ("who talks"). Per-mode delivery ("how": ASMR
         whisper, story narrator…) lives in api.js MODE_TTS and is layered
         on top; put a string here (or per mode in modeHints) to override. */
      styleHint: '明るく元気な若い女性の声。親しみやすい口調で。',
      modeHints: {},                 // { chat, story, immersive, asmr, text } overrides
      /* qwen-specific — endpoint + key are SEPARATE from the openai ones so
         switching providers never sends a MiMo URL/key to DashScope or back.
         Empty qwenBaseUrl falls back to the public DashScope host. */
      qwenBaseUrl: '',
      qwenApiKey: '',
      qwenModel: 'qwen3-tts-flash',  // any current DashScope TTS id; typed or fetched
      qwenVoice: 'Cherry',           // preset name, or voice_id from 声音复刻
      qwenCloneTarget: 'qwen3-tts-vc-2026-01-22',
      /* fish-specific — endpoint + key + voice are SEPARATE from openai/qwen.
         fishBaseUrl empty = the official current API (api.fish.audio). The
         model id must be left EMPTY to get the surface's own default: the two
         surfaces name engines differently, so a value shipped here would be
         the wrong engine on one of them (that is how s2.1-pro-free got sent as
         fishaudio-s21pro-flash on a fresh install). */
      fishBaseUrl: '',
      fishApiKey: '',
      fishModel: '',
      fishVoice: '',
      /* ASMR speaks with its own voice when set (whisper register); empty
         falls back to fishVoice. */
      fishVoiceAsmr: '',
      lang: 'auto'                   // 朗读语言（auto=与 llm.lang 实际值一致）
    },

    /* ---- language matrix (all independent) ----
       app.lang   = UI strings            (zh | zh-tw | ja | en | hi | id | pt-br)
       voice.lang = shipped voice packs   ('auto' = follow UI, or an explicit code)
       llm.lang   = what the model writes ('auto' = follow UI)
       tts.lang   = what the voice speaks ('auto' = same as llm.lang; anything else
                    triggers an LLM translation pass before synthesis) */
    voice: { lang: 'auto' },

    /* ---- character / persona (fed into the system prompt) ---- */
    chara: {
      personality: '明るく前向き、少しおっちょこちょいな錬金術士',
      likes: '調合、冒険、甘いもの',
      dislikes: 'じっとしていること',
      situation: 'クーケン島の自分の家で、君と一緒に過ごしている',
      callMe: '君',
      extra: '',
      /* Optional replacement for the built-in Ryza character block. Empty =
         ship the default. When set, it swaps ONLY the character description;
         the reply protocol (tag line + <state>), the output-language rules and
         the per-turn scene block still come from api.js, so a custom persona
         can't break the avatar or the RPG state. */
      systemPromptOverride: ''
    },

    /* ---- player profile (onboarding answers) ---- */
    profile: {
      name: '', birthday: '', gender: '',
      appearance: '', background: '', hobby: '', interest: '',
      interestExtra: '', storyStart: '',
      futureGoals: '', personality: ''
    },

    audio: { bgm: 0.55, ambient: 0.45, voice: 1, se: 0.85 },

    /* ---- presentation ---- */
    app: {
      lang: 'zh',                    // zh | zh-tw | ja | en | hi | id | pt-br
      voice: true,
      volume: 0.9,
      textSpeed: 30,                 // ms per character (×1; see TEXT_SPEEDS)
      vibration: true,
      fullscreen: false,
      rim: true,
      nsfwEnabled: false,            // explicit user permission; AI cannot enable it when off
      showBubble: true,              // talk bubbles over the stage (auto-fade)
      stt: 'off',                    // off | webSpeech — microphone input (browser recogniser)
      autoSend: false,               // send an accepted transcript without a tap
      autoSendDelay: 2000,           // ms before auto-send once the mic goes quiet
      npcFrequency: 'normal',          // restrained | normal | frequent | lively (see npc.js)
      bargeIn: false,                // 你开口就打断她（需回声消除；见 voice.js 末尾说明）
      quickCollapsed: false,         // 收起右侧快捷钮（只留一个展开键，见 index.html #quick-btns）
      timeMode: 'real',              // real=墙钟(LLM不可拨) | flow=游戏钟(LLM可拨) | manual=🌤
      flowSpeed: 60,                 // flow: in-game minutes per real minute (60 ⇒ 1 game hr / real min)
      cheat: false                   // 作弊：体力 + 金币无限（地图/任务不改）
    },

    /* ---- session state ---- */
    state: {
      mode: 'chat',                  // chat | story | immersive | asmr | text
      style: 'voice',                // voice | text
      skin: 'crf_skn_002_0001',
      stage: 'stage_01_001_04',      // ライザの家
      tod: 'aft',                    // mor | aft | eve | ngt
      /* Standing (crf_skn_002_0001_99) is the default posture. Only scenes
         whose midgroundPostures lists BOTH postures honour the choice — in the
         shipped pack that is 隠れ家前 / stage_01_002_01 alone; every other
         scene dictates its own posture (Avatar.postureKey reads the scene). */
      posture: 'posture_standing',
      day: 1,
      lastDayDate: '',
      /* flow-mode in-game clock: gameHour (0-24) + the real ms it was last
         synced; tod is derived from it. todManualUntil = real ms a manual 🌤
         tap suppresses auto-sync for (so a hand-set time isn't clobbered). */
      gameHour: 12,
      gameClockAt: 0,
      todManualUntil: 0,
      onboardingDone: false,
      welcome: { talk: false, map: false, alarm: false, skin: false, quest: false }
    }
  };

  function deepMerge(base, patch) {
    var out = Array.isArray(base) ? base.slice() : {};
    var k;
    for (k in base) if (Object.prototype.hasOwnProperty.call(base, k)) out[k] = base[k];
    for (k in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, k)) continue;
      var v = patch[k];
      out[k] = (v && typeof v === 'object' && !Array.isArray(v) &&
                base[k] && typeof base[k] === 'object' && !Array.isArray(base[k]))
        ? deepMerge(base[k], v) : v;
    }
    return out;
  }

  var data;
  try {
    data = deepMerge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}'));
  } catch (e) {
    data = deepMerge(DEFAULTS, {});
  }
  if (data.state && data.state.skin) {
    data.state.skin = String(data.state.skin).replace(/_(01|99)$/, '');
  }
  /* One-time migration: qwen got its own baseUrl/apiKey (they used to share
     the openai fields, which made provider switching send a MiMo URL/key to
     DashScope and back). Whoever was ACTIVELY on qwen meant the shared
     values for qwen — carry them over once. */
  if (data.tts && data.tts.provider === 'qwen') {
    if (!data.tts.qwenApiKey && data.tts.apiKey) data.tts.qwenApiKey = data.tts.apiKey;
    if (!data.tts.qwenBaseUrl && data.tts.baseUrl) data.tts.qwenBaseUrl = data.tts.baseUrl;
  }
  /* Public catalog id we tried first is not on Open API; empty means
     clone from local Ryza prologue samples on first speak. */
  if (data.tts && data.tts.fishVoice === '2bc96959c27d41cc87d517b83569d43a') {
    data.tts.fishVoice = '';
  }
  /* One-time migration: fishModel used to SHIP as the older Open API's engine
     name while the base URL field was empty, and empty now means the current
     API (api.fish.audio) — which does not have that engine. Drop the leftover
     shipped value so the surface supplies its own default; a player who typed
     a legacy URL keeps whatever they chose, because there it is correct. */
  if (data.tts && !data.tts.fishModelMigrated) {
    var fbase = String(data.tts.fishBaseUrl || '');
    var legacyHost = /fishaudio\.org|\/api\/open\//i.test(fbase);
    if (!legacyHost && data.tts.fishModel === 'fishaudio-s21pro-flash') {
      data.tts.fishModel = '';
    }
    data.tts.fishModelMigrated = true;
  }
  /* One-time migration: `posture_sitting` used to be the shipped default, so
     an old save carries it even though sitting is only selectable on the one
     dual-posture stage — where the source starts STANDING (_99). Reset once;
     after that the player's own choice on that stage is respected. */
  if (data.state && !data.state.postureMigrated) {
    data.state.posture = 'posture_standing';
    data.state.postureMigrated = true;
  }

  /* Text-speed steps and their icons. Shared UI data: settings.js builds the
     picker from it and app.js cycles through it from the ×N button, so it lives
     with the other tables rather than inside either of them. */
  var TEXT_SPEEDS = [
    { v: 30, icon: 'text_speed_1x' },
    { v: 18, icon: 'text_speed_15x' },
    { v: 12, icon: 'text_speed_2x' },
    { v: 8,  icon: 'text_speed_3x' }
  ];

  var Config = {
    TEXT_SPEEDS: TEXT_SPEEDS,
    /* The active text speed, resolved against the table above. Callers used to
       write `|| 28` — a number that is not even in TEXT_SPEEDS — in four places,
       so changing the table's steps left all four silently coercing to a value
       the picker cannot select. Fallback and clamp target are the shipped
       default entry, from the one table. */
    textSpeed: function () {
      var v = Number(data.app && data.app.textSpeed);
      for (var i = 0; i < TEXT_SPEEDS.length; i++) {
        if (TEXT_SPEEDS[i].v === v) return v;
      }
      return TEXT_SPEEDS[0].v;
    },
    get: function () { return data; },
    section: function (name) { return data[name]; },
    set: function (path, value) {
      var parts = path.split('.'), node = data, i;
      for (i = 0; i < parts.length - 1; i++) {
        if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
      Config.save();
    },
    save: function () {
      try { localStorage.setItem(KEY, JSON.stringify(data)); } catch (e) {}
    },
    reset: function () {
      data = deepMerge(DEFAULTS, {});
      Config.save();
    },
    /* Whole-settings import/export, used by the settings screen. */
    exportJSON: function () { return JSON.stringify(data, null, 2); },
    importJSON: function (text) {
      var parsed = JSON.parse(text);
      data = deepMerge(DEFAULTS, parsed);
      if (data.state && data.state.skin) {
        data.state.skin = String(data.state.skin).replace(/_(01|99)$/, '');
      }
      Config.save();
    },
    /* local_save_data_eraser.dart equivalent: everything this app wrote. */
    eraseAll: function () {
      var doomed = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf('ryza.') === 0) doomed.push(k);
      }
      doomed.forEach(function (k) { localStorage.removeItem(k); });
      data = deepMerge(DEFAULTS, {});          /* drop the in-memory copy too —
        otherwise a stale Config.set() after a wipe resurrects the old save */
      Config._hydrated = Promise.resolve();   // never re-hydrate after a wipe
    },

    /* Fill connection settings from config/providers.json.
       Empty keys get filled; a saved endpoint that isn't the providers host
       (stale localStorage) is replaced so chat actually reaches the model. */
    hydrate: function () {
      if (Config._hydrated) return Config._hydrated;
      Config._hydrated = fetch('config/providers.json').then(function (r) {
        return r.ok ? r.json() : null;
      }).then(function (p) {
        if (!p) return;
        function hostOf(u) {
          try { return new URL(u).host; } catch (e) { return ''; }
        }
        if (p.llm) {
          var llmHostOk = p.llm.base_url && hostOf(data.llm.baseUrl) === hostOf(p.llm.base_url);
          if (!data.llm.apiKey || !llmHostOk) {
            if (p.llm.base_url) data.llm.baseUrl = p.llm.base_url;
            if (p.llm.model) data.llm.model = p.llm.model;
            if (p.llm.api_key) data.llm.apiKey = p.llm.api_key;
            if (p.llm.temperature != null) data.llm.temperature = p.llm.temperature;
          }
        }
        if (p.tts) {
          var ttsHostOk = p.tts.base_url && hostOf(data.tts.baseUrl) === hostOf(p.tts.base_url);
          if (!data.tts.apiKey || !ttsHostOk) {
            if (p.tts.base_url) data.tts.baseUrl = p.tts.base_url;
            if (p.tts.api_key) data.tts.apiKey = p.tts.api_key;
            if (p.tts.model_clone) data.tts.modelClone = p.tts.model_clone;
            if (p.tts.model_preset) data.tts.modelPreset = p.tts.model_preset;
            if (p.tts.reference_audio) data.tts.reference = p.tts.reference_audio;
          }
          if (p.tts.qwen_api_key && !data.tts.qwenApiKey) {
            data.tts.qwenApiKey = p.tts.qwen_api_key;
            if (p.tts.qwen_base_url) data.tts.qwenBaseUrl = p.tts.qwen_base_url;
          }
          if (p.tts.fish_api_key && !data.tts.fishApiKey) {
            data.tts.fishApiKey = p.tts.fish_api_key;
            if (p.tts.fish_base_url) data.tts.fishBaseUrl = p.tts.fish_base_url;
            if (p.tts.fish_model) data.tts.fishModel = p.tts.fish_model;
            if (p.tts.fish_voice) data.tts.fishVoice = p.tts.fish_voice;
            if (p.tts.fish_voice_asmr) data.tts.fishVoiceAsmr = p.tts.fish_voice_asmr;
            if (p.tts.provider === 'fish') data.tts.provider = 'fish';
          }
        }
        Config.save();
      }).catch(function () {});
      return Config._hydrated;
    }
  };

  global.Config = Config;
})(window);
