import { LESSONS, SCENARIOS, EVENTS, BADGES, REASONS, AVATARS } from './content.js';
import * as sync from './sync.js';

// ---------- 小工具 ----------
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Math.random().toString(36).slice(2, 10);
const ntd = (v) => 'NT$' + Math.round(v).toLocaleString('zh-TW');
const pct = (v, digits = 1) => (v >= 0 ? '+' : '') + (v * 100).toFixed(digits) + '%';
const cls = (v) => (v > 0.00001 ? 'up' : v < -0.00001 ? 'down' : '');
const fmtPrice = (p) => (p >= 100 ? p.toFixed(1) : p >= 1 ? p.toFixed(2) : p.toFixed(3));
const today = () => new Date().toISOString().slice(0, 10);
const addDays = (d, n) => { const x = new Date(d + 'T00:00:00Z'); x.setUTCDate(x.getUTCDate() + n); return x.toISOString().slice(0, 10); };
const daysBetween = (a, b) => (new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 864e5;
const fmtDate = (d) => { const [y, m, dd] = d.split('-'); return `${y} 年 ${+m} 月 ${+dd} 日`; };

// ---------- 儲存 ----------
const KEY = 'kidtrader.v1';
// email：登入的 Email；fam：所屬家庭 { id: 家庭代碼, role: 'parent' | 'kid' }；solo：選了不登入
const defaultState = () => ({ v: 1, pin: null, startCash: 100000, profiles: [], cur: null, email: null, fam: null, solo: false });
let S = (() => {
  try { const s = JSON.parse(localStorage.getItem(KEY)); if (s && s.v === 1) return s; } catch (e) { /* 無法讀取就用新的 */ }
  return defaultState();
})();
function save() {
  const cur = prof();
  if (cur) cur.ts = Date.now();
  try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) { toast('⚠️ 無法儲存進度（瀏覽器不允許儲存）'); }
  schedulePush();
}
const prof = () => S.profiles.find((p) => p.id === S.cur);

// ---------- 家庭同步 ----------
// R.family：雲端的家庭設定；R.remote：家庭裡所有玩家（含其他手機上的）
const R = { family: null, remote: {}, unsub: [], online: false, linked: null };
let pushTimer = null;
function schedulePush() {
  if (!S.fam || !S.email) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(async () => {
    for (const p of S.profiles) {
      try { await sync.pushProfile(S.fam.id, p); } catch (e) { console.warn('同步失敗', e); }
    }
    const ids = S.profiles.map((p) => p.id);
    if (S.email && ids.join() !== R.linked) {
      try { await sync.setUser(emailKey(S.email), { profiles: ids }); R.linked = ids.join(); } catch (e) { console.warn('同步失敗', e); }
    }
  }, 1500);
}
// Firestore 的欄位名稱不能有「.」，所以 Email 裡的點換成逗號
const emailKey = (email) => email.replace(/\./g, ',');
const validEmail = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
// 登入後：從雲端帶回這個人的玩家，和這台手機上的合併（同一個玩家取最新的）
async function enterFamily(email, fid, role, pids) {
  const cloud = pids.length ? (await sync.listProfiles(fid)).filter((p) => pids.includes(p.id)) : [];
  const local = !S.email || S.email === email ? S.profiles : [];
  const byId = {};
  for (const p of [...cloud, ...local]) if (!byId[p.id] || (p.ts || 0) >= (byId[p.id].ts || 0)) byId[p.id] = p;
  S.profiles = Object.values(byId);
  S.email = email; S.fam = { id: fid, role }; S.solo = false;
  if (!S.profiles.some((p) => p.id === S.cur)) S.cur = S.profiles[0]?.id || null;
  R.linked = null;
  save();
  await connectFamily();
}
const ctl = (p) => R.family?.controls?.[p.id] || {};
const unlocked = (p) => (S.fam ? !!ctl(p).unlockAll : !!p.unlockAll);
const startCash = () => (S.fam && R.family?.startCash) || S.startCash;
// 這台手機的玩家優先，其餘用雲端的
function allProfiles() {
  const local = new Set(S.profiles.map((p) => p.id));
  return [...S.profiles, ...Object.values(R.remote).filter((p) => !local.has(p.id))];
}
// 套用家長從別支手機下的指令
function applyControls() {
  let changed = false;
  for (const p of [...S.profiles]) {
    const c = ctl(p);
    if (c.removed) { S.profiles = S.profiles.filter((x) => x !== p); if (S.cur === p.id) S.cur = null; changed = true; continue; }
    if (c.resetLiveAt && c.resetLiveAt > (p.liveResetAt || 0)) { p.live = null; p.liveResetAt = c.resetLiveAt; changed = true; }
    if (c.name && c.name !== p.name) { p.name = c.name; changed = true; }
  }
  if (changed) save();
}
const quietView = () => !document.querySelector('.modal-bg') && UI.view !== 'game' && !(UI.view === 'main' && UI.tab === 'learn');
async function connectFamily() {
  R.unsub.forEach((f) => f());
  R.unsub = [];
  if (!S.fam) return;
  try {
    R.unsub.push(await sync.watchFamily(S.fam.id, (f) => {
      R.family = f; R.online = true;
      applyControls();
      if (quietView()) render();
    }));
    R.unsub.push(await sync.watchProfiles(S.fam.id, (list) => {
      R.remote = Object.fromEntries(list.map((p) => [p.id, p]));
      if (quietView()) render();
    }));
    schedulePush();
  } catch (e) {
    console.warn(e);
    toast('⚠️ 暫時連不上雲端，進度會先存在這台手機');
  }
}
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newCode = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
const normCode = (x) => (x || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

// ---------- 行情資料 ----------
const D = { syms: [], byId: {}, hist: {}, histLoaded: false, live: null };
async function loadMeta() {
  const j = await (await fetch('data/symbols.json')).json();
  D.syms = j.symbols;
  for (const s of j.symbols) D.byId[s.id] = s;
}
async function loadHistory() {
  if (D.histLoaded) return;
  const ids = [...D.syms.map((s) => s.id), 'USDTWD'];
  await Promise.all(ids.map(async (id) => {
    try { const r = await fetch(`data/history/${id}.json`); if (r.ok) D.hist[id] = await r.json(); } catch (e) { /* 缺資料就略過 */ }
  }));
  D.histLoaded = true;
}
async function loadLive() {
  try {
    const r = await fetch('data/live.json?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) D.live = await r.json();
  } catch (e) { /* 保留舊資料 */ }
}
function idxAt(h, date) {
  let lo = 0, hi = h.d.length - 1, ans = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (h.d[m] <= date) { ans = m; lo = m + 1; } else hi = m - 1; }
  return ans;
}
function histPrice(id, date) {
  const h = D.hist[id]; if (!h) return null;
  const i = idxAt(h, date); return i < 0 ? null : h.c[i];
}
function fxAt(date) {
  const h = D.hist.USDTWD; if (!h) return 31;
  const i = idxAt(h, date); return h.c[Math.max(i, 0)];
}
const toTWD = (id, native, fx) => (D.byId[id]?.market === 'US' ? native * fx : native);
const visibleSyms = () => D.syms.filter((s) => !s.hidden);

// ---------- 進度與解鎖 ----------
const lessonDone = (p, k) => p.lessons.includes(k);
const finishedGames = (p) => p.games.filter((g) => g.done).length;
const lessonOpen = (p, k) => unlocked(p) || k === 1 || (lessonDone(p, k - 1) && finishedGames(p) >= k - 1);
const can = {
  trade: (p) => unlocked(p) || lessonDone(p, 1),
  etf: (p) => unlocked(p) || lessonDone(p, 2),
  fees: (p) => unlocked(p) || lessonDone(p, 4),
  live: (p) => unlocked(p) || lessonDone(p, 4),
  stops: (p) => unlocked(p) || lessonDone(p, 5),
  calc: (p) => unlocked(p) || lessonDone(p, 3),
  scenario: (p, sc) => unlocked(p) || lessonDone(p, sc.lesson),
};
const levelOf = (xp) => Math.floor(xp / 200) + 1;

function newProfile(name, avatar) {
  return { id: uid(), name, avatar, xp: 0, lessons: [], badges: {}, games: [], live: null, reviews: 0, notes: 0, unlockAll: false, created: Date.now() };
}
function addXp(p, n) { p.xp += n; }
function award(p, id) {
  if (p.badges[id]) return;
  p.badges[id] = today();
  addXp(p, 30);
  const b = BADGES.find((x) => x.id === id);
  toast(`${b.emoji} 獲得徽章：${b.name}！`, 4000);
}

// ---------- 帳戶與交易 ----------
const newAccount = (cash) => ({ cash, start: cash, holdings: {}, trades: [], stops: {} });
function holdingsValue(acc, ctx) {
  let v = 0;
  for (const [id, h] of Object.entries(acc.holdings)) {
    const p = ctx.price(id);
    v += p != null ? h.qty * toTWD(id, p, ctx.fx) : h.cost;
  }
  return v;
}
const totalValue = (acc, ctx) => acc.cash + holdingsValue(acc, ctx);
function calcFee(p, id, side, amt) {
  if (!can.fees(p) || amt <= 0) return 0;
  const s = D.byId[id];
  if (s.market === 'TW') {
    let f = Math.max(1, Math.round(amt * 0.001425));
    if (side === 'sell') f += Math.round(amt * (s.type === 'etf' ? 0.001 : 0.003));
    return f;
  }
  return Math.max(1, Math.round(amt * 0.001));
}
function execTrade(p, acc, ctx, { id, side, qty, reason, note, auto }) {
  const native = ctx.price(id);
  if (native == null) throw new Error('這檔股票目前沒有價格');
  const unit = toTWD(id, native, ctx.fx);
  const amt = unit * qty;
  const fee = calcFee(p, id, side, amt);
  let pnl = null;
  if (side === 'buy') {
    if (amt + fee > acc.cash + 1e-6) throw new Error('現金不夠');
    acc.cash -= amt + fee;
    const h = acc.holdings[id] || (acc.holdings[id] = { qty: 0, cost: 0, since: ctx.date });
    h.qty += qty; h.cost += amt + fee;
  } else {
    const h = acc.holdings[id];
    if (!h || h.qty < qty) throw new Error('股數不夠');
    const costPart = h.cost * qty / h.qty;
    acc.cash += amt - fee;
    h.qty -= qty; h.cost -= costPart;
    pnl = amt - fee - costPart;
    if (h.qty === 0) { delete acc.holdings[id]; delete acc.stops[id]; }
  }
  const t = { id: uid(), date: ctx.date, sym: id, side, qty, price: native, fx: ctx.fx, amt, fee, reason, note, pnl, auto: !!auto, review: null };
  acc.trades.push(t);
  return t;
}
function afterTrade(p, acc, t, mode) {
  if (!t.auto) { p.notes += 1; addXp(p, 5); }
  award(p, 'first_trade');
  if (p.notes >= 10) award(p, 'writer');
  if (t.side === 'buy' && D.byId[t.sym].type === 'etf') award(p, 'etf_fan');
  if (t.side === 'sell' && t.pnl > 0) award(p, 'profit');
  if (mode === 'live') award(p, 'live_trader');
  const ids = Object.keys(acc.holdings);
  if (ids.length >= 5 && new Set(ids.map((i) => D.byId[i].market)).size === 2) award(p, 'diversify');
}

// ---------- 歷史挑戰 ----------
const scById = (id) => SCENARIOS.find((s) => s.id === id);
const tlCache = {};
function timeline(sc) {
  if (tlCache[sc.id]) return tlCache[sc.id];
  const src = D.hist.SPY || D.hist.TWII;
  if (!src) return [];
  return (tlCache[sc.id] = src.d.filter((d) => d >= sc.start && d <= sc.end));
}
function benchId(sc) {
  const h = D.hist['0050'];
  return h && h.d[0] <= sc.start ? '0050' : 'TWII';
}
// 定期定額：每個月第一週投入相同金額；一次投入：第一週全部買進
const benchCache = {};
function benchSeries(sc, start) {
  const key = sc.id + start;
  if (benchCache[key]) return benchCache[key];
  const tl = timeline(sc), bid = benchId(sc);
  const firstOfMonth = tl.map((d, i) => i === 0 || d.slice(0, 7) !== tl[i - 1].slice(0, 7));
  const months = firstOfMonth.filter(Boolean).length;
  const per = start / months;
  let units = 0, left = start;
  const p0 = histPrice(bid, tl[0]);
  const dca = [], lump = [];
  tl.forEach((d, i) => {
    const pr = histPrice(bid, d);
    if (firstOfMonth[i] && pr) { units += per / pr; left -= per; }
    dca.push(units * pr + left);
    lump.push(start * pr / p0);
  });
  return (benchCache[key] = { id: bid, name: bid === '0050' ? '0050' : '加權指數', dca, lump });
}
function gameCtx(g) {
  const sc = scById(g.sc), tl = timeline(sc), date = tl[g.i];
  return { mode: 'game', date, fx: fxAt(date), price: (id) => histPrice(id, date) };
}
function startGame(p, sc) {
  const g = { id: uid(), sc: sc.id, i: 0, acc: newAccount(startCash()), snaps: [startCash()], preds: [], done: false, started: Date.now() };
  p.games.push(g);
  save();
  return g;
}
// 前進一週，回傳本週發生的新聞與停損
function stepGame(p, g) {
  const sc = scById(g.sc), tl = timeline(sc);
  if (g.i >= tl.length - 1) return { end: true, events: [], stopped: [] };
  const prev = tl[g.i];
  g.i += 1;
  const ctx = gameCtx(g);
  const stopped = [];
  for (const [id, stop] of Object.entries(g.acc.stops)) {
    const pr = ctx.price(id), h = g.acc.holdings[id];
    if (h && pr != null && pr <= stop) {
      const t = execTrade(p, g.acc, ctx, { id, side: 'sell', qty: h.qty, reason: '停利／停損', note: `價格跌到停損價 ${fmtPrice(stop)} 以下，自動賣出`, auto: true });
      afterTrade(p, g.acc, t, 'game');
      stopped.push(t);
    }
  }
  for (const h of Object.values(g.acc.holdings)) if (daysBetween(h.since, ctx.date) >= 364) award(p, 'diamond');
  g.snaps[g.i] = totalValue(g.acc, ctx);
  const events = EVENTS.filter((e) => e.d > addDays(prev, 6) && e.d <= addDays(ctx.date, 6)); // 每一格代表一整週
  return { end: g.i >= tl.length - 1, events, stopped };
}
function finishGame(p, g) {
  if (g.done) return;
  const sc = scById(g.sc);
  g.done = true;
  g.ended = Date.now();
  const final = g.snaps[g.i];
  const b = benchSeries(sc, g.acc.start);
  g.result = { ret: final / g.acc.start - 1, dca: b.dca[g.i] / g.acc.start - 1, lump: b.lump[g.i] / g.acc.start - 1, full: g.i >= timeline(sc).length - 1 };
  if (g.result.full) {
    addXp(p, 100);
    if (sc.id === 'crash2008' || sc.id === 'covid2020') award(p, 'survivor');
    if (sc.id === 'decade') award(p, 'compound');
    if (g.result.ret > g.result.dca) award(p, 'beat_bench');
  }
  save();
}

// ---------- 即時模式 ----------
function liveCtx() {
  const q = D.live?.quotes || {};
  return { mode: 'live', date: today(), fx: q.USDTWD?.p || 31, price: (id) => q[id]?.p ?? null };
}
function marketStatus(tz, open, close) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  const mins = (+parts.hour % 24) * 60 + +parts.minute;
  const weekday = !['Sat', 'Sun'].includes(parts.weekday);
  return weekday && mins >= open && mins < close;
}

