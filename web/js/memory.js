/* Two-layer conversation memory. Independent of Game.s.memory (adventure
   log) and App.memory (raw diary the player can still browse).

   sessions  = one card per window of recent turns
   summaries = cards made from sessions; when this layer hits its cap, those
               cards fold into ONE new card still on this layer

   Prompt order is summaries then sessions (stable prefix, new session
   appended at the end) so prefix-cache hits survive a new 会话. */
(function (global) {
  'use strict';

  var KEY = 'ryza.longmem.v1';
  var TEXT_MAX = 2000;

  function cfg() {
    var m = {};
    try { m = (global.Config && Config.section('memory')) || {}; } catch (e) {}
    return {
      enabled: m.enabled !== false,
      turnsPerSession: clampInt(m.turnsPerSession, 8, 2, 32),
      sessionCap: clampInt(m.sessionCap, 8, 2, 24),
      summaryCap: clampInt(m.summaryCap, 8, 2, 24)
    };
  }

  function clampInt(v, d, lo, hi) {
    v = parseInt(v, 10);
    if (v !== v) v = d;
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function uid() {
    return 'm' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function blank() {
    return { v: 1, pending: [], sessions: [], summaries: [] };
  }

  function clip(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, TEXT_MAX);
  }

  function card(layer, text, n) {
    return { id: uid(), layer: layer, text: clip(text), at: Date.now(), n: n | 0 };
  }

  var state = blank();
  var busy = false;

  function persist() {
    try { global.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {}
  }

  function load() {
    try {
      var raw = global.localStorage.getItem(KEY);
      var j = raw ? JSON.parse(raw) : null;
      if (j && j.v === 1 && Array.isArray(j.sessions) && Array.isArray(j.summaries)) {
        state = {
          v: 1,
          pending: Array.isArray(j.pending) ? j.pending : [],
          sessions: j.sessions.filter(validCard),
          summaries: j.summaries.filter(validCard)
        };
        return;
      }
    } catch (e) {}
    state = blank();
  }

  function validCard(c) {
    return c && typeof c === 'object' && c.id && typeof c.text === 'string';
  }

  function fallbackText(items) {
    return items.map(function (it) {
      if (it.text) return it.text;
      var who = it.role === 'user' ? '君' : 'ライザ';
      return who + '：' + clip(it.content || it.text || '');
    }).join(' / ').slice(0, 800);
  }

  function formatPending(pending) {
    return pending.map(function (t) {
      var who = t.role === 'user' ? '君' : 'ライザ';
      return who + '：' + clip(t.text);
    }).join('\n');
  }

  /* Test seam: tests assign a sync function. Production uses Api.complete. */
  var _summarizer = null;

  function summarize(items, kind) {
    if (typeof _summarizer === 'function') {
      try { return Promise.resolve(_summarizer(items, kind)); }
      catch (e) { return Promise.resolve(fallbackText(items)); }
    }
    var body = kind === 'pending'
      ? formatPending(items)
      : items.map(function (it) { return '・' + it.text; }).join('\n');
    var sys = '会話記憶の要約者。与えられた内容を短い箇条書き1本にまとめる。' +
              '固有名詞・約束・感情の変化を残す。タグもJSONも出力しない。200字以内。';
    if (global.Api && typeof Api.complete === 'function') {
      return Api.complete(sys, body, { maxTokens: 280, temperature: 0.2 })
        .then(function (t) { t = clip(t); return t || fallbackText(items); })
        .catch(function () { return fallbackText(items); });
    }
    return Promise.resolve(fallbackText(items));
  }

  function runQueue(fn) {
    if (busy) {
      return busy.then(function () { return fn(); });
    }
    busy = Promise.resolve().then(fn).then(function (v) {
      busy = false;
      return v;
    }, function (e) {
      busy = false;
      throw e;
    });
    return busy;
  }

  function promoteSessions() {
    var c = cfg();
    if (state.sessions.length < c.sessionCap) return Promise.resolve(false);
    var batch = state.sessions.slice();
    return summarize(batch, 'sessions').then(function (text) {
      state.sessions = [];
      state.summaries.push(card('summary', text, batch.length));
      persist();
      return true;
    }).then(function () { return promoteSummaries(); });
  }

  function promoteSummaries() {
    var c = cfg();
    if (state.summaries.length < c.summaryCap) return Promise.resolve(false);
    var batch = state.summaries.slice();
    return summarize(batch, 'summaries').then(function (text) {
      state.summaries = [card('summary', text, batch.length)];
      persist();
      return true;
    });
  }

  function flushPending() {
    var c = cfg();
    if (!state.pending.length) return Promise.resolve(false);
    var batch = state.pending.slice();
    state.pending = [];
    persist();
    return summarize(batch, 'pending').then(function (text) {
      state.sessions.push(card('session', text, Math.ceil(batch.length / 2)));
      persist();
      return promoteSessions();
    });
  }

  function maybeRoll() {
    var c = cfg();
    if (!c.enabled) return Promise.resolve();
    return runQueue(function () {
      var chain = Promise.resolve();
      if (state.pending.length >= c.turnsPerSession * 2) {
        chain = chain.then(flushPending);
      }
      return chain.then(promoteSessions).then(promoteSummaries);
    }).catch(function () {});
  }

  var Memory = {
    KEY: KEY,
    load: load,
    save: persist,
    cfg: cfg,
    snapshot: function () {
      return JSON.parse(JSON.stringify(state));
    },
    restore: function (snap) {
      if (!snap || typeof snap !== 'object') { state = blank(); persist(); return; }
      state = {
        v: 1,
        pending: Array.isArray(snap.pending) ? snap.pending : [],
        sessions: (snap.sessions || []).filter(validCard),
        summaries: (snap.summaries || []).filter(validCard)
      };
      persist();
    },
    reset: function () { state = blank(); persist(); },

    /* One user+assistant exchange. Never throws into the talk loop. */
    ingest: function (userText, assistantText) {
      try {
        if (!cfg().enabled) return;
        var u = clip(userText), a = clip(assistantText);
        if (!u && !a) return;
        if (u) state.pending.push({ role: 'user', text: u, at: Date.now() });
        if (a) state.pending.push({ role: 'assistant', text: a, at: Date.now() });
        persist();
        maybeRoll();
      } catch (e) {}
    },

    flushNow: function () {
      if (!cfg().enabled) return Promise.resolve();
      return runQueue(function () {
        return flushPending().then(promoteSessions).then(promoteSummaries);
      }).catch(function () {});
    },

    /* Context nearly full: dump pending so the next turn's near-window shrinks. */
    notifyPressure: function () {
      try { Memory.flushNow(); } catch (e) {}
    },

    list: function (layer) {
      if (layer === 'summary') return state.summaries.slice();
      if (layer === 'session') return state.sessions.slice();
      return { pending: state.pending.slice(), sessions: state.sessions.slice(),
               summaries: state.summaries.slice() };
    },

    pendingTurns: function () {
      return Math.ceil(state.pending.length / 2);
    },

    get: function (id) {
      var i;
      for (i = 0; i < state.summaries.length; i++) {
        if (state.summaries[i].id === id) return state.summaries[i];
      }
      for (i = 0; i < state.sessions.length; i++) {
        if (state.sessions[i].id === id) return state.sessions[i];
      }
      return null;
    },

    update: function (id, text) {
      var c = Memory.get(id);
      if (!c) return false;
      c.text = clip(text);
      persist();
      return true;
    },

    remove: function (id) {
      var n = state.summaries.length + state.sessions.length;
      state.summaries = state.summaries.filter(function (c) { return c.id !== id; });
      state.sessions = state.sessions.filter(function (c) { return c.id !== id; });
      if (state.summaries.length + state.sessions.length === n) return false;
      persist();
      return true;
    },

    add: function (text, layer) {
      var t = clip(text);
      if (!t) return null;
      var c = card(layer === 'summary' ? 'summary' : 'session', t, 0);
      if (c.layer === 'summary') state.summaries.push(c);
      else state.sessions.push(c);
      persist();
      maybeRoll();
      return c;
    },

    /* Highest layer first, newest session last — prefix-cache friendly. */
    promptBlock: function () {
      if (!cfg().enabled) return '';
      if (!state.summaries.length && !state.sessions.length) return '';
      var L = ['## 長期記憶（下ほど新しい。事実だけ参照）'];
      state.summaries.forEach(function (c) { L.push('- ' + c.text); });
      state.sessions.forEach(function (c) { L.push('- ' + c.text); });
      return L.join('\n');
    },

    setSummarizer: function (fn) { _summarizer = fn; }
  };

  load();
  global.Memory = Memory;
})(typeof window !== 'undefined' ? window : globalThis);
