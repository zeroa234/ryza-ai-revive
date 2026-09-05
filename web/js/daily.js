/* Daily login (source: features/daily_login/screens/daily_login_screen.dart,
   keys dailyLogin.title/subtitle/cta/progressLabel/nextGoalLabel/
   nextGoalDescription/weekday.mon..sun + 「5日連続ログインで報酬獲得」).

   The official screen existed in the tree and was server-gated; rebuilt
   locally. Rewards flow through Game (stamina / money / exp / items).
   With cheat mode the calendar is fully claimable in any order. */
(function (global) {
  'use strict';

  var KEY = 'ryza.daily.v1';
  var DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

  /* Day 5 = the 「5日連続」 milestone; day 7 = treasure chest. */
  var REWARDS = [
    { day: 1, kind: 'stamina', amount: 'full', text: 'スタミナ全回復' },
    { day: 2, kind: 'money', amount: 120, text: '120G' },
    { day: 3, kind: 'item', id: 'wasser', n: 3, text: '蒸留水×3' },
    { day: 4, kind: 'exp', amount: 60, text: 'EXP+60' },
    { day: 5, kind: 'big', money: 300, exp: 100, text: '300G + EXP+100 + 全回復' },
    { day: 6, kind: 'item', id: 'apple', n: 1, text: 'スタミナリンゴ×1' },
    { day: 7, kind: 'chest', money: 500, item: 'relic', text: '宝箱：500G + 古代の遺物' }
  ];

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function L(key, fb) { return (window.I18n && I18n.tc) ? I18n.tc(key, fb) : fb; }
  function rewardText(i) { return L('dl.rw.' + (i + 1), REWARDS[i].text); }
  function yesterdayStr() {
    var d = new Date();
    d.setDate(d.getDate() - 1);
    return todayStr(d);
  }
  function isoWeekIndex() {           /* 0 = Monday */
    var d = new Date().getDay();
    return d === 0 ? 6 : d - 1;
  }

  var Daily = {
    s: null,

    load: function () {
      var raw = null;
      try { raw = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) {}
      Daily.s = Object.assign({ lastDate: '', streak: 0, claimedDays: [] }, raw || {});
      /* streak breaks if the gap is more than one day */
      if (Daily.s.lastDate && Daily.s.lastDate !== todayStr() &&
          Daily.s.lastDate !== yesterdayStr()) {
        Daily.s.streak = 0;
        Daily.s.claimedDays = [];
      }
      return Daily.s;
    },
    save: function () {
      try { localStorage.setItem(KEY, JSON.stringify(Daily.s)); } catch (e) {}
    },

    available: function () {
      return Daily.s.lastDate !== todayStr();
    },
    streak: function () { return Daily.s.streak | 0; },
    weekDayIdx: function () { return isoWeekIndex(); },

    /* The reward shown for the current streak day (cycling week strip). */
    rewardFor: function (idx) { return REWARDS[Util.clamp(idx, 0, 6)]; },

    claim: function (idxOverride) {
      Daily.load();
      if (!Daily.available()) return { ok: false, reason: 'done' };
      var idx = (idxOverride != null) ? Util.clamp(idxOverride | 0, 0, 6)
                                      : Util.clamp(Daily.streak(), 0, 6);
      var r = Daily.rewardFor(idx);
      var msgs = [];
      switch (r.kind) {
        case 'stamina': Game.refill(); msgs.push(rewardText(0)); break;
        case 'money': Game.addMoney(r.amount); msgs.push(rewardText(1)); break;
        case 'exp': Game.addExp(r.amount); msgs.push(rewardText(3)); break;
        case 'item':
          Game.addItem('you', r.id, r.n || 1);
          var inm = (Game.ITEMS[r.id] || {}).name || r.id;
          if (window.I18n && I18n.tc) inm = I18n.tc('item.' + r.id, inm);
          msgs.push(inm + '×' + (r.n || 1));
          break;
        case 'big':
          Game.addMoney(r.money); Game.addExp(r.exp); Game.refill();
          msgs.push(rewardText(4));
          break;
        case 'chest':
          Game.addMoney(r.money);
          Game.addItem('you', r.item, 1);
          msgs.push(rewardText(6));
          break;
      }
      Daily.s.streak = Daily.available() ? Daily.streak() + 1 : Daily.streak();
      Daily.s.lastDate = todayStr();
      if (Daily.s.claimedDays.indexOf(idx) === -1) Daily.s.claimedDays.push(idx);
      Daily.save();
      Game.remember('連続ログイン ' + Daily.streak() + ' 日目：' + msgs.join('、'));
      if (window.Sound) Sound.se('quest_clear');
      if (window.Fx) Fx.burstConfetti();
      return { ok: true, day: idx + 1, text: msgs.join('、') };
    },

    render: function (root) {
      if (!root) return;
      root.innerHTML = '';
      Daily.load();
      var head = document.createElement('div');
      head.className = 'dl-head';
      head.innerHTML = '<h3></h3><p class="dl-sub"></p><p class="dl-prog"></p>';
      head.querySelector('h3').textContent = I18n.t('dl.title');
      head.querySelector('.dl-sub').textContent = I18n.t('dl.subtitle');
      head.querySelector('.dl-prog').textContent =
        I18n.t('dl.progress').replace('{n}', String(Daily.streak()));
      root.appendChild(head);

      var strip = document.createElement('div');
      strip.className = 'dl-strip';
      var todayIdx = Daily.weekDayIdx();
      REWARDS.forEach(function (r, i) {
        var cell = document.createElement('div');
        var claimedEver = Daily.s.claimedDays.indexOf(i) !== -1;
        var isToday = i === todayIdx && Daily.available();
        var isNext = i === Util.clamp(Daily.streak(), 0, 6);
        cell.className = 'dl-cell' + (claimedEver ? ' claimed' : '') +
                         (isToday ? ' today' : '') + (isNext && !claimedEver ? ' next' : '');
        cell.innerHTML = '<span class="dl-wd"></span><span class="dl-rw"></span>' +
                         '<img alt="" src="assets/icons/' +
                         (claimedEver ? 'check' : (r.kind === 'chest' || r.kind === 'big' ? 'present' : 'stamina_apple_filled')) +
                         '.svg">';
        cell.querySelector('.dl-wd').textContent = I18n.t('dl.week.' + DAYS[i]);
        cell.querySelector('.dl-rw').textContent = rewardText(i);
        strip.appendChild(cell);
      });
      root.appendChild(strip);

      var goal = document.createElement('p');
      goal.className = 'dl-goal';
      var nextIdx = Util.clamp(Daily.streak(), 0, 6);
      goal.textContent = I18n.t('dl.next').replace('{r}', rewardText(nextIdx));
      root.appendChild(goal);

      var btn = document.createElement('button');
      btn.className = 'btn primary';
      btn.textContent = Daily.available() ? I18n.t('dl.cta') : I18n.t('dl.done');
      btn.disabled = !Daily.available();
      btn.onclick = function () {
        var res = Daily.claim();
        if (!res.ok) { if (window.App) App.toast(I18n.t('dl.already')); return; }
        if (window.App) {
          App.toast(I18n.t('dl.got') + res.text);
          if (App.refreshHud) App.refreshHud();
        }
        Daily.render(root);
      };
      root.appendChild(btn);
    },

    REWARDS: REWARDS,
    DAYS: DAYS
  };

  global.Daily = Daily;
})(window);