// ---------- 圖表 ----------
function lineChart(series, { height = 200, labels = null } = {}) {
  const W = 600, H = height, pad = { l: 8, r: 8, t: 12, b: labels ? 22 : 8 };
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  if (all.length < 2) return '<div class="chart-empty">資料還不夠畫圖，多前進幾週吧！</div>';
  let min = Math.min(...all), max = Math.max(...all);
  if (max - min < 1e-9) { max += 1; min -= 1; }
  const n = Math.max(...series.map((s) => s.values.length));
  const x = (i) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * (W - pad.l - pad.r));
  const y = (v) => pad.t + (1 - (v - min) / (max - min)) * (H - pad.t - pad.b);
  const paths = series.map((s) => {
    let d = '', pen = false;
    s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1); pen = true; });
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2.5}" stroke-linejoin="round" stroke-linecap="round" ${s.dash ? 'stroke-dasharray="6 5"' : ''}/>`;
  }).join('');
  const lab = labels ? `<text x="${pad.l}" y="${H - 5}" class="ax">${esc(labels[0])}</text><text x="${W - pad.r}" y="${H - 5}" class="ax" text-anchor="end">${esc(labels[1])}</text>` : '';
  const legend = series.filter((s) => s.name).map((s) => `<span><i style="background:${s.color}"></i>${esc(s.name)}</span>`).join('');
  return `<div class="chart"><svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img">${paths}${lab}</svg>${legend ? `<div class="legend">${legend}</div>` : ''}</div>`;
}
function spark(values) {
  const v = values.filter((x) => x != null);
  if (v.length < 2) return '';
  const min = Math.min(...v), max = Math.max(...v), W = 80, H = 26;
  const d = v.map((p, i) => `${i ? 'L' : 'M'}${((i / (v.length - 1)) * W).toFixed(1)} ${(H - ((p - min) / (max - min || 1)) * H).toFixed(1)}`).join('');
  return `<svg class="spark ${v[v.length - 1] >= v[0] ? 'up' : 'down'}" viewBox="0 0 ${W} ${H}"><path d="${d}"/></svg>`;
}
function pastPrices(id, date, weeks = 52) {
  const h = D.hist[id]; if (!h) return [];
  const i = idxAt(h, date); if (i < 0) return [];
  return h.c.slice(Math.max(0, i - weeks + 1), i + 1);
}

// ---------- 介面狀態 ----------
const UI = { view: 'home', tab: 'play', gameId: null, filter: 'all', auto: null, parentOk: false };
const app = () => $('#app');
function go(view, extra = {}) { stopAuto(); Object.assign(UI, { view }, extra); render(); window.scrollTo(0, 0); }

function toast(msg, ms = 2500) {
  const t = document.createElement('div');
  t.className = 'toast'; t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => t.classList.add('hide'), ms);
  setTimeout(() => t.remove(), ms + 400);
}
function modal(html, { onMount, wide } = {}) {
  closeModal();
  const m = document.createElement('div');
  m.className = 'modal-bg';
  m.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog"><button class="x" data-close aria-label="關閉">✕</button>${html}</div>`;
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) closeModal(); });
  document.body.appendChild(m);
  document.body.classList.add('noscroll');
  onMount?.(m.querySelector('.modal'));
  return m;
}
function closeModal() { document.querySelectorAll('.modal-bg').forEach((m) => m.remove()); document.body.classList.remove('noscroll'); }
const waitModal = (html, opts = {}) => new Promise((resolve) => {
  const m = modal(html, { ...opts, onMount: (el) => { opts.onMount?.(el, resolve); el.querySelectorAll('[data-resolve]').forEach((b) => b.addEventListener('click', () => { closeModal(); resolve(b.dataset.resolve); })); } });
  m.addEventListener('click', (e) => { if (e.target === m || e.target.closest('[data-close]')) resolve(null); });
});

