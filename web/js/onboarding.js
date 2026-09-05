/* Title + onboarding_questions + prologue + tutorial_talk.
   Question widgets follow dart_source_tree: birthday/gender, free text,
   single/multi choice. Copy is reconstructed from i18n keys + recovered lines. */
(function (global) {
  'use strict';

  function questions() {
    return [
      {
        id: 'identity', type: 'identity',
        promptKey: 'onb.identity.prompt', subKey: 'onb.identity.sub'
      },
      {
        id: 'appearance', type: 'text', field: 'profile.appearance',
        promptKey: 'onb.q01.prompt', subKey: 'onb.q01.sub', phKey: 'onb.q01.ph'
      },
      {
        id: 'background', type: 'text', field: 'profile.background',
        promptKey: 'onb.q02.prompt', subKey: 'onb.q02.sub'
      },
      {
        id: 'hobby', type: 'text', field: 'profile.hobby',
        promptKey: 'onb.q03.prompt', subKey: 'onb.q03.sub'
      },
      {
        id: 'activities', type: 'multi', field: 'profile.interest',
        promptKey: 'onb.q04.prompt', subKey: 'onb.q04.sub',
        choices: ['onb.q04.c1', 'onb.q04.c2', 'onb.q04.c3', 'onb.q04.c4', 'onb.q04.c5']
      },
      {
        id: 'alchemy', type: 'multi', field: 'profile.interestExtra',
        promptKey: 'onb.q05.prompt', subKey: 'onb.q05.sub',
        choices: ['onb.q05.c1', 'onb.q05.c2', 'onb.q05.c3', 'onb.q05.c4', 'onb.q05.c5', 'onb.q05.c6']
      },
      {
        id: 'story', type: 'single', field: 'profile.storyStart',
        promptKey: 'onb.q06.prompt', subKey: 'onb.q06.sub',
        choices: ['onb.q06.c1', 'onb.q06.c2']
      },
      {
        id: 'goals', type: 'text', field: 'profile.futureGoals',
        promptKey: 'onb.q07.prompt', subKey: 'onb.q07.sub'
      },
      {
        id: 'personality', type: 'text', field: 'profile.personality',
        promptKey: 'onb.q08.prompt', subKey: 'onb.q08.sub'
      }
    ];
  }

  /* Tutorial lines. The ones marked ✎ are recovered verbatim from the AOT
     snapshot (tutorial_intro_talk_presenter / intro coachmarks / stamina
     copy); the connective tissue around them is ours. */
  var TUTORIAL = [
    { emotion: 'happy', attitude: 'agree', ja: 'やあ、会えたね。あたし、ライザ。これからよろしくね。' },
    { emotion: 'happy', attitude: 'agree', ja: '画面の見方を説明するね。' },                    /* ✎ */
    { emotion: 'neutral', attitude: 'agree', ja: '上のほうのリンゴはあたしのスタミナ。' +
        '無くなると気絶しちゃうから、気をつけて。' +                                              /* ✎ */
        '安全な場所で寝ると回復するよ。' },                                                        /* ✎ */
    { emotion: 'laughing', attitude: 'agree', ja: '手に入れたアイテムは、ここにしまわれるよ。' + /* ✎ */
        'この世界のお金だよ——これも。' },                                                          /* ✎ */
    { emotion: 'tease', attitude: 'question', ja: 'なんでも聞いてね。' +
        '困ったときは、まずは船を手に入れて、船で自由に旅へ出ようとあたしは思ってる！' },          /* ✎ prologue */
    { emotion: 'happy', attitude: 'agree', ja: '迷ったら、クエストを進めてみて。' +               /* ✎ */
        '君だけの自由な発想で、クエストをクリアしていくのを、楽しみにしてるよ。' },                /* ✎ */
    { emotion: 'laughing', attitude: 'agree', ja: 'まずはあたしとお喋りでもしてリフレッシュしよっ' }  /* ✎ */
  ];

  var Onboarding = {
    step: 0,
    answers: {},
    _onDone: null,
    _audio: null,

    isDone: function () {
      return !!(Config.section('state').onboardingDone);
    },

    showTitle: function (onStart) {
      var el = document.getElementById('overlay-title');
      var btn = document.getElementById('btn-title-start');
      document.body.classList.add('boot');       /* hide chrome behind title */
      el.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = I18n.t('title.start');
      btn.onclick = function () {
        if (window.Sound) Sound.unlock();
        el.classList.add('hidden');
        document.body.classList.remove('boot');
        onStart && onStart();
      };
    },

    start: function (onDone) {
      if (window.Sound) {
        Sound.unlock();
        Sound.setRoute('title');
      }
      Onboarding._onDone = onDone;
      Onboarding.step = 0;
      Onboarding.answers = {};
      document.getElementById('overlay-onboard').classList.remove('hidden');
      Onboarding._render();
    },

    skip: function () {
      Config.set('state.onboardingDone', true);
      document.getElementById('overlay-onboard').classList.add('hidden');
      document.getElementById('overlay-prologue').classList.add('hidden');
      Onboarding._onDone && Onboarding._onDone();
    },

    _render: function () {
      var qs = questions();
      var q = qs[Onboarding.step];
      var host = document.getElementById('onb-body');
      var prog = document.getElementById('onb-progress');
      var title = document.getElementById('onb-prompt');
      var sub = document.getElementById('onb-sub');
      document.getElementById('onb-skip').textContent = I18n.t('onb.skip');
      if (!q) { Onboarding._prologue(); return; }
      prog.textContent = (Onboarding.step + 1) + ' / ' + qs.length;
      title.textContent = I18n.t(q.promptKey);
      sub.textContent = I18n.t(q.subKey);
      host.innerHTML = '';

      if (q.type === 'identity') {
        host.appendChild(Onboarding._field(I18n.t('onb.name'), 'onb-name', 'text', Config.section('profile').name || ''));
        host.appendChild(Onboarding._field(I18n.t('onb.birthday'), 'onb-bday', 'date', Config.section('profile').birthday || ''));
        var g = document.createElement('div');
        g.className = 'field';
        g.innerHTML = '<label></label><div class="chips" id="onb-gender"></div>';
        g.querySelector('label').textContent = I18n.t('onb.gender');
        ['female', 'male', 'other'].forEach(function (v) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip' + (Config.section('profile').gender === v ? ' on' : '');
          b.textContent = I18n.t('onb.gender.' + v);
          b.onclick = function () {
            g.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
            b.classList.add('on');
            b.setAttribute('data-v', v);
          };
          b.setAttribute('data-v', v);
          g.querySelector('#onb-gender').appendChild(b);
        });
        host.appendChild(g);
      } else if (q.type === 'text') {
        var ta = document.createElement('textarea');
        ta.id = 'onb-text';
        ta.rows = 4;
        ta.placeholder = q.phKey ? I18n.t(q.phKey) : '';
        host.appendChild(ta);
      } else if (q.type === 'multi' || q.type === 'single') {
        var chips = document.createElement('div');
        chips.className = 'chips';
        chips.id = 'onb-choices';
        q.choices.forEach(function (k) {
          var b = document.createElement('button');
          b.type = 'button';
          b.className = 'chip';
          b.textContent = I18n.t(k);
          b.setAttribute('data-k', k);
          b.onclick = function () {
            if (q.type === 'single') {
              chips.querySelectorAll('.chip').forEach(function (c) { c.classList.remove('on'); });
              b.classList.add('on');
            } else b.classList.toggle('on');
          };
          chips.appendChild(b);
        });
        host.appendChild(chips);
      }

      document.getElementById('onb-next').textContent =
        Onboarding.step + 1 >= qs.length ? I18n.t('onb.finish') : I18n.t('onb.next');
    },

    _field: function (label, id, type, value) {
      var d = document.createElement('div');
      d.className = 'field';
      var lab = document.createElement('label');
      lab.textContent = label;
      var inp = document.createElement('input');
      inp.type = type; inp.id = id; inp.value = value || '';
      d.appendChild(lab); d.appendChild(inp);
      return d;
    },

    next: function () {
      var qs = questions();
      var q = qs[Onboarding.step];
      if (q) Onboarding._save(q);
      Onboarding.step++;
      if (Onboarding.step >= qs.length) Onboarding._prologue();
      else Onboarding._render();
    },

    _save: function (q) {
      if (q.type === 'identity') {
        var name = (document.getElementById('onb-name') || {}).value || '';
        var bday = (document.getElementById('onb-bday') || {}).value || '';
        var gEl = document.querySelector('#onb-gender .chip.on');
        Config.set('profile.name', name.trim());
        Config.set('profile.birthday', bday);
        Config.set('profile.gender', gEl ? gEl.getAttribute('data-v') : '');
        if (name.trim()) Config.set('chara.callMe', name.trim());
        return;
      }
      if (q.type === 'text') {
        var v = (document.getElementById('onb-text') || {}).value || '';
        Config.set(q.field, v.trim());
        return;
      }
      var picked = [];
      document.querySelectorAll('#onb-choices .chip.on').forEach(function (c) {
        picked.push(c.textContent);
      });
      Config.set(q.field, picked.join('、'));
    },

    _prologue: function () {
      document.getElementById('overlay-onboard').classList.add('hidden');
      var ov = document.getElementById('overlay-prologue');
      ov.classList.remove('hidden');
      if (window.Sound) Sound.setRoute('prologue');
      Onboarding._proIdx = 1;
      Onboarding._playPrologue();
    },

    _proIdx: 1,

    _playPrologue: function () {
      var n = Onboarding._proIdx;
      var label = document.getElementById('pro-step');
      var hint = document.getElementById('pro-hint');
      label.textContent = n + ' / 9';
      hint.textContent = I18n.t('onb.prologueHint');
      /* Route through App.audio so the analyser graph (lip-sync RMS) is
         attached; `force` keeps the prologue audible even with the voice
         toggle off — it is core onboarding narration, not reply TTS. */
      var src = Sound.prologue(n);
      if (window.App && App.playFile) { App.playFile(src, null, true); return; }
      if (Onboarding._audio) { try { Onboarding._audio.pause(); } catch (e) {} }
      var a = new Audio(src);
      Onboarding._audio = a;
      a.volume = Number(Config.section('app').volume) || 0.9;
      Avatar.setTalking && Avatar.setTalking(true);
      a.onended = function () { Avatar.setTalking(false); };
      a.play().catch(function () { Avatar.setTalking(false); });
    },

    prologueNext: function () {
      if (Onboarding._audio) { try { Onboarding._audio.pause(); } catch (e) {} }
      if (window.App && App._pauseVoice) App._pauseVoice();
      else Avatar.setTalking && Avatar.setTalking(false);
      if (Onboarding._proIdx < 9) {
        Onboarding._proIdx++;
        Onboarding._playPrologue();
      } else Onboarding._tutorial();
    },

    _tutIdx: 0,

    _tutorial: function () {
      document.getElementById('overlay-prologue').classList.add('hidden');
      if (window.Sound) {
        var st = Config.section('state');
        Sound.setPlace(st.stage, st.tod, World.backgroundFor(st.stage));
        Sound.setRoute('talk');
      }
      var bar = document.getElementById('input-bar');
      if (bar) bar.classList.add('spot');
      Onboarding._tutIdx = 0;
      Onboarding._showTut();
    },

    _showTut: function () {
      var line = TUTORIAL[Onboarding._tutIdx];
      if (!line) {
        Config.set('state.onboardingDone', true);
        Onboarding._onDone && Onboarding._onDone();
        return;
      }
      var text = (window.I18n && I18n.tc)
        ? I18n.tc('tut.' + (Onboarding._tutIdx + 1), line.ja) : line.ja;
      if (window.App && App.showBubble) App.showBubble(text);
      if (window.Avatar && Avatar.setEmotion) Avatar.setEmotion(line.emotion, line.attitude);
      if (window.App && App.speakThen) App.speakThen(text, line.emotion);
      Onboarding._tutIdx++;
    },

    tutorialAdvance: function () {
      if (!Onboarding.isDone() && Onboarding._tutIdx > 0 && Onboarding._tutIdx <= TUTORIAL.length) {
        Onboarding._showTut();
        return true;
      }
      return false;
    }
  };

  global.Onboarding = Onboarding;
})(window);
