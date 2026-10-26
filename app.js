(function () {
  'use strict';
  var VER = '0.1.0';
  var D = window.PBL_DATA;
  var $ = function (id) { return document.getElementById(id); };
  var DAY = 864e5;

  /* ---------- small helpers ---------- */
  function h(tag, attrs) {
    var e = document.createElement(tag), k, v, kids = Array.prototype.slice.call(arguments, 2);
    for (k in (attrs || {})) {
      v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k.indexOf('on') === 0) e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? '' : v);
    }
    [].concat.apply([], kids).forEach(function (c) {
      if (c == null || c === false) return;
      e.append(c.nodeType ? c : document.createTextNode(String(c)));
    });
    return e;
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function t(r) { return new Date(r.ts).getTime(); }
  function fmtDay(ms) { var d = new Date(ms); return (d.getMonth() + 1) + '/' + d.getDate(); }
  function fmtClock(ms) { var d = new Date(ms); return pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function fmtFull(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function toLocalInput(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()); }
  function toDateInput(ms) { var d = new Date(ms); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function startOfDay(ms) { var d = new Date(ms); d.setHours(0, 0, 0, 0); return d.getTime(); }
  function median(a) { if (!a.length) return null; var s = a.slice().sort(function (x, y) { return x - y; }), m = s.length >> 1; return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2); }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); });
  }
  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return '刚刚'; if (m < 60) return m + ' 分钟前';
    var hh = Math.round(m / 60); if (hh < 48) return hh + ' 小时前';
    return Math.round(hh / 24) + ' 天前';
  }
  var toastTimer;
  function toast(msg) { var el = $('toast'); el.textContent = msg; el.hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(function () { el.hidden = true; }, 2600); }
  function lsGet(k, def) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : def; } catch (e) { return def; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { } }
  function errText(e) {
    var m = (e && (e.message || e.error_description)) || String(e || '');
    if (/Invalid login credentials/i.test(m)) return '邮箱或密码不对。';
    if (/already registered|already been registered/i.test(m)) return '这个邮箱已经注册过，请直接登录。';
    if (/Email not confirmed/i.test(m)) return '邮箱还没确认。请让管理员在 Supabase 里关闭「Confirm email」。';
    if (/Password should be|at least/i.test(m)) return '密码至少 8 位。';
    if (/rate limit|too many/i.test(m)) return '操作太频繁，请过一会儿再试。';
    if (/invalid code/i.test(m)) return '邀请码不对。';
    if (/already in a household/i.test(m)) return '你已经在一个家庭里了。';
    if (/household full/i.test(m)) return '这个家庭人数已满。';
    if (/Failed to fetch|NetworkError|network/i.test(m)) return '连不上服务器。请检查网络。';
    return m || '出错了，请再试一次。';
  }
  function isNetErr(e) { var m = (e && e.message) || ''; return !navigator.onLine || /Failed to fetch|NetworkError|network|Load failed/i.test(m); }

  /* ---------- state ---------- */
  var ctx = null, pet = null, records = [], events = [], unsub = null;
  var PENDING = 'pbl-pending-v1';
  var pending = lsGet(PENDING, []);
  var me = null;

  function show(view) {
    ['viewLoading', 'viewAuth', 'viewOnboard', 'viewMain'].forEach(function (v) { $(v).hidden = v !== view; });
  }
  function member(uid) { return ctx && ctx.members.find(function (m) { return m.user_id === uid; }); }
  function memberIdx(uid) { var i = ctx ? ctx.members.findIndex(function (m) { return m.user_id === uid; }) : -1; return i < 0 ? 0 : i; }
  function memberName(uid) { if (uid === me) return '我'; var m = member(uid); return (m && m.display_name) || '家人'; }

  function zone(rpm) { if (rpm > pet.warn_red) return 'red'; if (rpm >= pet.warn_yellow) return 'yellow'; return 'green'; }
  function zoneText(z) { return z === 'red' ? '高于 ' + pet.warn_red : (z === 'yellow' ? pet.warn_yellow + '–' + pet.warn_red : '低于 ' + pet.warn_yellow); }
  function chip(rpm, asleep) {
    if (asleep === false) return h('span', { class: 'chip grey' }, '醒着');
    var z = zone(rpm); return h('span', { class: 'chip ' + z }, (z === 'green' ? '● ' : '▲ ') + zoneText(z));
  }

  function all() {
    var seen = {}, out = [];
    records.concat(pending.filter(function (p) { return p.pet_id === (pet && pet.id); }).map(function (p) { return Object.assign({ _pending: true, created_by: me }, p); }))
      .forEach(function (r) { if (!seen[r.id]) { seen[r.id] = 1; out.push(r); } });
    return out.sort(function (a, b) { return t(b) - t(a); });
  }

  /* ---------- auth ---------- */
  var authBusy = false;
  async function doAuth(kind) {
    if (authBusy) return;
    var email = $('email').value.trim(), pw = $('pw').value;
    $('authErr').textContent = '';
    if (!/^\S+@\S+\.\S+$/.test(email)) { $('authErr').textContent = '请输入邮箱。'; return; }
    if (pw.length < 8) { $('authErr').textContent = '密码至少 8 位。'; return; }
    authBusy = true;
    try {
      if (kind === 'up') {
        var r = await D.signUp(email, pw);
        if (r.needsConfirm) { $('authErr').textContent = '注册成功，但需要确认邮箱才能登录。请让管理员在 Supabase 里关闭「Confirm email」后再登录。'; return; }
      } else {
        await D.signIn(email, pw);
      }
      me = D.userId();
      await loadContext();
    } catch (e) { $('authErr').textContent = errText(e); }
    finally { authBusy = false; }
  }
  $('authForm').addEventListener('submit', function (e) { e.preventDefault(); doAuth('in'); });
  $('btnSignUp').addEventListener('click', function () { doAuth('up'); });

  /* ---------- onboarding ---------- */
  $('createForm').addEventListener('submit', async function (e) {
    e.preventDefault(); $('obErr').textContent = '';
    try { await D.createHousehold('我家', $('cPet').value.trim(), $('cName').value.trim()); await loadContext(); }
    catch (er) { $('obErr').textContent = errText(er); }
  });
  $('joinForm').addEventListener('submit', async function (e) {
    e.preventDefault(); $('obErr').textContent = '';
    try { await D.joinHousehold($('jCode').value.trim(), $('jName').value.trim()); await loadContext(); }
    catch (er) { $('obErr').textContent = errText(er); }
  });
  async function signOut() {
    if (unsub) { unsub(); unsub = null; }
    await D.signOut(); ctx = null; pet = null; records = []; events = [];
    try { $('settings').close(); } catch (e) { }
    show('viewAuth');
  }
  $('obSignOut').addEventListener('click', signOut);

  /* ---------- load ---------- */
  async function loadContext() {
    show('viewLoading');
    try { ctx = await D.getContext(); }
    catch (e) { $('viewLoading').textContent = errText(e) + ' 请稍后重新打开。'; return; }
    if (!ctx) { show('viewOnboard'); return; }
    pet = ctx.pets[0];
    show('viewMain');
    renderAll();
    await refresh();
    if (unsub) unsub();
    unsub = D.subscribe(ctx.household.id, { record: onRecord, event: onEvent, pet: onPet, status: onStatus });
    flushPending();
  }
  async function refresh() {
    try {
      var res = await Promise.all([D.listRecords(pet.id), D.listEvents(pet.id)]);
      records = res[0] || []; events = res[1] || [];
      renderAll();
    } catch (e) { if (!isNetErr(e)) toast(errText(e)); renderNet(); }
  }
  function onRecord(type, row, old) {
    if (type === 'DELETE') { records = records.filter(function (r) { return r.id !== (old && old.id); }); }
    else if (row && row.pet_id === pet.id) {
      var i = records.findIndex(function (r) { return r.id === row.id; });
      if (i >= 0) records[i] = row; else {
        records.push(row);
        if (row.created_by && row.created_by !== me) toast(memberName(row.created_by) + ' 刚记录了 ' + row.rpm + ' 次/分');
      }
      pending = pending.filter(function (p) { return p.id !== row.id; }); lsSet(PENDING, pending);
    }
    renderAll();
  }
  function onEvent(type, row, old) {
    if (type === 'DELETE') events = events.filter(function (e) { return e.id !== (old && old.id); });
    else if (row) { var i = events.findIndex(function (e) { return e.id === row.id; }); if (i >= 0) events[i] = row; else events.push(row); }
    renderAll();
  }
  function onPet(row) { if (row && row.id === pet.id) { pet = row; ctx.pets[0] = row; renderAll(); } }
  var live = false;
  function onStatus(s) { live = s === 'SUBSCRIBED'; renderNet(); }

  async function flushPending() {
    if (!pending.length || !navigator.onLine) { renderNet(); return; }
    var batch = pending.slice();
    try {
      await D.addRecords(batch.map(function (p) { var c = Object.assign({}, p); delete c._pending; return c; }));
      batch.forEach(function (b) { if (!records.find(function (r) { return r.id === b.id; })) records.push(Object.assign({ created_by: me, household_id: ctx.household.id }, b)); });
      pending = pending.filter(function (p) { return !batch.find(function (b) { return b.id === p.id; }); });
      lsSet(PENDING, pending);
      toast('已同步 ' + batch.length + ' 条');
    } catch (e) { /* keep for later */ }
    renderAll();
  }
  window.addEventListener('online', function () { flushPending(); if (ctx) refresh(); });
  window.addEventListener('offline', renderNet);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && ctx) { refresh(); flushPending(); }
  });

  function renderNet() {
    var bar = $('netBar'), parts = [];
    if (!navigator.onLine) parts.push('现在没有网络。记录会先存在本机，联网后自动同步。');
    if (pending.length) parts.push(pending.length + ' 条记录待同步。');
    bar.hidden = !parts.length; bar.textContent = parts.join(' ');
  }

  /* ---------- counter ---------- */
  var S = { mode: '30', phase: 'idle', count: 0, dur: 30, t0: 0, timer: 0, wake: null, whenTouched: false, asleep: true };
  var audio = null;
  function unlockAudio() {
    try { if (!audio) { var AC = window.AudioContext || window.webkitAudioContext; if (AC) audio = new AC(); } if (audio && audio.state === 'suspended') audio.resume(); } catch (e) { }
  }
  function beep() {
    if (!audio) return;
    try {
      [0, 0.22].forEach(function (off) {
        var o = audio.createOscillator(), g = audio.createGain();
        o.frequency.value = 880; o.connect(g); g.connect(audio.destination);
        var st = audio.currentTime + off; g.gain.setValueAtTime(0.0001, st); g.gain.exponentialRampToValueAtTime(0.25, st + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, st + 0.18);
        o.start(st); o.stop(st + 0.2);
      });
    } catch (e) { }
  }
  function flash() { var f = $('flash'); f.hidden = false; setTimeout(function () { f.hidden = true; }, 350); }
  function releaseWake() { try { if (S.wake && S.wake.release) S.wake.release(); } catch (e) { } S.wake = null; }
  function lockWake() { try { if (navigator.wakeLock) navigator.wakeLock.request('screen').then(function (w) { S.wake = w; }, function () { }); } catch (e) { } }
  function currentRpm() {
    if (S.mode === 'manual') { var v = parseInt($('manualRpm').value, 10); return (v >= 5 && v <= 150) ? v : null; }
    if (S.phase !== 'done') return null;
    return Math.round(S.count * 60 / S.dur);
  }
  function tick() {
    var el = performance.now() - S.t0, total = S.dur * 1000, left = Math.max(0, total - el);
    $('barFill').style.width = Math.min(100, el / total * 100) + '%';
    $('timeLeft').textContent = '剩余 ' + Math.ceil(left / 1000) + ' 秒';
    if (left <= 0) finish();
  }
  function finish() { clearInterval(S.timer); S.phase = 'done'; releaseWake(); beep(); flash(); renderCounter(); }
  function resetCounter() { clearInterval(S.timer); releaseWake(); S.phase = 'idle'; S.count = 0; $('barFill').style.width = '0%'; renderCounter(); }
  $('tap').addEventListener('click', function () {
    unlockAudio();
    if (S.mode === 'manual' || S.phase === 'done') return;
    if (S.phase === 'idle') { S.phase = 'run'; S.count = 1; S.t0 = performance.now(); S.dur = parseInt(S.mode, 10); S.timer = setInterval(tick, 100); lockWake(); }
    else S.count++;
    renderCounter();
  });
  $('undo').addEventListener('click', function () { if (S.phase === 'run' && S.count > 0) { S.count--; renderCounter(); } });
  $('reset').addEventListener('click', resetCounter);
  $('modes').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-mode]'); if (!b) return;
    S.mode = b.getAttribute('data-mode'); resetCounter();
    Array.prototype.forEach.call($('modes').children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    renderCounter();
  });
  $('asleepSeg').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-asleep]'); if (!b) return;
    S.asleep = b.getAttribute('data-asleep') === '1';
    Array.prototype.forEach.call($('asleepSeg').children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    renderCounter();
  });
  $('manualRpm').addEventListener('input', renderCounter);
  $('when').addEventListener('input', function () { S.whenTouched = true; });
  ['睡在猫塔上', '刚吃完药', '房间偏热', '刚醒过'].forEach(function (x) {
    $('noteChips').append(h('button', { type: 'button', onclick: function () { var n = $('note'); n.value = n.value ? (n.value.indexOf(x) >= 0 ? n.value : n.value + '，' + x) : x; } }, x));
  });
  function renderCounter() {
    var manual = S.mode === 'manual';
    $('counter').hidden = manual; $('manual').hidden = !manual;
    $('tapN').textContent = S.count;
    $('tap').disabled = S.phase === 'done';
    $('tapL').textContent = S.phase === 'idle' ? '点这里，开始计时' : (S.phase === 'run' ? '每次一起一伏，点一下' : '时间到。看下面的结果。');
    $('undo').disabled = !(S.phase === 'run' && S.count > 0);
    $('reset').disabled = S.phase === 'idle';
    if (S.phase === 'idle' && !manual) $('timeLeft').textContent = S.mode + ' 秒';
    var rpm = currentRpm();
    $('saveBox').hidden = rpm === null;
    if (rpm !== null && pet) {
      $('resV').textContent = rpm;
      $('resChip').replaceChildren(chip(rpm, S.asleep));
      $('resHow').textContent = manual ? '手动输入的值。' : ('数到 ' + S.count + ' 次，用时 ' + S.dur + ' 秒' + (S.dur === 30 ? '，乘以 2 得到每分钟次数。' : '。'));
      if (!S.whenTouched) $('when').value = toLocalInput(Date.now());
    }
  }
  $('save').addEventListener('click', async function () {
    var rpm = currentRpm(); if (rpm === null) return;
    var ts = Date.now();
    if (S.whenTouched && $('when').value) { var x = new Date($('when').value).getTime(); if (!isNaN(x)) ts = x; }
    var rec = { id: uuid(), pet_id: pet.id, ts: new Date(ts).toISOString(), rpm: rpm,
      method: S.mode === 'manual' ? 'manual' : S.mode + 's', count: S.mode === 'manual' ? null : S.count, dur: S.mode === 'manual' ? null : S.dur,
      asleep: S.asleep, note: $('note').value.trim().slice(0, 200) };
    var btn = $('save'); btn.disabled = true;
    try {
      await D.addRecords([rec]);
      if (!records.find(function (r) { return r.id === rec.id; })) records.push(Object.assign({ created_by: me, household_id: ctx.household.id }, rec));
      toast('已保存：' + rpm + ' 次/分');
    } catch (e) {
      if (isNetErr(e)) { pending.push(rec); lsSet(PENDING, pending); toast('没有网络，已存在本机，联网后自动同步'); }
      else { toast(errText(e)); btn.disabled = false; return; }
    }
    btn.disabled = false;
    $('note').value = ''; S.whenTouched = false; $('manualRpm').value = '';
    resetCounter(); renderAll();
  });

  /* ---------- alert ---------- */
  function jpLine() { return '就寝中の呼吸数が、' + pet.warn_red + '回/分を超える状態が続いています。'; }
  function renderAlert() {
    var box = $('alert'); box.replaceChildren();
    var r = all().filter(function (x) { return x.asleep !== false; });
    if (!r.length) return;
    var z0 = zone(r[0].rpm);
    if (z0 === 'red' && r[1] && zone(r[1].rpm) === 'red') {
      $('sos').open = true;
      var tel = pet.vet_phone ? h('a', { class: 'btn primary', href: 'tel:' + pet.vet_phone.replace(/[^\d+]/g, '') }, '打电话给 ' + (pet.vet_name || '医院')) : null;
      box.append(h('div', { class: 'alert red' },
        h('div', { class: 't' }, '▲ 连续 2 次高于 ' + pet.warn_red + ' 次/分（' + r[1].rpm + '、' + r[0].rpm + '）'),
        h('div', null, '联系' + (pet.vet_name || '医院') + '。电话里可以说这句：'),
        h('div', { class: 'jp', lang: 'ja' }, jpLine()),
        h('div', { class: 'gap8' }, tel, h('button', { type: 'button', class: 'btn', onclick: function () { copyText(jpLine()); } }, '复制日语')),
        h('div', { class: 'small' }, '如果猫张嘴呼吸，不用再数，马上联系。')));
    } else if (z0 === 'red') {
      box.append(h('div', { class: 'alert red' },
        h('div', { class: 't' }, '▲ 最近一次 ' + r[0].rpm + ' 次/分，高于红线 ' + pet.warn_red),
        h('div', null, '猫还在熟睡时，再数一次。同时看下面的急症信号。')));
    } else if (z0 === 'yellow') {
      box.append(h('div', { class: 'alert yellow' },
        h('div', { class: 't' }, '▲ 最近一次 ' + r[0].rpm + ' 次/分，在黄线范围（' + pet.warn_yellow + '–' + pet.warn_red + '）'),
        h('div', null, '接近红线。下次熟睡时再数一次，看是否继续上升。')));
    }
  }
  function copyText(s, box) {
    var ok = function () { toast('已复制'); };
    var fail = function () { if (box) { box.hidden = false; box.value = s; box.focus(); box.select(); toast('请手动复制'); } else toast('复制失败，长按文字手动复制'); };
    try { navigator.clipboard.writeText(s).then(ok, fail); } catch (e) { fail(); }
  }

  /* ---------- today ---------- */
  function renderToday() {
    var box = $('today'), r = all(), now = Date.now(), sod = startOfDay(now);
    var today = r.filter(function (x) { return t(x) >= sod; });
    var asleepToday = today.filter(function (x) { return x.asleep !== false; }).map(function (x) { return x.rpm; });
    var wk = r.filter(function (x) { return now - t(x) <= 7 * DAY && x.asleep !== false; }).map(function (x) { return x.rpm; });
    var last = r[0];
    var kids = [
      h('div', { class: 'row' }, h('h2', null, '今天'), last ? h('span', { class: 'small' }, '上次：' + ago(t(last)) + '，' + memberName(last.created_by) + ' 记录') : h('span', { class: 'small' }, '还没有记录')),
      h('div', { class: 'today-grid' },
        h('div', null, h('b', null, today.length), h('span', null, '今天记录')),
        h('div', null, h('b', null, asleepToday.length ? Math.max.apply(null, asleepToday) : '–'), h('span', null, '今天最高')),
        h('div', null, h('b', null, wk.length ? median(wk) : '–'), h('span', null, '近 7 天中位数')))
    ];
    if (!today.length) kids.push(h('p', { class: 'small' }, '今天还没有人记录。'));
    box.replaceChildren.apply(box, kids);
  }

  /* ---------- chart ---------- */
  var range = '14', SHAPES = ['circle', 'square', 'triangle', 'diamond'];
  function shapePath(shape, x, y, r) {
    if (shape === 'square') return '<rect x="' + (x - r) + '" y="' + (y - r) + '" width="' + 2 * r + '" height="' + 2 * r + '"';
    if (shape === 'triangle') return '<path d="M' + x + ' ' + (y - r - 1) + 'L' + (x + r + 1) + ' ' + (y + r) + 'L' + (x - r - 1) + ' ' + (y + r) + 'Z"';
    if (shape === 'diamond') return '<path d="M' + x + ' ' + (y - r - 1) + 'L' + (x + r + 1) + ' ' + y + 'L' + x + ' ' + (y + r + 1) + 'L' + (x - r - 1) + ' ' + y + 'Z"';
    return '<circle cx="' + x + '" cy="' + y + '" r="' + r + '"';
  }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  var KIND = { med_start: '开始用药', med_change: '换药', med_stop: '停药', vet: '就诊', other: '其他' };
  function renderChart() {
    var box = $('chartBox'); box.replaceChildren();
    var now = Date.now(), r = all().slice().reverse();
    var start = range === 'all' ? Math.min(r.length ? t(r[0]) : now - 14 * DAY, events.length ? Math.min.apply(null, events.map(t)) : now) - DAY / 2 : now - Number(range) * DAY;
    var data = r.filter(function (x) { return t(x) >= start; });
    var evs = events.filter(function (e) { return t(e) >= start && t(e) <= now; });
    var W = Math.max(280, box.clientWidth || 320), H = 240, L = 32, R = 12, T = 22, B = 26, pw = W - L - R, ph = H - T - B;
    if (!data.length) box.append(h('p', { class: 'empty' }, r.length ? '这个时间范围没有记录。' : '还没有记录。保存第一条后，这里会画出趋势。'));
    if (!data.length && !evs.length) { renderLegend(); renderStats(r); return; }
    var mx = 0; data.forEach(function (d) { if (d.rpm > mx) mx = d.rpm; });
    var yMax = Math.max(45, Math.ceil((mx + 4) / 10) * 10);
    var y = function (v) { return T + ph - v / yMax * ph; };
    var x = function (ms) { return L + 6 + (ms - start) / (now - start) * (pw - 12); };
    var s = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="' + W + '" height="' + H + '" role="img" aria-label="呼吸次数趋势图">';
    s += '<rect class="g-rbd" x="' + L + '" y="' + T + '" width="' + pw + '" height="' + Math.max(0, y(pet.warn_red) - T) + '"/>';
    s += '<rect class="g-ybd" x="' + L + '" y="' + y(pet.warn_red) + '" width="' + pw + '" height="' + Math.max(0, y(pet.warn_yellow) - y(pet.warn_red)) + '"/>';
    for (var v = 0; v <= yMax; v += 10) {
      s += '<line class="g-grid" x1="' + L + '" x2="' + (L + pw) + '" y1="' + y(v) + '" y2="' + y(v) + '"/>';
      s += '<text class="g-tick" x="' + (L - 5) + '" y="' + (y(v) + 4) + '" text-anchor="end">' + v + '</text>';
    }
    s += '<line class="g-thr-y" x1="' + L + '" x2="' + (L + pw) + '" y1="' + y(pet.warn_yellow) + '" y2="' + y(pet.warn_yellow) + '"/>';
    s += '<line class="g-thr-r" x1="' + L + '" x2="' + (L + pw) + '" y1="' + y(pet.warn_red) + '" y2="' + y(pet.warn_red) + '"/>';
    s += '<text class="g-note" x="' + (L + 4) + '" y="' + (y(pet.warn_red) - 4) + '">红线 ' + pet.warn_red + '</text>';
    // x ticks
    var span = now - start, n = 4;
    for (var i = 0; i <= n; i++) {
      var ms = start + span * i / n, anchor = i === 0 ? 'start' : (i === n ? 'end' : 'middle');
      s += '<text class="g-tick" x="' + x(ms) + '" y="' + (H - 7) + '" text-anchor="' + anchor + '">' + fmtDay(ms) + '</text>';
    }
    // events
    evs.forEach(function (e, k) {
      var ex = x(t(e));
      s += '<line class="g-ev" x1="' + ex + '" x2="' + ex + '" y1="' + (T - 2) + '" y2="' + (T + ph) + '"/>';
      var lab = (e.label || KIND[e.kind] || '').slice(0, 10);
      s += '<text class="g-evt" x="' + (ex + 3) + '" y="' + (T - 8 + (k % 2) * 0) + '">' + esc(lab) + '</text>';
    });
    // line through asleep records
    var asleep = data.filter(function (d) { return d.asleep !== false; });
    if (asleep.length > 1) s += '<polyline class="g-line" points="' + asleep.map(function (d) { return x(t(d)) + ',' + y(d.rpm); }).join(' ') + '"/>';
    s += '<line class="g-cross" id="cross" y1="' + T + '" y2="' + (T + ph) + '" x1="0" x2="0" style="display:none"/>';
    data.forEach(function (d) {
      var z = zone(d.rpm), shp = SHAPES[memberIdx(d.created_by) % SHAPES.length];
      s += shapePath(shp, x(t(d)), y(d.rpm), 5) + ' class="g-pt ' + (d.asleep === false ? 'hollow s-' + z : 'p-' + z) + '"/>';
    });
    s += '</svg>';
    var holder = document.createElement('div'); holder.innerHTML = s;
    var svg = holder.firstChild; box.append(svg);
    var tip = h('div', { class: 'tip', hidden: true }); box.append(tip);
    var cross = svg.querySelector('#cross');
    function showTip(ev) {
      if (!data.length) return;
      var rc = svg.getBoundingClientRect(), mxp = (ev.clientX - rc.left) * (W / rc.width), best = 0, bd = 1e9;
      data.forEach(function (d, j) { var dd = Math.abs(x(t(d)) - mxp); if (dd < bd) { bd = dd; best = j; } });
      var d = data[best], px = x(t(d)), py = y(d.rpm);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.style.display = '';
      tip.replaceChildren(h('b', null, d.rpm), ' 次/分', d.asleep === false ? '（醒着）' : '', h('br'), fmtFull(t(d)), h('br'), memberName(d.created_by) + ' 记录', d.note ? h('br') : null, d.note || null);
      tip.hidden = false;
      var sc = rc.width / W;
      tip.style.left = Math.min(Math.max(px * sc, 80), rc.width - 80) + 'px'; tip.style.top = Math.max(py * sc - 10, 50) + 'px';
    }
    svg.addEventListener('pointermove', showTip);
    svg.addEventListener('pointerdown', showTip);
    svg.addEventListener('pointerleave', function (e) { if (e.pointerType === 'mouse') { tip.hidden = true; cross.style.display = 'none'; } });
    renderLegend(); renderStats(r);
  }
  function renderStats(rAsc) {
    var now = Date.now(), wk = rAsc.filter(function (x) { return now - t(x) <= 7 * DAY && x.asleep !== false; }).map(function (x) { return x.rpm; });
    $('stats').textContent = wk.length ? '近 7 天熟睡 ' + wk.length + ' 条：中位数 ' + median(wk) + '，最高 ' + Math.max.apply(null, wk) + ' 次/分' : '近 7 天没有熟睡记录';
  }
  function svgIcon(inner) { var sp = document.createElement('span'); sp.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">' + inner + '</svg>'; return sp.firstChild; }
  function renderLegend() {
    var lg = $('legend'); lg.replaceChildren();
    if (!ctx) return;
    ctx.members.forEach(function (m, i) {
      var shp = SHAPES[i % SHAPES.length];
      lg.append(h('span', null, svgIcon(shapePath(shp, 7, 7, 4.5) + ' fill="currentColor"/>'), memberName(m.user_id)));
    });
    lg.append(h('span', null, svgIcon('<circle cx="7" cy="7" r="4.5" class="p-green"/>'), '低于 ' + pet.warn_yellow));
    lg.append(h('span', null, svgIcon('<circle cx="7" cy="7" r="4.5" class="p-yellow"/>'), pet.warn_yellow + '–' + pet.warn_red));
    lg.append(h('span', null, svgIcon('<circle cx="7" cy="7" r="4.5" class="p-red"/>'), '高于 ' + pet.warn_red));
    lg.append(h('span', null, svgIcon('<circle cx="7" cy="7" r="4" fill="none" stroke="currentColor" stroke-width="1.5"/>'), '醒着（不判断警戒）'));
    lg.append(h('span', null, svgIcon('<line x1="7" y1="1" x2="7" y2="13" class="g-ev"/>'), '事件'));
  }
  $('ranges').addEventListener('click', function (e) {
    var b = e.target.closest('button[data-r]'); if (!b) return;
    range = b.getAttribute('data-r');
    Array.prototype.forEach.call($('ranges').children, function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false'); });
    renderChart();
  });

  /* ---------- list ---------- */
  var showAllRows = false, pendingDel = null, delTimer;
  function methodText(r) {
    if (r.method === 'manual') return '手动输入';
    if (r.method === 'siri') return 'Siri';
    if (r.method === 'import') return '导入';
    return (r.method === '30s' ? '30 秒 ×2，数到 ' : '60 秒，数到 ') + r.count;
  }
  function renderList() {
    var ul = $('list'), r = all(); ul.replaceChildren();
    if (!r.length) { ul.append(h('li', { class: 'empty' }, '还没有记录。在上面数一次，点「保存记录」。')); $('more').hidden = true; return; }
    (showAllRows ? r : r.slice(0, 20)).forEach(function (x) {
      var mine = x.created_by === me;
      var del = mine ? h('button', { type: 'button', class: 'del' + (pendingDel === x.id ? ' confirm' : ''), onclick: function () {
        if (pendingDel !== x.id) { pendingDel = x.id; clearTimeout(delTimer); delTimer = setTimeout(function () { pendingDel = null; renderList(); }, 3000); renderList(); return; }
        pendingDel = null;
        if (x._pending) { pending = pending.filter(function (p) { return p.id !== x.id; }); lsSet(PENDING, pending); renderAll(); return; }
        D.deleteRecord(x.id).then(function () { records = records.filter(function (y) { return y.id !== x.id; }); renderAll(); toast('已删除'); }, function (e) { toast(errText(e)); });
      } }, pendingDel === x.id ? '确认删除' : '删除') : h('span');
      ul.append(h('li', null,
        h('span', { class: 'when' }, fmtDay(t(x)), h('br'), fmtClock(t(x))),
        h('span', { class: 'val' }, h('b', null, x.rpm), chip(x.rpm, x.asleep)),
        h('span', { class: 'meta' }, memberName(x.created_by) + (x._pending ? ' · 待同步' : ''), x.note ? h('br') : null, x.note || null, h('br'), h('span', { class: 'm' }, methodText(x))),
        del));
    });
    $('more').hidden = showAllRows || r.length <= 20;
  }
  $('more').addEventListener('click', function () { showAllRows = true; renderList(); });

  /* ---------- events ---------- */
  var pendingEvDel = null;
  function renderEvents() {
    var ul = $('evList'); ul.replaceChildren();
    var ev = events.slice().sort(function (a, b) { return t(b) - t(a); });
    if (!ev.length) ul.append(h('li', { class: 'empty' }, '还没有事件。'));
    ev.forEach(function (e) {
      ul.append(h('li', null,
        h('span', { class: 'when' }, toDateInput(t(e)).slice(5).replace('-', '/')),
        h('span', { class: 'meta' }, KIND[e.kind] || '其他', '：', e.label),
        h('button', { type: 'button', class: 'del' + (pendingEvDel === e.id ? ' confirm' : ''), onclick: function () {
          if (pendingEvDel !== e.id) { pendingEvDel = e.id; setTimeout(function () { pendingEvDel = null; renderEvents(); }, 3000); renderEvents(); return; }
          pendingEvDel = null;
          D.deleteEvent(e.id).then(function () { events = events.filter(function (y) { return y.id !== e.id; }); renderAll(); }, function (er) { toast(errText(er)); });
        } }, pendingEvDel === e.id ? '确认删除' : '删除')));
    });
  }
  $('evDate').value = toDateInput(Date.now());
  $('evForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var d = $('evDate').value, label = $('evLabel').value.trim(); if (!d || !label) return;
    var row = { pet_id: pet.id, ts: new Date(d + 'T12:00').toISOString(), kind: $('evKind').value, label: label.slice(0, 60) };
    try { await D.addEvent(row); $('evLabel').value = ''; toast('已添加事件'); await refresh(); }
    catch (er) { toast(errText(er)); }
  });

  /* ---------- share ---------- */
  function summaryText() {
    var now = Date.now(), r = all().filter(function (x) { return now - t(x) <= 7 * DAY; }).reverse();
    var lines = [pet.name + ' 熟睡呼吸次数（近 7 天，次/分）'];
    r.forEach(function (x) { lines.push(fmtDay(t(x)) + ' ' + fmtClock(t(x)) + '  ' + x.rpm + (x.asleep === false ? '（醒着）' : '') + (x.note ? '  ' + x.note : '')); });
    var a = r.filter(function (x) { return x.asleep !== false; }).map(function (x) { return x.rpm; });
    if (a.length) lines.push('熟睡 ' + a.length + ' 条：中位数 ' + median(a) + '，最高 ' + Math.max.apply(null, a));
    lines.push('参考线：黄 ' + pet.warn_yellow + '，红 ' + pet.warn_red);
    return lines.join('\n');
  }
  $('btnShare').addEventListener('click', function () {
    var txt = summaryText();
    if (navigator.share) navigator.share({ title: pet.name + ' 呼吸记录', text: txt }).catch(function () { });
    else copyText(txt);
  });

  /* ---------- settings ---------- */
  $('btnSettings').addEventListener('click', function () {
    var m = member(me);
    $('sName').value = (m && m.display_name) || '';
    $('sEmail').textContent = '登录邮箱：' + D.userEmail();
    $('sPet').value = pet.name; $('sYellow').value = pet.warn_yellow; $('sRed').value = pet.warn_red;
    $('sVet').value = pet.vet_name || ''; $('sVetTel').value = pet.vet_phone || '';
    $('sCode').textContent = ctx.household.invite_code;
    $('sMembers').replaceChildren.apply($('sMembers'), ctx.members.map(function (x) { return h('li', null, (x.display_name || '（未命名）') + (x.user_id === me ? '（我）' : '')); }));
    $('sMsg').textContent = ''; $('sVer').textContent = VER + ' · ' + D.kind;
    $('settings').showModal();
    renderTokens();
  });
  $('sSave').addEventListener('click', async function () {
    var y = parseInt($('sYellow').value, 10), r = parseInt($('sRed').value, 10);
    if (!(y >= 5 && r <= 150 && y <= r)) { $('sMsg').textContent = '黄线要小于或等于红线，范围 5–150。'; return; }
    try {
      var name = $('sName').value.trim();
      var m = member(me); if (m && name !== m.display_name) { await D.updateMyName(ctx.household.id, name); m.display_name = name; }
      pet = await D.updatePet(pet.id, { name: $('sPet').value.trim() || pet.name, warn_yellow: y, warn_red: r, vet_name: $('sVet').value.trim(), vet_phone: $('sVetTel').value.trim() });
      ctx.pets[0] = pet; $('sMsg').textContent = '已保存。'; renderAll();
    } catch (e) { $('sMsg').textContent = errText(e); }
  });
  $('sCopyCode').addEventListener('click', function () { copyText(ctx.household.invite_code); });

  /* Siri tokens */
  async function renderTokens() {
    var ul = $('tokList'); ul.replaceChildren();
    try {
      var list = await D.listTokens();
      if (!list.length) ul.append(h('li', { class: 'small' }, '还没有令牌。'));
      list.forEach(function (k) {
        ul.append(h('li', { class: 'row' },
          h('span', null, k.label + '：' + fmtDay(new Date(k.created_at).getTime()) + ' 生成，' + (k.last_used_at ? '上次使用 ' + ago(new Date(k.last_used_at).getTime()) : '还没用过')),
          h('button', { type: 'button', class: 'btn small-btn', onclick: function () {
            if (!confirm('删除这个令牌？用它的快捷指令会失效。')) return;
            D.deleteToken(k.id).then(renderTokens, function (e) { toast(errText(e)); });
          } }, '删除')));
      });
    } catch (e) { ul.append(h('li', { class: 'small' }, errText(e))); }
  }
  $('tokNew').addEventListener('click', async function () {
    try {
      var tk = await D.createToken('Siri');
      $('tokVal').value = tk; $('tokUrl').value = D.endpoint(); $('tokBox').hidden = false;
      renderTokens();
    } catch (e) { toast(/too many/.test(e.message || '') ? '最多 5 个令牌，先删掉不用的。' : errText(e)); }
  });
  $('tokCopy').addEventListener('click', function () { copyText($('tokVal').value); });
  $('tokCopyUrl').addEventListener('click', function () { copyText($('tokUrl').value); });
  $('settings').addEventListener('close', function () { $('tokBox').hidden = true; $('tokVal').value = ''; });
  $('sSignOut').addEventListener('click', signOut);
  function csvText() {
    var q = function (v) { v = v == null ? '' : String(v); return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var lines = ['datetime,rpm,method,count,duration_sec,note,asleep,recorded_by'];
    all().slice().reverse().forEach(function (r) { lines.push([fmtFull(t(r)), r.rpm, r.method, r.count, r.dur, r.note, r.asleep === false ? 0 : 1, memberName(r.created_by)].map(q).join(',')); });
    return lines.join('\n') + '\n';
  }
  $('sExport').addEventListener('click', function () {
    var txt = csvText(), d = new Date(), name = 'breath-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '.csv';
    try {
      var file = new File(['﻿' + txt], name, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { navigator.share({ files: [file], title: name }).catch(function () { }); return; }
      var a = h('a', { href: URL.createObjectURL(file), download: name }); document.body.append(a); a.click(); a.remove();
    } catch (e) { copyText(txt, $('copyBox')); }
  });
  $('sImportToggle').addEventListener('click', function () { $('importBox').hidden = !$('importBox').hidden; });
  function parseCsv(text) {
    var rows = [], row = [], cur = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) { if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
      else if (c === '"') q = true;
      else if (c === ',') { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    return rows.filter(function (r) { return r.join('').trim(); });
  }
  $('sImport').addEventListener('click', async function () {
    var rows = parseCsv($('importText').value.replace(/^﻿/, ''));
    if (rows.length < 2) { toast('没有可导入的行'); return; }
    var hd = rows[0].map(function (x) { return x.trim().toLowerCase(); });
    var ix = function (k) { return hd.indexOf(k); };
    if (ix('datetime') < 0 || ix('rpm') < 0) { toast('表头要有 datetime 和 rpm'); return; }
    var have = {}; all().forEach(function (r) { have[t(r) + ':' + r.rpm] = 1; });
    var out = [];
    rows.slice(1).forEach(function (c) {
      var ms = new Date((c[ix('datetime')] || '').trim().replace(' ', 'T')).getTime(), rpm = parseInt(c[ix('rpm')], 10);
      if (isNaN(ms) || !(rpm >= 5 && rpm <= 150) || have[ms + ':' + rpm]) return;
      var m = ix('method') >= 0 ? (c[ix('method')] || '').trim() : '';
      out.push({ id: uuid(), pet_id: pet.id, ts: new Date(ms).toISOString(), rpm: rpm,
        method: ['30s', '60s', 'manual'].indexOf(m) >= 0 ? m : 'import',
        count: ix('count') >= 0 && c[ix('count')] ? parseInt(c[ix('count')], 10) || null : null,
        dur: ix('duration_sec') >= 0 && c[ix('duration_sec')] ? parseInt(c[ix('duration_sec')], 10) || null : null,
        asleep: ix('asleep') >= 0 ? c[ix('asleep')].trim() !== '0' : true,
        note: ix('note') >= 0 ? (c[ix('note')] || '').trim().slice(0, 200) : '' });
    });
    if (!out.length) { toast('没有新的行（重复的已跳过）'); return; }
    try {
      for (var i = 0; i < out.length; i += 200) await D.addRecords(out.slice(i, i + 200));
      toast('已导入 ' + out.length + ' 条'); $('importText').value = ''; $('importBox').hidden = true; await refresh();
    } catch (e) { toast(errText(e)); }
  });

  /* ---------- render ---------- */
  function renderAll() {
    if (!pet) return;
    $('title').textContent = pet.name + ' 熟睡呼吸记录';
    $('sosRate').textContent = '熟睡时呼吸持续高于 ' + pet.warn_red + ' 次/分';
    $('sosVet').textContent = pet.vet_name ? '医院：' + pet.vet_name + (pet.vet_phone ? '（' + pet.vet_phone + '）' : '') : '在设置里填医院名和电话。';
    renderAlert(); renderToday(); renderChart(); renderList(); renderEvents(); renderNet(); renderCounter();
  }
  var rzT; window.addEventListener('resize', function () { clearTimeout(rzT); rzT = setTimeout(function () { if (pet) renderChart(); }, 150); });

  /* ---------- install hint ---------- */
  (function () {
    var standalone = window.navigator.standalone || (window.matchMedia && matchMedia('(display-mode: standalone)').matches);
    var ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    if (ios && !standalone && !lsGet('pbl-install-dismissed', false)) $('installHint').hidden = false;
    $('installClose').addEventListener('click', function () { $('installHint').hidden = true; lsSet('pbl-install-dismissed', true); });
  })();

  /* ---------- boot ---------- */
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost') && !new URLSearchParams(location.search).get('mock')) {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
  D.onAuth(function (u) { if (!u && ctx) { ctx = null; show('viewAuth'); } });
  (async function () {
    try {
      var u = await D.init();
      if (!u) { show('viewAuth'); return; }
      me = D.userId();
      await loadContext();
    } catch (e) { show('viewAuth'); $('authErr').textContent = errText(e); }
  })();
})();