// ---------- 畫面：選擇玩家 ----------
function viewHome() {
  const cards = S.profiles.map((p) => `
    <button class="profile-card" data-act="pick" data-id="${p.id}">
      <span class="ava">${p.avatar}</span><b>${esc(p.name)}</b><small>Lv.${levelOf(p.xp)} · ${Object.keys(p.badges).length} 枚徽章</small>
    </button>`).join('');
  return `
  <div class="home">
    <h1 class="logo"><img src="icon.svg" alt=""> 小小操盤手</h1>
    <p class="sub">用虛擬的錢，學真正的投資</p>
    <div class="profiles">${cards}
      <button class="profile-card add" data-act="add-profile"><span class="ava">＋</span><b>新增玩家</b></button>
    </div>
    ${installPrompt ? '<button class="btn" data-act="install" style="margin-top:24px">📲 安裝到手機主畫面</button><br>' : ''}
    <button class="link" data-act="parent">👨‍👩‍👧 家長專區</button>
    ${S.email ? `<p class="small muted">已用 ${esc(S.email)} 登入 · <button class="link inline" data-act="logout">登出</button></p>` : sync.syncAvailable() ? '<p><button class="link inline" data-act="to-login">用 Email 登入，換手機也能接著玩</button></p>' : ''}
  </div>`;
}

// ---------- 畫面：主選單 ----------
function viewMain() {
  const p = prof();
  const tabs = [['play', '🎮', '挑戰'], ['live', '📡', '即時'], ['learn', '📚', '學習'], ['journal', '📒', '日記'], ['rank', '🏆', '排行']];
  const body = { play: tabPlay, live: tabLive, learn: tabLearn, journal: tabJournal, rank: tabRank }[UI.tab](p);
  return `
  <header class="top">
    <button class="me" data-act="home"><span class="ava sm">${p.avatar}</span>${esc(p.name)}</button>
    <div class="xp"><b>Lv.${levelOf(p.xp)}</b><div class="bar"><i style="width:${(p.xp % 200) / 2}%"></i></div><small>${p.xp} XP</small></div>
  </header>
  <main class="tab-body">${body}</main>
  <nav class="tabs">${tabs.map(([id, e, n]) => `<button class="${UI.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}"><span>${e}</span>${n}</button>`).join('')}</nav>`;
}

function tabPlay(p) {
  if (!D.hist.SPY && !D.hist.TWII) return `<div class="card warn">📦 歷史行情資料還在準備中，請稍後再來（第一次發布後約需幾分鐘）。</div>`;
  const nudge = !can.trade(p) ? `<div class="card hint" data-act="tab" data-tab="learn">👋 先到 <b>📚 學習</b> 上完第一課「股票是什麼？」，就能開始交易！</div>` : '';
  const active = p.games.filter((g) => !g.done);
  const act = active.map((g) => {
    const sc = scById(g.sc), tl = timeline(sc), v = g.snaps[g.i];
    return `<button class="card game-row" data-act="open-game" data-id="${g.id}">
      <span class="emo">${sc.emoji}</span><div><b>${sc.title}</b><small>進行中 · 第 ${g.i + 1}/${tl.length} 週 · ${fmtDate(tl[g.i])}</small></div>
      <span class="${cls(v / g.acc.start - 1)}">${pct(v / g.acc.start - 1)}</span></button>`;
  }).join('');
  const list = SCENARIOS.map((sc) => {
    const open = can.scenario(p, sc);
    const best = p.games.filter((g) => g.done && g.sc === sc.id && g.result?.full).map((g) => g.result.ret);
    const tl = timeline(sc);
    return `<button class="card sc ${open ? '' : 'locked'}" data-act="${open ? 'new-game' : 'locked'}" data-id="${sc.id}" data-lesson="${sc.lesson}">
      <span class="emo">${open ? sc.emoji : '🔒'}</span>
      <div><b>${sc.title}</b><small>${sc.start.slice(0, 4)}–${sc.end.slice(0, 4)} · ${tl.length} 週${open ? '' : ` · 完成第 ${sc.lesson} 課解鎖`}</small></div>
      ${best.length ? `<span class="best">最佳 ${pct(Math.max(...best))}</span>` : ''}</button>`;
  }).join('');
  return `${nudge}${act ? `<h2>繼續挑戰</h2>${act}` : ''}<h2>時光機挑戰</h2><p class="muted">回到過去的真實股市，一週一週往前走。你能贏過「每個月固定買 0050」的人嗎？</p>${list}`;
}

function tabLearn(p) {
  const rows = LESSONS.map((l) => {
    const done = lessonDone(p, l.id), open = lessonOpen(p, l.id);
    const need = !open ? (lessonDone(p, l.id - 1) ? `再完成 ${l.id - 1 - finishedGames(p)} 場挑戰解鎖` : `先完成第 ${l.id - 1} 課`) : '';
    return `<button class="card lesson ${open ? '' : 'locked'}" data-act="${open ? 'lesson' : 'locked-lesson'}" data-id="${l.id}">
      <span class="emo">${done ? '✅' : open ? l.emoji : '🔒'}</span>
      <div><b>第 ${l.id} 課：${l.title}</b><small>${done ? '已完成 · ' : ''}${open ? '解鎖：' + l.unlocks : need}</small></div></button>`;
  }).join('');
  const calc = can.calc(p) ? `<h2>🧮 複利計算機</h2><div class="card">${calcHtml()}</div>` : '';
  return `<h2>投資學堂</h2><p class="muted">每一課讀完後回答問題，全對就能解鎖新功能。</p>${rows}${calc}`;
}
function calcHtml() {
  return `<div class="calc">
    <label>每個月存 <input type="number" id="c-m" value="3000" min="0" step="500"> 元</label>
    <label>每年報酬率 <input type="number" id="c-r" value="7" min="0" max="30" step="0.5"> %</label>
    <label>存 <input type="number" id="c-y" value="20" min="1" max="60"> 年</label>
    <div id="c-out"></div></div>`;
}
function updateCalc() {
  const m = +$('#c-m')?.value || 0, r = (+$('#c-r')?.value || 0) / 100 / 12, y = Math.min(60, +$('#c-y')?.value || 1);
  if (!$('#c-out')) return;
  const inv = [], val = [];
  let v = 0;
  for (let i = 1; i <= y * 12; i++) { v = v * (1 + r) + m; if (i % 12 === 0) { inv.push(m * i); val.push(v); } }
  const put = m * y * 12;
  $('#c-out').innerHTML = `<p>你總共存了 <b>${ntd(put)}</b>，${y} 年後會變成 <b class="up">${ntd(v)}</b>。<br>其中 <b class="up">${ntd(v - put)}</b> 是複利幫你賺的！</p>
    ${lineChart([{ name: '有投資', color: 'var(--up)', values: val }, { name: '只存不投資', color: 'var(--muted)', values: inv, dash: true }], { height: 160, labels: ['第 1 年', `第 ${y} 年`] })}`;
}

function allTrades(p) {
  const out = [];
  for (const g of p.games) for (const t of g.acc.trades) out.push({ t, g, where: scById(g.sc).title });
  if (p.live) for (const t of p.live.acc.trades) out.push({ t, g: null, where: '即時模式' });
  return out.sort((a, b) => (b.t.date + b.t.id).localeCompare(a.t.date + a.t.id));
}
function tabJournal(p) {
  const list = allTrades(p);
  if (!list.length) return `<h2>交易日記</h2><div class="card muted">還沒有交易。每次買賣寫下的理由，都會記在這裡。挑戰結束後可以回來檢查：當初的想法對不對？</div>`;
  const rows = list.map(({ t, g, where }) => {
    const s = D.byId[t.sym];
    const canReview = !g || g.done;
    const rv = t.review ? `<div class="review"><b>${{ good: '👍 好決定', ok: '🤔 普通', bad: '👎 下次不會這樣' }[t.review.verdict]}</b> ${esc(t.review.text)}</div>`
      : canReview ? `<button class="btn sm" data-act="review" data-tid="${t.id}">🔍 回顧這筆交易</button>` : '<small class="muted">挑戰結束後才能回顧（不能偷看未來！）</small>';
    return `<div class="card trade ${t.side}">
      <div class="tr-h"><span class="tag ${t.side}">${t.side === 'buy' ? '買進' : '賣出'}</span><b>${esc(s.name)}</b> ${t.qty} 股 @ ${fmtPrice(t.price)}
      <small class="muted">${esc(where)} · ${t.date}</small></div>
      <div class="note">${t.auto ? '🤖 ' : '💭 '}<span class="chip">${esc(t.reason)}</span> ${esc(t.note)}</div>
      ${t.pnl != null ? `<small>這筆賣出 <b class="${cls(t.pnl)}">${t.pnl >= 0 ? '賺' : '賠'} ${ntd(Math.abs(t.pnl))}</b></small>` : ''}
      ${rv}</div>`;
  }).join('');
  return `<h2>交易日記</h2><p class="muted">回顧過去的交易，想想當初的理由對不對。每回顧一筆 +10 XP。</p>${rows}`;
}

function tabRank(p) {
  const everyone = allProfiles();
  const board = everyone.flatMap((x) => x.games.filter((g) => g.done && g.result?.full).map((g) => ({ pid: x.id, sc: g.sc, ret: g.result.ret, dca: g.result.dca })));
  const name = (pid) => { const x = everyone.find((q) => q.id === pid); return x ? `${x.avatar} ${esc(x.name)}` : '（已刪除）'; };
  const sections = SCENARIOS.map((sc) => {
    const best = {};
    for (const r of board) if (r.sc === sc.id && (!best[r.pid] || r.ret > best[r.pid].ret)) best[r.pid] = r;
    const rows = Object.values(best).sort((a, b) => b.ret - a.ret);
    if (!rows.length) return '';
    return `<div class="card"><b>${sc.emoji} ${sc.title}</b><table class="rank">${rows.map((r, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${name(r.pid)}</td><td class="${cls(r.ret)}">${pct(r.ret)}</td><td class="muted">0050 定額 ${pct(r.dca)}</td></tr>`).join('')}</table></div>`;
  }).join('');
  const lc = liveCtx();
  const live = everyone.filter((x) => x.live && D.live).map((x) => ({ x, r: totalValue(x.live.acc, lc) / x.live.acc.start - 1 })).sort((a, b) => b.r - a.r);
  const liveHtml = live.length ? `<div class="card"><b>📡 即時模式</b><table class="rank">${live.map(({ x, r }, i) => `<tr><td>${['🥇', '🥈', '🥉'][i] || i + 1}</td><td>${x.avatar} ${esc(x.name)}</td><td class="${cls(r)}">${pct(r)}</td></tr>`).join('')}</table></div>` : '';
  const badges = BADGES.map((b) => `<div class="badge ${p.badges[b.id] ? 'got' : ''}" title="${esc(b.desc)}"><span>${b.emoji}</span><b>${b.name}</b><small>${p.badges[b.id] ? p.badges[b.id] : esc(b.desc)}</small></div>`).join('');
  return `<h2>排行榜</h2>${sections || liveHtml ? sections + liveHtml : '<div class="card muted">完成一場挑戰就會出現在排行榜上。</div>'}
    <h2>我的徽章（${Object.keys(p.badges).length}/${BADGES.length}）</h2><div class="badges">${badges}</div>`;
}

// ---------- 市場列表與持股（挑戰與即時共用） ----------
function marketList(p, ctx, chg) {
  const f = UI.filter;
  const syms = visibleSyms().filter((s) => (f === 'all' || (f === 'etf' ? s.type === 'etf' : s.market === f)) && ctx.price(s.id) != null);
  const rows = syms.map((s) => {
    const pr = ctx.price(s.id), c = chg(s.id), locked = s.type === 'etf' && !can.etf(p);
    const sp = ctx.mode === 'game' ? spark(pastPrices(s.id, ctx.date, 26)) : spark([...pastPrices(s.id, today(), 26), pr]);
    return `<button class="mrow ${locked ? 'locked' : ''}" data-act="${locked ? 'locked-etf' : 'trade'}" data-id="${s.id}">
      <span class="flag">${s.market === 'TW' ? '🇹🇼' : '🇺🇸'}</span>
      <div class="nm"><b>${esc(s.name)}${s.type === 'etf' ? ' <span class="chip">ETF</span>' : ''}</b><small>${s.id}${locked ? ' · 🔒 第 2 課解鎖' : ''}</small></div>
      ${sp}
      <div class="px"><b>${s.market === 'US' ? 'US$' : ''}${fmtPrice(pr)}</b><small class="${cls(c)}">${c == null ? '' : pct(c)}</small></div></button>`;
  }).join('');
  const fb = [['all', '全部'], ['TW', '台股'], ['US', '美股'], ['etf', 'ETF']].map(([k, n]) => `<button class="${f === k ? 'on' : ''}" data-act="filter" data-f="${k}">${n}</button>`).join('');
  return `<div class="filters">${fb}</div><div class="market">${rows || '<div class="muted">這個時期沒有資料</div>'}</div>`;
}
function holdingsHtml(p, acc, ctx) {
  const ids = Object.keys(acc.holdings);
  if (!ids.length) return '<div class="muted small">還沒有持股。點下方的股票來買進。</div>';
  return `<table class="hold"><tr><th>股票</th><th>股數</th><th>市值</th><th>損益</th>${can.stops(p) ? '<th>停損</th>' : ''}</tr>${ids.map((id) => {
    const h = acc.holdings[id], pr = ctx.price(id), v = pr != null ? h.qty * toTWD(id, pr, ctx.fx) : h.cost, r = v / h.cost - 1;
    return `<tr data-act="trade" data-id="${id}"><td><b>${esc(D.byId[id].name)}</b></td><td>${h.qty}</td><td>${ntd(v)}</td><td class="${cls(r)}">${pct(r)}</td>
      ${can.stops(p) ? `<td><button class="btn xs ${acc.stops[id] ? 'on' : ''}" data-act="stop" data-id="${id}">${acc.stops[id] ? fmtPrice(acc.stops[id]) : '設定'}</button></td>` : ''}</tr>`;
  }).join('')}</table>`;
}

// ---------- 畫面：挑戰進行中 ----------
function curGame() { return prof()?.games.find((g) => g.id === UI.gameId); }
function viewGame() {
  const p = prof(), g = curGame();
  if (!g) { UI.view = 'main'; return viewMain(); }
  const sc = scById(g.sc), tl = timeline(sc), ctx = gameCtx(g);
  const v = totalValue(g.acc, ctx), b = benchSeries(sc, g.acc.start);
  const ret = v / g.acc.start - 1, bret = b.dca[g.i] / g.acc.start - 1;
  const chg = (id) => { const now = histPrice(id, ctx.date), pr = g.i > 0 ? histPrice(id, tl[g.i - 1]) : null; return now && pr ? now / pr - 1 : null; };
  const chart = lineChart([
    { name: '我的資產', color: 'var(--accent)', values: g.snaps.slice(0, g.i + 1) },
    { name: `定期定額 ${b.name}`, color: 'var(--gold)', values: b.dca.slice(0, g.i + 1), dash: true },
    { name: `一次買 ${b.name} 放著`, color: 'var(--muted)', values: b.lump.slice(0, g.i + 1), width: 1.5 },
  ], { labels: [tl[0], ctx.date] });
  const done = g.done;
  return `
  <header class="top game">
    <button class="back" data-act="back">‹</button>
    <div><b>${sc.emoji} ${sc.title}</b><small>${fmtDate(ctx.date)} 那一週 · 第 ${g.i + 1}/${tl.length} 週</small></div>
    <span class="prog"><i style="width:${((g.i + 1) / tl.length) * 100}%"></i></span>
  </header>
  <main class="game-body">
    <div class="stats">
      <div><small>總資產</small><b>${ntd(v)}</b><small class="${cls(ret)}">${pct(ret)}</small></div>
      <div><small>現金</small><b>${ntd(g.acc.cash)}</b><small>${can.fees(p) ? '含手續費' : '新手免手續費'}</small></div>
      <div><small>定期定額 ${b.name}</small><b class="${cls(bret)}">${pct(bret)}</b><small class="${ret >= bret ? 'up' : 'down'}">${ret >= bret ? '你領先！' : '你落後'}</small></div>
    </div>
    ${chart}
    ${done ? `<div class="card hint">🏁 挑戰已結束。<button class="btn sm" data-act="summary">看成績</button></div>` : `
    <div class="controls">
      <button class="btn big" data-act="step" data-n="1">下一週 ▶</button>
      <button class="btn" data-act="step" data-n="4">快轉 4 週 ⏩</button>
      <button class="btn ${UI.auto ? 'on' : ''}" data-act="auto">${UI.auto ? '⏸ 暫停' : '▶▶ 自動'}</button>
      <button class="btn ghost" data-act="end-game">結束</button>
    </div>`}
    <h3>我的持股</h3>${holdingsHtml(p, g.acc, ctx)}
    <h3>市場 <small class="muted">（價格已含股利還原${D.hist.USDTWD ? `，1 美元 ≈ ${ctx.fx.toFixed(1)} 台幣` : ''}）</small></h3>
    ${marketList(p, ctx, chg)}
  </main>`;
}

async function doSteps(n) {
  const p = prof(), g = curGame();
  if (!g || g.done) return;
  for (let k = 0; k < n; k++) {
    const r = stepGame(p, g);
    for (const t of r.stopped) toast(`🛑 ${D.byId[t.sym].name} 觸發停損，自動賣出`, 3500);
    if (r.events.length || r.end) {
      save(); render();
      for (const e of r.events) await showEvent(g, e);
      if (r.end) { stopAuto(); finishGame(p, g); render(); await showSummary(p, g); return true; }
      if (r.events.length) { stopAuto(); return true; }
    }
  }
  save(); render();
  return false;
}
async function showEvent(g, e) {
  const sc = scById(g.sc);
  const pred = await waitModal(`
    <div class="news"><small>📰 ${fmtDate(e.d)} 新聞快報</small><h2>${esc(e.t)}</h2><p>${esc(e.b)}</p></div>
    <p><b>你覺得接下來 3 個月，股市會？</b></p>
    <div class="row"><button class="btn" data-resolve="up">📈 上漲</button><button class="btn" data-resolve="down">📉 下跌</button><button class="btn ghost" data-resolve="unsure">🤷 不知道</button></div>`);
  g.preds.push({ d: e.d, t: e.t, pred: pred || 'unsure', bench: benchId(sc), date: timeline(sc)[g.i] });
  save();
}
function stopAuto() { if (UI.auto) { clearInterval(UI.auto); UI.auto = null; } }
let stepping = false;
function toggleAuto() {
  if (UI.auto) { stopAuto(); render(); return; }
  UI.auto = setInterval(async () => {
    if (stepping) return;
    stepping = true;
    try { if (await doSteps(1)) stopAuto(); } finally { stepping = false; }
    render();
  }, 450);
  render();
}
async function showSummary(p, g) {
  const sc = scById(g.sc), r = g.result, b = benchSeries(sc, g.acc.start);
  const predRows = g.preds.map((x) => {
    const tl = timeline(sc);
    const after = histPrice(x.bench, addDays(x.date, 91)), now = histPrice(x.bench, x.date);
    const real = after && now ? after / now - 1 : null;
    const right = real == null || x.pred === 'unsure' ? '' : (real > 0) === (x.pred === 'up') ? '✅' : '❌';
    return `<tr><td>${esc(x.t)}</td><td>${{ up: '📈', down: '📉', unsure: '🤷' }[x.pred]}</td><td class="${cls(real)}">${real == null ? '—' : pct(real)}</td><td>${right}</td></tr>`;
  }).join('');
  const win = r.ret > r.dca;
  const choice = await waitModal(`
    <h2>${win ? '🏆 你贏過定期定額了！' : '🏁 挑戰結束'}</h2>
    <div class="stats">
      <div><small>你的報酬</small><b class="${cls(r.ret)}">${pct(r.ret)}</b></div>
      <div><small>定期定額 ${b.name}</small><b class="${cls(r.dca)}">${pct(r.dca)}</b></div>
      <div><small>一次買 ${b.name}</small><b class="${cls(r.lump)}">${pct(r.lump)}</b></div>
    </div>
    <p>${win ? '厲害！不過也想一想：是實力還是運氣？到日記回顧每筆交易吧。' : '大部分專業基金經理人也贏不了大盤喔！到日記回顧你的交易，找找看哪裡可以做得更好。'}</p>
    ${predRows ? `<h3>你的新聞預測（之後 3 個月 ${b.name} 的真實走勢）</h3><table class="rank">${predRows}</table>` : ''}
    <div class="row"><button class="btn big" data-resolve="journal">📒 去回顧交易</button><button class="btn ghost" data-resolve="ok">好</button></div>`, { wide: true });
  if (choice === 'journal') go('main', { tab: 'journal' });
}

// ---------- 交易視窗 ----------
function tradeModal(id, mode) {
  const p = prof();
  const g = mode === 'game' ? curGame() : null;
  const acc = g ? g.acc : p.live.acc;
  const ctx = g ? gameCtx(g) : liveCtx();
  if (g?.done) { toast('挑戰已經結束囉'); return; }
  if (!can.trade(p)) { toast('先完成第一課才能交易喔！'); return; }
  const s = D.byId[id], pr = ctx.price(id), unit = toTWD(id, pr, ctx.fx), h = acc.holdings[id];
  const hist = g ? pastPrices(id, ctx.date, 52) : [...pastPrices(id, today(), 52), pr];
  let side = 'buy';
  modal(`
    <div class="t-head"><span class="flag">${s.market === 'TW' ? '🇹🇼' : '🇺🇸'}</span><div><h2>${esc(s.name)} <small>${s.id}</small></h2><small class="muted">${esc(s.desc)}</small></div></div>
    <div class="t-price"><b>${s.market === 'US' ? 'US$' : 'NT$'}${fmtPrice(pr)}</b>${s.market === 'US' ? ` <small>≈ ${ntd(unit)}／股</small>` : '<small>／股</small>'}</div>
    ${lineChart([{ color: 'var(--accent)', values: hist }], { height: 120, labels: ['一年前', '現在'] })}
    ${h ? `<p class="small">你有 <b>${h.qty}</b> 股，平均成本 ${ntd(h.cost / h.qty)}／股，現在 <b class="${cls(h.qty * unit / h.cost - 1)}">${pct(h.qty * unit / h.cost - 1)}</b></p>` : ''}
    <div class="seg"><button class="on" data-side="buy">買進</button><button data-side="sell" ${h ? '' : 'disabled'}>賣出</button></div>
    <label class="qty">股數 <button class="btn xs" data-q="-10">−10</button><button class="btn xs" data-q="-1">−</button><input type="number" id="t-qty" value="1" min="1" inputmode="numeric"><button class="btn xs" data-q="1">＋</button><button class="btn xs" data-q="10">+10</button><button class="btn xs" data-q="max">最多</button></label>
    <div id="t-calc" class="small"></div>
    <p class="lbl">為什麼要<span id="t-verb">買</span>？（必填）</p>
    <div class="chips">${REASONS.map((r) => `<button class="chip" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
    <textarea id="t-note" rows="3" maxlength="300" placeholder="用自己的話寫下理由，例如：「AI 很紅，輝達的晶片賣到缺貨，我覺得明年還會成長」"></textarea>
    <div id="t-err" class="err"></div>
    <button class="btn big full" id="t-go">確認買進</button>`, {
    onMount: (m) => {
      let reason = null;
      const qtyEl = $('#t-qty', m);
      const maxQty = () => {
        if (side === 'sell') return h ? h.qty : 0;
        let q = Math.floor(acc.cash / unit);
        while (q > 0 && q * unit + calcFee(p, id, 'buy', q * unit) > acc.cash) q--;
        return q;
      };
      const upd = () => {
        const q = Math.max(0, Math.floor(+qtyEl.value || 0)), amt = q * unit, fee = calcFee(p, id, side, amt);
        $('#t-calc', m).innerHTML = side === 'buy'
          ? `金額 ${ntd(amt)} ＋ 手續費 ${ntd(fee)} ＝ <b>${ntd(amt + fee)}</b>　<span class="muted">（現金 ${ntd(acc.cash)}，最多 ${maxQty()} 股）</span>`
          : `金額 ${ntd(amt)} － 手續費和稅 ${ntd(fee)} ＝ 拿回 <b>${ntd(amt - fee)}</b>`;
        $('#t-verb', m).textContent = side === 'buy' ? '買' : '賣';
        $('#t-go', m).textContent = side === 'buy' ? '確認買進' : '確認賣出';
        $('#t-go', m).className = 'btn big full ' + side;
      };
      m.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => {
        side = b.dataset.side; m.querySelectorAll('[data-side]').forEach((x) => x.classList.toggle('on', x === b));
        if (side === 'sell') qtyEl.value = h.qty;
        upd();
      }));
      m.querySelectorAll('[data-q]').forEach((b) => b.addEventListener('click', () => {
        qtyEl.value = b.dataset.q === 'max' ? maxQty() : Math.max(1, Math.min(maxQty() || 1, (+qtyEl.value || 0) + +b.dataset.q));
        upd();
      }));
      m.querySelectorAll('[data-reason]').forEach((b) => b.addEventListener('click', () => {
        reason = b.dataset.reason; m.querySelectorAll('[data-reason]').forEach((x) => x.classList.toggle('on', x === b));
      }));
      qtyEl.addEventListener('input', upd);
      $('#t-go', m).addEventListener('click', () => {
        const q = Math.floor(+qtyEl.value || 0), note = $('#t-note', m).value.trim(), err = $('#t-err', m);
        if (q <= 0) return (err.textContent = '請輸入股數');
        if (q > maxQty()) return (err.textContent = side === 'buy' ? '現金不夠買這麼多股' : '你沒有這麼多股');
        if (!reason) return (err.textContent = '請選一個理由類別');
        if (note.length < 6) return (err.textContent = '請用一句話寫下你的理由（至少 6 個字）');
        try {
          const t = execTrade(p, acc, ctx, { id, side, qty: q, reason, note });
          if (g) g.snaps[g.i] = totalValue(acc, ctx);
          afterTrade(p, acc, t, mode);
          save(); closeModal(); render();
          toast(`${side === 'buy' ? '✅ 買進' : '✅ 賣出'} ${s.name} ${q} 股`);
        } catch (e) { err.textContent = e.message; }
      });
      upd();
    },
  });
}
function stopModal(id, mode) {
  const p = prof(), g = mode === 'game' ? curGame() : null, acc = g ? g.acc : p.live.acc, ctx = g ? gameCtx(g) : liveCtx();
  const pr = ctx.price(id), s = D.byId[id];
  modal(`<h2>🛑 ${esc(s.name)} 停損設定</h2>
    <p>現在價格 ${fmtPrice(pr)}。如果每週收盤價跌到停損價以下，就自動全部賣出。</p>
    <div class="row">${[5, 10, 15, 20].map((x) => `<button class="btn" data-pct="${x}">跌 ${x}%<br><small>${fmtPrice(pr * (1 - x / 100))}</small></button>`).join('')}</div>
    ${acc.stops[id] ? '<button class="btn ghost full" data-pct="0">取消停損</button>' : ''}`, {
    onMount: (m) => m.querySelectorAll('[data-pct]').forEach((b) => b.addEventListener('click', () => {
      const x = +b.dataset.pct;
      if (x) { acc.stops[id] = +(pr * (1 - x / 100)).toFixed(4); award(p, 'stoploss'); } else delete acc.stops[id];
      save(); closeModal(); render();
    })),
  });
}

// ---------- 回顧 ----------
function reviewModal(tid) {
  const p = prof();
  const item = allTrades(p).find((x) => x.t.id === tid);
  if (!item) return;
  const { t, g } = item, s = D.byId[t.sym];
  let after;
  if (g) {
    const later = (w) => { const v = histPrice(t.sym, addDays(t.date, w * 7)); return v ? v / t.price - 1 : null; };
    const a3 = later(13), a12 = later(52);
    after = `<p>${t.side === 'buy' ? '買進' : '賣出'}之後，${esc(s.name)} 的股價：</p><div class="stats"><div><small>3 個月後</small><b class="${cls(a3)}">${a3 == null ? '—' : pct(a3)}</b></div><div><small>1 年後</small><b class="${cls(a12)}">${a12 == null ? '—' : pct(a12)}</b></div></div>`;
  } else {
    const now = liveCtx().price(t.sym);
    const r = now ? now / t.price - 1 : null;
    after = `<p>從那時到現在，${esc(s.name)} 的股價 <b class="${cls(r)}">${r == null ? '—' : pct(r)}</b></p>`;
  }
  modal(`<h2>🔍 回顧交易</h2>
    <p><span class="tag ${t.side}">${t.side === 'buy' ? '買進' : '賣出'}</span> <b>${esc(s.name)}</b> ${t.qty} 股 @ ${fmtPrice(t.price)}（${t.date}）</p>
    <div class="note">當時的理由：<span class="chip">${esc(t.reason)}</span> ${esc(t.note)}</div>
    ${after}
    <p class="lbl">現在回頭看，這是好決定嗎？</p>
    <div class="seg v"><button data-v="good">👍 好決定</button><button data-v="ok">🤔 普通</button><button data-v="bad">👎 下次不會這樣</button></div>
    <textarea id="r-text" rows="3" maxlength="300" placeholder="我學到了什麼？例如：「我太早賣了，應該相信自己的理由」"></textarea>
    <div id="r-err" class="err"></div><button class="btn big full" id="r-go">儲存回顧 (+10 XP)</button>`, {
    onMount: (m) => {
      let v = null;
      m.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', () => { v = b.dataset.v; m.querySelectorAll('[data-v]').forEach((x) => x.classList.toggle('on', x === b)); }));
      $('#r-go', m).addEventListener('click', () => {
        const text = $('#r-text', m).value.trim();
        if (!v || text.length < 4) { $('#r-err', m).textContent = '選一個評價，並寫下你學到的事'; return; }
        t.review = { verdict: v, text, date: today() };
        p.reviews += 1; addXp(p, 10);
        if (p.reviews >= 5) award(p, 'reviewer');
        save(); closeModal(); render();
      });
    },
  });
}

// ---------- 課程 ----------
function lessonModal(k) {
  const p = prof(), l = LESSONS.find((x) => x.id === k);
  modal(`<h2>${l.emoji} 第 ${l.id} 課：${l.title}</h2><div class="lesson-body">${l.body}</div>
    <h3>小測驗</h3>${l.quiz.map((q, i) => `<div class="quiz" data-i="${i}"><p><b>${i + 1}. ${esc(q.q)}</b></p>${q.a.map((a, j) => `<button class="opt" data-j="${j}">${esc(a)}</button>`).join('')}</div>`).join('')}
    <div id="q-err" class="err"></div><button class="btn big full" id="q-go">交卷</button>`, {
    wide: true,
    onMount: (m) => {
      const ans = {};
      m.querySelectorAll('.quiz').forEach((qz) => qz.querySelectorAll('.opt').forEach((o) => o.addEventListener('click', () => {
        ans[qz.dataset.i] = +o.dataset.j; qz.querySelectorAll('.opt').forEach((x) => x.classList.toggle('on', x === o));
      })));
      $('#q-go', m).addEventListener('click', () => {
        let wrong = 0;
        m.querySelectorAll('.quiz').forEach((qz) => {
          const i = qz.dataset.i, ok = ans[i] === l.quiz[i].c;
          qz.classList.toggle('bad', !ok); qz.classList.toggle('good', ok);
          if (!ok) wrong++;
        });
        if (wrong) { $('#q-err', m).textContent = `有 ${wrong} 題答錯了，再想想看！`; return; }
        if (!lessonDone(p, k)) {
          p.lessons.push(k); addXp(p, 50);
          if (LESSONS.every((x) => lessonDone(p, x.id))) award(p, 'scholar');
          save();
        }
        closeModal(); render();
        toast(`🎉 第 ${k} 課完成！解鎖：${l.unlocks}`, 4500);
      });
    },
  });
}

// ---------- 即時模式 ----------
function tabLive(p) {
  if (!can.live(p)) return `<h2>即時模式</h2><div class="card locked-big">🔒 完成第 4 課「手續費和稅」就能解鎖即時模式，用現在真正的股價來練習！</div>`;
  if (!D.live) return `<h2>即時模式</h2><div class="card warn">📡 即時行情資料還在準備中，請稍後再試。</div>`;
  if (!p.live) return `<h2>即時模式</h2><div class="card"><p>用現在真實的股價（約延遲 15 分鐘）練習交易。你會拿到 <b>${ntd(startCash())}</b> 虛擬現金，這個帳戶會一直保留，看看幾個月後的成果！</p><button class="btn big" data-act="live-start">開設即時帳戶</button></div>`;
  const ctx = liveCtx(), acc = p.live.acc, v = totalValue(acc, ctx), ret = v / acc.start - 1;
  const q = D.live.quotes;
  const snaps = p.live.snaps;
  if (!snaps.length || snaps[snaps.length - 1].d !== today()) snaps.push({ d: today(), v }); else snaps[snaps.length - 1].v = v;
  save();
  const b0 = p.live.bench0, bp = q['0050']?.p, bret = b0 && bp ? bp / b0 - 1 : null;
  const upd = new Date(D.live.updated * 1000).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  const tw = marketStatus('Asia/Taipei', 540, 810), us = marketStatus('America/New_York', 570, 960);
  const chg = (id) => (q[id]?.p && q[id]?.prev ? q[id].p / q[id].prev - 1 : null);
  return `
  <div class="live-status"><span>🕒 更新於 ${upd}（約延遲 15 分鐘）</span><span>🇹🇼 ${tw ? '<b class="up">開盤中</b>' : '已收盤'}</span><span>🇺🇸 ${us ? '<b class="up">開盤中</b>' : '已收盤'}</span></div>
  <div class="stats">
    <div><small>總資產</small><b>${ntd(v)}</b><small class="${cls(ret)}">${pct(ret)}</small></div>
    <div><small>現金</small><b>${ntd(acc.cash)}</b></div>
    <div><small>同時間買 0050</small><b class="${cls(bret)}">${bret == null ? '—' : pct(bret)}</b></div>
  </div>
  ${snaps.length > 1 ? lineChart([{ name: '我的資產', color: 'var(--accent)', values: snaps.map((x) => x.v) }], { height: 140, labels: [snaps[0].d, snaps[snaps.length - 1].d] }) : '<p class="muted small">每天打開一次，這裡就會畫出你的資產變化。</p>'}
  <h3>我的持股</h3>${holdingsHtml(p, acc, ctx)}
  <h3>市場 <small class="muted">（今日漲跌，1 美元 ≈ ${ctx.fx.toFixed(2)} 台幣）</small></h3>
  ${marketList(p, ctx, chg)}
  <p class="muted small">收盤後以最後成交價計算。美股約在台灣時間晚上 9:30 開盤。</p>`;
}

// ---------- 家長專區 ----------
function viewParent() {
  if (!UI.parentOk) return '';
  const lc = liveCtx();
  const fam = S.fam;
  const kids = (fam ? allProfiles() : S.profiles).map((p) => {
    const trades = allTrades(p).slice(0, 8);
    const lv = p.live && D.live ? totalValue(p.live.acc, lc) : null;
    return `<div class="card kid">
      <div class="kid-h"><span class="ava">${p.avatar}</span><div><b>${esc(p.name)}</b><small>Lv.${levelOf(p.xp)} · ${p.xp} XP · 課程 ${p.lessons.length}/${LESSONS.length} · 完成挑戰 ${finishedGames(p)} 場 · 徽章 ${Object.keys(p.badges).length}</small></div></div>
      <p class="small">交易 ${allTrades(p).length} 筆 · 已回顧 ${p.reviews} 筆${lv != null ? ` · 即時帳戶 ${ntd(lv)}（<span class="${cls(lv / p.live.acc.start - 1)}">${pct(lv / p.live.acc.start - 1)}</span>）` : ''}</p>
      ${trades.length ? `<details><summary>最近的交易理由</summary>${trades.map(({ t, where }) => `<div class="pnote"><span class="tag ${t.side}">${t.side === 'buy' ? '買' : '賣'}</span> ${esc(D.byId[t.sym].name)} · <small>${esc(where)} ${t.date}</small><br>💭 ${esc(t.note)}${t.review ? `<br>🔍 ${esc(t.review.text)}` : ''}</div>`).join('')}</details>` : ''}
      <div class="row">
        <button class="btn sm" data-act="p-unlock" data-id="${p.id}">${unlocked(p) ? '取消全部解鎖' : '解鎖全部功能'}</button>
        ${p.live ? `<button class="btn sm ghost" data-act="p-reset-live" data-id="${p.id}">重設即時帳戶</button>` : ''}
        <button class="btn sm ghost" data-act="p-rename" data-id="${p.id}">改名</button>
        <button class="btn sm danger" data-act="p-delete" data-id="${p.id}">刪除</button>
      </div></div>`;
  }).join('');
  return `
  <header class="top game"><button class="back" data-act="home">‹</button><div><b>👨‍👩‍👧 家長專區</b><small>${fam ? '全家的進度會自動同步' : '查看孩子的進度和交易理由'}</small></div></header>
  <main class="game-body">
    ${kids || `<div class="card muted">${fam ? '還沒有孩子加入。在下面「家人」加入孩子的 Email，孩子用那個 Email 登入就會自動加入。' : '還沒有玩家。'}</div>`}
    ${fam?.role === 'parent' ? '<button class="btn full" data-act="home">🎮 我也要玩</button>' : ''}
    <h3>設定</h3>
    <div class="card">
      <label>新挑戰的起始資金 <input type="number" id="p-cash" value="${startCash()}" min="10000" step="10000"> 元</label>
      <div class="row"><button class="btn sm" data-act="p-cash">儲存</button><button class="btn sm ghost" data-act="p-pin">${fam || S.pin ? '更改' : '設定'}家長密碼</button></div>
    </div>
    ${fam ? membersHtml() : ''}
    ${sync.syncAvailable() ? `<h3>這台手機</h3>
    <div class="card"><p class="small">${S.email ? `已用 <b>${esc(S.email)}</b> 登入（${fam?.role === 'parent' ? '家長' : '小孩'}）。 ${R.online ? '🟢 已連線' : '⚪ 連線中…'}` : '還沒登入，進度只存在這台手機。'}</p>
      <button class="btn sm ghost" data-act="${S.email ? 'logout' : 'to-login'}">${S.email ? '登出' : '用 Email 登入'}</button></div>` : ''}
    <h3>備份與換裝置</h3>
    <div class="card">
      <p class="small">${fam ? '進度已經自動同步到雲端。也可以另外匯出一份備份。' : '所有進度存在這台裝置的瀏覽器裡。要換手機或平板，先在這裡匯出，再到新裝置匯入。'}</p>
      <div class="row"><button class="btn sm" data-act="p-export">⬇️ 匯出進度</button><label class="btn sm ghost">⬆️ 匯入進度<input type="file" accept=".json,application/json" id="p-import" hidden></label></div>
    </div>
    ${window.AndroidApp ? '' : `<h3>手機 App</h3>
    <div class="card small">Android 手機可以下載 App：<a href="https://github.com/nkuo-git/trade-simulator/releases/latest/download/trade-simulator.apk">下載 trade-simulator.apk</a>（第一次安裝要允許「安裝不明來源的應用程式」）。<br>iPhone：用 Safari 打開這個網頁 → 分享 → 加入主畫面。</div>`}
    <h3>關於資料</h3>
    <div class="card small muted">歷史資料：Yahoo Finance 每週收盤價（含股利還原）。即時資料：台灣證交所與 Yahoo Finance，盤中每 15 分鐘更新，約延遲 15–20 分鐘。僅供教育用途。</div>
  </main>`;
}
function membersHtml() {
  const members = Object.entries(R.family?.members || {}).filter(([, m]) => !m.removed);
  const rows = members.map(([k, m]) => `<div class="member"><span>${m.role === 'parent' ? '👨‍👩‍👧' : '🧒'}</span><span class="em">${esc(m.email)}</span>
    ${k === emailKey(S.email || '') ? '<small class="muted">（你）</small>' : `<button class="btn xs ghost" data-act="remove-member" data-key="${esc(k)}">移除</button>`}</div>`).join('');
  return `<h3>家人</h3>
    <div class="card">
      ${rows || '<p class="small muted">還沒有家人。</p>'}
      <p class="lbl">加入家人的 Email</p>
      <input type="email" id="m-email" placeholder="孩子或另一位家長的 Email" autocomplete="off">
      <div class="seg" id="m-role"><button class="on" data-role="kid">🧒 小孩</button><button data-role="parent">👨‍👩‍👧 家長</button></div>
      <button class="btn sm full" data-act="add-member">加入</button>
      <p class="small muted">加入後，他用這個 Email 登入（不用密碼）就會自動進到這個家庭。家長第一次在新手機登入時要輸入家長密碼。<br>也可以給孩子家庭代碼 <b>${esc(S.fam.id)}</b>，讓他自己加入。</p>
    </div>`;
}
async function askPin(set) {
  const v = await new Promise((resolve) => {
    modal(`<h2>${set ? '設定家長密碼' : '輸入家長密碼'}</h2><input type="password" id="pin" inputmode="numeric" maxlength="8" placeholder="4 位數以上" autofocus><div id="pin-err" class="err"></div><button class="btn big full" id="pin-go">確定</button>`, {
      onMount: (m) => {
        const go = () => { const x = $('#pin', m).value.trim(); if (x.length < 4) { $('#pin-err', m).textContent = '至少 4 位數'; return; } closeModal(); resolve(x); };
        $('#pin-go', m).addEventListener('click', go);
        $('#pin', m).addEventListener('keydown', (e) => e.key === 'Enter' && go());
        setTimeout(() => $('#pin', m).focus(), 50);
      },
    });
  });
  return v;
}
async function hashPin(x) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('kidtrader:' + x));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

const findProfile = (id) => allProfiles().find((x) => x.id === id);
// 寫入家庭設定，並先更新本機副本（雲端的回傳稍後會再覆蓋）
async function famSet(patch) {
  try { await sync.setFamily(S.fam.id, patch); } catch (e) { toast('⚠️ 連不上雲端，請稍後再試'); throw e; }
  const { controls, ...rest } = patch;
  R.family = { ...R.family, ...rest };
  if (controls) {
    R.family.controls = { ...(R.family.controls || {}) };
    for (const [k, v] of Object.entries(controls)) R.family.controls[k] = { ...(R.family.controls[k] || {}), ...v };
  }
}
const famCtl = (pid, patch) => famSet({ controls: { [pid]: patch } });
function askText(title, placeholder) {
  return new Promise((resolve) => {
    modal(`<h2>${esc(title)}</h2><input id="tx" maxlength="12" autocapitalize="characters" autocomplete="off" placeholder="${esc(placeholder)}"><button class="btn big full" id="tx-go">確定</button>`, {
      onMount: (m) => {
        const done = () => { const v = normCode($('#tx', m).value); if (!v) return; closeModal(); resolve(v); };
        $('#tx-go', m).addEventListener('click', done);
        $('#tx', m).addEventListener('keydown', (e) => e.key === 'Enter' && done());
        m.parentElement.addEventListener('click', (e) => { if (e.target === m.parentElement || e.target.closest('[data-close]')) resolve(null); });
        setTimeout(() => $('#tx', m).focus(), 50);
      },
    });
  });
}

// ---------- 畫面：用 Email 登入 ----------
function viewSetup() {
  return `
  <div class="home">
    <h1 class="logo"><img src="icon.svg" alt=""> 小小操盤手</h1>
    <p class="sub">用虛擬的錢，學真正的投資</p>
    <div class="card login">
      <label class="lbl" for="login-email">用 Email 登入</label>
      <input type="email" id="login-email" placeholder="你的 Email" autocomplete="email" inputmode="email" value="${esc(UI.lastEmail || '')}">
      <button class="btn big full" data-act="login">登入</button>
      <p class="small muted">不用密碼。同一個 Email 在任何手機登入，進度都會自動帶回來。</p>
    </div>
    <button class="link" data-act="setup-solo">先不登入，只在這台手機玩</button>
  </div>`;
}

// ---------- 事件處理 ----------
const actions = {
  async 'add-profile'() {
    let avatar = AVATARS[S.profiles.length % AVATARS.length];
    modal(`<h2>新增玩家</h2><input id="np-name" maxlength="12" placeholder="名字或暱稱"><p class="lbl">選一個頭像</p><div class="avas">${AVATARS.map((a) => `<button class="${a === avatar ? 'on' : ''}" data-a="${a}">${a}</button>`).join('')}</div><button class="btn big full" id="np-go">開始！</button>`, {
      onMount: (m) => {
        m.querySelectorAll('[data-a]').forEach((b) => b.addEventListener('click', () => { avatar = b.dataset.a; m.querySelectorAll('[data-a]').forEach((x) => x.classList.toggle('on', x === b)); }));
        $('#np-go', m).addEventListener('click', () => {
          const name = $('#np-name', m).value.trim(); if (!name) return;
          const p = newProfile(name, avatar); S.profiles.push(p); S.cur = p.id; save(); closeModal(); go('main', { tab: 'learn' });
        });
      },
    });
  },
  pick(el) { S.cur = el.dataset.id; save(); go('main', { tab: 'play' }); },
  home() { UI.parentOk = false; go('home'); },
  tab(el) { UI.tab = el.dataset.tab; render(); window.scrollTo(0, 0); },
  filter(el) { UI.filter = el.dataset.f; render(); },
  lesson(el) { lessonModal(+el.dataset.id); },
  'locked-lesson'() { toast('🔒 還沒解鎖：先完成前一課，並完成足夠的挑戰'); },
  locked(el) { toast(`🔒 完成第 ${el.dataset.lesson} 課就能解鎖`); },
  'locked-etf'() { toast('🔒 完成第 2 課「不要把雞蛋放在同一個籃子」就能買 ETF'); },
  async 'new-game'(el) {
    const p = prof(), sc = scById(el.dataset.id);
    if (!timeline(sc).length) { toast('這個時期的資料還沒準備好'); return; }
    const ok = await waitModal(`<h2>${sc.emoji} ${sc.title}</h2><p>${esc(sc.intro)}</p><p>你有 <b>${ntd(startCash())}</b> 虛擬現金，可以買台股和美股。每按一次「下一週」，時間就往前走一週。</p><p class="muted small">對手：每個月固定拿一樣多的錢買 ${benchSeries(sc, startCash()).name}（定期定額）。</p><button class="btn big full" data-resolve="go">出發！🚀</button>`);
    if (ok !== 'go') return;
    const g = startGame(p, sc);
    go('game', { gameId: g.id });
  },
  'open-game'(el) { go('game', { gameId: el.dataset.id }); },
  back() { go('main'); },
  async step(el) { if (stepping) return; stepping = true; try { await doSteps(+el.dataset.n); } finally { stepping = false; } },
  auto() { toggleAuto(); },
  async 'end-game'() {
    const ok = await waitModal('<h2>提早結束挑戰？</h2><p>提早結束不會登上排行榜，也拿不到完成獎勵。</p><div class="row"><button class="btn danger" data-resolve="yes">結束</button><button class="btn ghost" data-resolve="no">繼續玩</button></div>');
    if (ok !== 'yes') return;
    const p = prof(), g = curGame();
    finishGame(p, g); render(); await showSummary(p, g);
  },
  async summary() { const p = prof(), g = curGame(); await showSummary(p, g); },
  trade(el, e) { if (e.target.closest('[data-act="stop"]')) return; tradeModal(el.dataset.id, UI.view === 'game' ? 'game' : 'live'); },
  stop(el) { stopModal(el.dataset.id, UI.view === 'game' ? 'game' : 'live'); },
  review(el) { reviewModal(el.dataset.tid); },
  'live-start'() {
    const p = prof();
    p.live = { acc: newAccount(startCash()), snaps: [], bench0: D.live?.quotes['0050']?.p || null, created: today() };
    save(); render();
  },
  async parent() {
    if (S.fam?.role === 'parent') { UI.parentOk = true; go('parent'); return; }
    const hash = S.fam ? R.family?.pinHash : S.pin;
    if (S.fam && !hash) { toast('還沒連上雲端，請稍後再試'); return; }
    if (hash) {
      const x = await askPin(false); if (!x) return;
      if ((await hashPin(x)) !== hash) { toast('密碼錯誤'); return; }
    }
    UI.parentOk = true; go('parent');
  },
  async 'p-pin'() {
    const x = await askPin(true); if (!x) return;
    const h = await hashPin(x);
    if (S.fam) await famSet({ pinHash: h }); else { S.pin = h; save(); }
    toast('已設定家長密碼');
  },
  async 'p-cash'() {
    const v = Math.round(+$('#p-cash').value);
    if (v < 1000) return;
    if (S.fam) await famSet({ startCash: v }); else { S.startCash = v; save(); }
    toast('已儲存（新的挑戰和即時帳戶生效）');
  },
  async 'p-unlock'(el) {
    const p = findProfile(el.dataset.id);
    if (S.fam) await famCtl(p.id, { unlockAll: !unlocked(p) }); else { p.unlockAll = !p.unlockAll; save(); }
    render();
  },
  async 'p-reset-live'(el) {
    const p = findProfile(el.dataset.id);
    if ((await waitModal(`<h2>重設 ${esc(p.name)} 的即時帳戶？</h2><p>持股和交易紀錄會清除。</p><div class="row"><button class="btn danger" data-resolve="y">重設</button><button class="btn ghost" data-resolve="n">取消</button></div>`)) !== 'y') return;
    if (S.fam) await famCtl(p.id, { resetLiveAt: Date.now() }); else { p.live = null; save(); }
    render();
  },
  async 'p-rename'(el) {
    const p = findProfile(el.dataset.id);
    modal(`<h2>改名</h2><input id="rn" maxlength="12" value="${esc(p.name)}"><button class="btn big full" id="rn-go">儲存</button>`, {
      onMount: (m) => $('#rn-go', m).addEventListener('click', async () => {
        const n = $('#rn', m).value.trim().slice(0, 12); if (!n) return;
        if (S.fam) await famCtl(p.id, { name: n }); else { p.name = n; save(); }
        closeModal(); render();
      }),
    });
  },
  async 'p-delete'(el) {
    const p = findProfile(el.dataset.id);
    if ((await waitModal(`<h2>刪除 ${esc(p.name)}？</h2><p>所有進度都會消失，無法復原。</p><div class="row"><button class="btn danger" data-resolve="y">刪除</button><button class="btn ghost" data-resolve="n">取消</button></div>`)) !== 'y') return;
    if (S.fam) {
      await famCtl(p.id, { removed: true });
      try { await sync.removeProfile(S.fam.id, p.id); } catch (e) { /* 下次再試 */ }
      delete R.remote[p.id];
    }
    S.profiles = S.profiles.filter((x) => x !== p);
    if (S.cur === p.id) S.cur = null;
    save(); render();
  },
  'to-login'() { UI.parentOk = false; go('setup'); },
  'setup-solo'() { S.solo = true; if (!S.email) S.fam = null; save(); go('home'); },
  async login() {
    const email = ($('#login-email')?.value || '').trim().toLowerCase();
    UI.lastEmail = email;
    if (!validEmail(email)) { toast('請輸入正確的 Email'); return; }
    const key = emailKey(email);
    try {
      const u = await sync.getUser(key);
      if (u?.family) {
        const f = await sync.getFamily(u.family);
        if (!f) { toast('找不到你的家庭，請問問家長'); return; }
        if (u.role === 'parent') {
          // 換新手機時要輸入家長密碼，避免小孩用家長的 Email 改設定
          if (!(S.email === email && S.fam?.id === u.family)) {
            const pin = await askPin(false); if (!pin) return;
            if ((await hashPin(pin)) !== f.pinHash) { toast('家長密碼錯誤'); return; }
          }
          await enterFamily(email, u.family, 'parent', u.profiles || []);
          UI.parentOk = true; go('parent');
        } else {
          await enterFamily(email, u.family, 'kid', u.profiles || []);
          go('home');
          if (!S.profiles.length) actions['add-profile']();
          else if (S.profiles.length === 1) go('main', { tab: 'play' });
        }
        toast(`👋 歡迎回來`);
        return;
      }
      const who = await waitModal(`<h2>第一次來！你是？</h2>
        <div class="profiles"><button class="profile-card" data-resolve="parent"><span class="ava">👨‍👩‍👧</span><b>家長</b><small>建立一個新家庭</small></button>
        <button class="profile-card" data-resolve="kid"><span class="ava">🧒</span><b>小孩</b><small>輸入家長給的家庭代碼</small></button></div>
        <p class="small muted">小孩：如果家長已經在家長專區加入你的 Email，就不會看到這個畫面，會直接登入。</p>`);
      if (who === 'parent') {
        const pin = await askPin(true); if (!pin) return;
        let code = newCode();
        while (await sync.getFamily(code)) code = newCode();
        await sync.setFamily(code, { created: Date.now(), pinHash: await hashPin(pin), startCash: S.startCash, controls: {}, members: { [key]: { role: 'parent', email } } });
        await sync.setUser(key, { email, role: 'parent', family: code, profiles: [] });
        await enterFamily(email, code, 'parent', []);
        UI.parentOk = true; go('parent');
        await waitModal(`<h2>🎉 家庭建立好了</h2><p>下一步：在家長專區的「家人」加入孩子的 Email。孩子在自己的手機用那個 Email 登入，就會自動加入。</p><p class="small muted">或是請孩子選「小孩」，輸入家庭代碼：</p><div class="famcode big"><b>${code}</b></div><button class="btn big full" data-resolve="ok">好</button>`);
      } else if (who === 'kid') {
        const code = await askText('輸入家庭代碼', '家長手機上的 6 個字'); if (!code) return;
        const f = await sync.getFamily(code);
        if (!f) { toast('找不到這個家庭代碼，請再確認一次'); return; }
        await sync.setUser(key, { email, role: 'kid', family: code, profiles: [] });
        await sync.setFamily(code, { members: { [key]: { role: 'kid', email } } });
        await enterFamily(email, code, 'kid', []);
        go('home');
        if (!S.profiles.length) actions['add-profile']();
      }
    } catch (e) { console.warn(e); toast('⚠️ 連不上雲端，請確認網路後再試'); }
  },
  async logout() {
    if ((await waitModal('<h2>登出？</h2><p>這台手機上的進度會清掉。下次用同一個 Email 登入，進度就會回來。</p><div class="row"><button class="btn danger" data-resolve="y">登出</button><button class="btn ghost" data-resolve="n">取消</button></div>')) !== 'y') return;
    clearTimeout(pushTimer);
    try {
      for (const p of S.profiles) await sync.pushProfile(S.fam.id, p);
    } catch (e) { toast('⚠️ 現在連不上雲端，請連上網路再登出，免得進度不見'); return; }
    R.unsub.forEach((f) => f());
    Object.assign(R, { family: null, remote: {}, unsub: [], online: false, linked: null });
    S = defaultState(); save();
    UI.parentOk = false; go('setup');
  },
  async 'add-member'() {
    const email = ($('#m-email')?.value || '').trim().toLowerCase();
    if (!validEmail(email)) { toast('請輸入正確的 Email'); return; }
    const role = $('#m-role .on')?.dataset.role || 'kid';
    const key = emailKey(email);
    try {
      const u = await sync.getUser(key);
      if (u?.family && u.family !== S.fam.id) { toast('這個 Email 已經在別的家庭了'); return; }
      await sync.setUser(key, { email, role, family: S.fam.id, ...(u ? {} : { profiles: [] }) });
      await famSet({ members: { [key]: { role, email, removed: false } } });
      toast(`✅ 已加入 ${email}`);
      render();
    } catch (e) { console.warn(e); }
  },
  async 'remove-member'(el) {
    const key = el.dataset.key, m = R.family?.members?.[key];
    if (!m || (await waitModal(`<h2>移除 ${esc(m.email)}？</h2><p>他之後用這個 Email 登入，就不會再進到這個家庭。已經玩的進度會留在家長專區，可以另外刪除。</p><div class="row"><button class="btn danger" data-resolve="y">移除</button><button class="btn ghost" data-resolve="n">取消</button></div>`)) !== 'y') return;
    try {
      await sync.setUser(key, { family: null });
      await famSet({ members: { [key]: { removed: true } } });
      render();
    } catch (e) { console.warn(e); }
  },
  'p-export'() {
    const name = `小小操盤手備份-${today()}.json`;
    if (window.AndroidApp?.saveFile) { window.AndroidApp.saveFile(name, JSON.stringify(S)); return; }
    const blob = new Blob([JSON.stringify(S)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.closest('.modal')) return;
  const fn = actions[el.dataset.act];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('input', (e) => { if (e.target.closest('.calc')) updateCalc(); });
document.addEventListener('click', (e) => {
  const b = e.target.closest('#m-role [data-role]');
  if (b) b.parentElement.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
});
document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.id === 'login-email') actions.login(); });
document.addEventListener('change', async (e) => {
  if (e.target.id !== 'p-import') return;
  const f = e.target.files[0]; if (!f) return;
  try {
    const s = JSON.parse(await f.text());
    if (s.v !== 1 || !Array.isArray(s.profiles)) throw new Error('bad');
    if ((await waitModal('<h2>匯入進度？</h2><p>這台裝置目前的進度會被取代。</p><div class="row"><button class="btn danger" data-resolve="y">匯入</button><button class="btn ghost" data-resolve="n">取消</button></div>')) !== 'y') return;
    s.fam = S.fam; s.email = S.email; s.solo = S.solo; S = s; save(); applyControls(); toast('✅ 匯入完成'); render();
  } catch (err) { toast('檔案格式不對'); }
});

// ---------- 主畫面 ----------
function render() {
  if (!['home', 'parent', 'setup'].includes(UI.view) && !prof()) UI.view = 'home';
  const html = { home: viewHome, main: viewMain, game: viewGame, parent: viewParent, setup: viewSetup }[UI.view]();
  app().innerHTML = html;
  app().className = 'view-' + UI.view;
  if ($('#c-out')) updateCalc();
}

// Android App 的返回鍵：有東西可以退就回 true
window.appBack = () => {
  if (document.querySelector('.modal-bg')) { closeModal(); return true; }
  if (UI.view === 'parent' && S.fam?.role === 'parent' && S.email) return false;
  if (UI.view === 'game' || UI.view === 'parent') { UI.view === 'parent' ? actions.home() : go('main'); return true; }
  if (UI.view === 'home' && S.fam?.role === 'parent') { UI.parentOk = true; go('parent'); return true; }
  if (UI.view === 'main' && UI.tab !== 'play') { UI.tab = 'play'; render(); return true; }
  return false;
};

// 「加到主畫面」按鈕（Chrome 支援時才出現）
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installPrompt = e; if (UI.view === 'home') render(); });
actions.install = async () => { if (!installPrompt) return; installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); };

let liveTimer = null;
async function init() {
  try {
    await loadMeta();
    await Promise.all([loadHistory(), loadLive()]);
  } catch (e) {
    app().innerHTML = '<div class="card warn">載入資料失敗，請重新整理頁面。</div>';
    return;
  }
  if (sync.syncAvailable() && !S.email && !S.solo) UI.view = 'setup';
  else if (S.email && S.fam?.role === 'parent') { UI.parentOk = true; UI.view = 'parent'; }
  else if (prof()) UI.view = 'main';
  render();
  if (S.email && S.fam) connectFamily();
  liveTimer = setInterval(async () => {
    await loadLive();
    if (UI.view === 'main' && UI.tab === 'live' && !document.querySelector('.modal-bg')) render();
  }, 5 * 60 * 1000);
}
init();
if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
