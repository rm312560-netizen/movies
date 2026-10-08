// 電影指南手機版：從轉接站下載電腦版整理好的資料包（推薦、時刻表、影城、票價、票房、影評），存在手機裡離線也能看
const APP_VERSION = '1.0.0';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let toastT;
function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => { t.hidden = true; }, 2600); }
const WEEK = '日一二三四五六';
const ymd = (d = new Date()) => d.toLocaleDateString('sv-SE');
const addDays = (s, n) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const fmtDate = s => { const d = new Date(`${s}T00:00:00`); return `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）`; };
const dayLabel = s => s === ymd() ? '今天' : s === addDays(ymd(), 1) ? '明天' : fmtDate(s);
const nowHM = () => new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const isPast = (date, t) => date === ymd() && t >= '05:00' && t < nowHM();   // 凌晨場（00:00～04:59）算前一天的晚場
const endTime = (t, mins) => { const [h, m] = t.split(':').map(Number); const x = h * 60 + m + mins + 15; return `${String(Math.floor(x / 60) % 24).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; };
const mapUrl = t => `https://maps.apple.com/?q=${encodeURIComponent(t.n)}&address=${encodeURIComponent(t.addr || '')}`;

// ---------- 設定（localStorage）與資料包（IndexedDB） ----------
const S = (() => { try { return JSON.parse(localStorage.getItem('mg') || '{}'); } catch { return {}; } })();
const saveS = () => { try { localStorage.setItem('mg', JSON.stringify(S)); } catch {} };
S.favs ||= []; S.pending ||= {};
function idb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('movieguide', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function idbGet(k) { const d = await idb(); return new Promise((res, rej) => { const q = d.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result ?? null); q.onerror = () => rej(q.error); }); }
async function idbPut(k, v) { const d = await idb(); return new Promise((res, rej) => { const tx = d.transaction('kv', 'readwrite'); tx.objectStore('kv').put(v, k); tx.oncomplete = res; tx.onerror = () => rej(tx.error); }); }

let D = null;            // 資料包
async function api(method, p, body) {
  const r = await fetch(S.apiBase + p, { method, headers: { Authorization: `Bearer ${S.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401) { S.token = ''; saveS(); $('setup').hidden = false; throw new Error('通行碼失效，請重新配對'); }
  if (!r.ok) throw new Error(j.error || `轉接站回應 ${r.status}`);
  return j;
}
// 先看 meta（很小），資料有更新才下載整包
let syncing = false;
async function sync(force = false) {
  if (!S.token || syncing) return;
  syncing = true;
  try {
    const meta = await api('GET', '/movie/meta');
    if (!meta.updatedAt) { if (!D) showEmpty('電腦版還沒有上傳資料。請確認電腦版「電影指南」有開著。'); return; }
    if (force || !D || meta.updatedAt !== D.generatedAt) {
      const snap = await api('GET', '/movie');
      D = snap;
      await idbPut('snap', snap).catch(() => {});
      for (const id of Object.keys(S.pending)) if (D.reviews[id]) delete S.pending[id];
      saveS();
      render();
      if (!$('sheet').hidden && cur) openMovie(cur, true);
    }
    $('offline').hidden = true;
  } catch (e) {
    if (D) { $('offline').hidden = false; $('offline').textContent = `目前顯示 ${D.generatedAt.slice(5, 16)} 的資料（${e.message}）`; }
    else showEmpty(`無法下載資料：${e.message}`);
  } finally { syncing = false; }
}
function showEmpty(msg) { document.querySelectorAll('.view').forEach(v => { if (!v.hidden) v.innerHTML = `<div class="empty">${esc(msg)}</div>`; }); }

// ---------- 配對 ----------
$('suGo').addEventListener('click', async () => {
  const url = $('suUrl').value.trim().replace(/\/+$/, ''), code = $('suCode').value.trim().toUpperCase();
  if (!/^https:\/\//.test(url)) return void ($('suMsg').textContent = '轉接站網址要以 https:// 開頭');
  if (!/^[A-Z0-9]{8}$/.test(code)) return void ($('suMsg').textContent = '配對碼是 8 碼英數字');
  $('suMsg').textContent = '連結中…';
  try {
    const r = await fetch(`${url}/pair/claim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code }) });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `回應 ${r.status}`);
    S.apiBase = url; S.token = j.token; saveS();
    $('setup').hidden = true; $('suCode').value = ''; $('suMsg').textContent = '';
    toast('已連結電腦版');
    sync(true);
  } catch (e) { $('suMsg').textContent = `連結失敗：${e.message}`; }
});

// ---------- 共用 ----------
const POSTER_FALLBACK = 'data:image/svg+xml;utf8,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2 3"><rect width="2" height="3" fill="#22262f"/></svg>');
// 清單用小張海報（TMDB 有多種尺寸），介紹頁用大張
const thumb = src => String(src || '').replace('/t/p/w500/', '/t/p/w185/');
const img = (src, cls = '') => `<img ${cls ? `class="${cls}"` : ''} src="${esc(src || POSTER_FALLBACK)}" loading="lazy" referrerpolicy="no-referrer" onerror="this.onerror=null;this.src='${POSTER_FALLBACK}'" alt="">`;
const M = id => D?.movies[id] || null;
const theaterMap = () => Object.fromEntries((D?.theaters || []).map(t => [t.id, t]));
const inArea = t => !S.area || t.a === S.area;
function badges(r = {}, rv) {
  const o = [];
  if (r.imdb != null) o.push(`<span class="b imdb">IMDb ${r.imdb}</span>`);
  if (r.rt != null) o.push(`<span class="b rt">🍅 ${r.rt}%</span>`);
  if (r.mc != null) o.push(`<span class="b mc">MC ${r.mc}</span>`);
  if (r.imdb == null && r.tmdb != null) o.push(`<span class="b tmdb">TMDB ${r.tmdb}</span>`);
  if (rv?.s?.avg != null) o.push(`<span class="b yt">影評 ${rv.s.avg}</span>`);
  return o.length ? `<div class="badges">${o.join('')}</div>` : '';
}
document.addEventListener('click', e => {
  const c = e.target.closest('[data-movie]');
  if (c && !e.target.closest('a, button:not([data-movie])')) openMovie(c.dataset.movie);
});

// ---------- 地區與分頁 ----------
function renderAreaSeg() {
  const opts = [['', '全部'], ...(D?.areas || []).map(a => [a.id, a.name])];
  if (S.area && !opts.find(o => o[0] === S.area)) S.area = '';
  $('areaSeg').innerHTML = opts.map(([id, n]) => `<button data-a="${id}" aria-pressed="${id === (S.area || '')}">${esc(n)}</button>`).join('');
}
$('areaSeg').addEventListener('click', e => { const b = e.target.closest('[data-a]'); if (!b) return; S.area = b.dataset.a; saveS(); render(); });
let tab = S.tab || 'rec';
function go(t) {
  tab = t; S.tab = t; saveS();
  document.querySelectorAll('.tabbar button').forEach(b => b.toggleAttribute('aria-current', b.dataset.tab === t));
  document.querySelectorAll('.view').forEach(v => { v.hidden = v.id !== `v-${t}`; });
  render(); window.scrollTo(0, 0);
}
document.querySelectorAll('.tabbar button').forEach(b => b.addEventListener('click', () => go(b.dataset.tab)));
function render() {
  if (!D) return;
  renderAreaSeg();
  ({ rec: renderRec, times: renderTimes, theaters: renderTheaters, box: renderBox, more: renderMore })[tab]();
}

// ---------- 推薦 ----------
function renderRec() {
  const list = (D.rec[S.area || ''] || []).filter(r => M(r[0]));
  if (!list.length) { $('v-rec').innerHTML = '<div class="empty">這個地區目前沒有推薦資料</div>'; return; }
  const [topId, , topShows, topTh, topTags] = list[0], top = M(topId);
  $('v-rec').innerHTML = `
    <div class="hero" data-movie="${esc(topId)}" style="background-image:url('${esc(top.bd || top.p)}')"><div class="in">${img(top.p)}
      <div><div class="kicker">本週最推薦</div><h3>${esc(top.t)}</h3><div class="muted small">${esc(top.en || '')}</div>
        ${badges(top.r, D.reviews[topId])}<div class="tags">${topTags.slice(0, 3).map(t => `<span class="tag hot">${esc(t)}</span>`).join('')}</div>
        <div class="muted small" style="margin-top:4px">3 天內 ${topShows} 場・${topTh} 間影城</div></div></div></div>
    <h2>推薦排行 <span class="muted small">口碑＋熱度</span></h2>
    <div class="rows">${list.map(([id, score, shows, , tags], i) => {
      const m = M(id);
      return `<div class="row" data-movie="${esc(id)}">${img(thumb(m.p), 'p')}<span class="rank">${i + 1}</span><span class="score">${score}</span>
        <div><div class="t">${esc(m.t)}</div><div class="meta">${[m.rt && `${m.rt} 分`, m.cert, (m.g || []).slice(0, 2).join('／'), `${shows} 場`].filter(Boolean).map(esc).join('・')}</div>
          ${badges(m.r, D.reviews[id])}<div class="tags">${tags.slice(0, 2).map(t => `<span class="tag ${/票房|新片/.test(t) ? 'hot' : ''}">${esc(t)}</span>`).join('')}</div></div></div>`;
    }).join('')}</div>
    <p class="muted small">資料更新於 ${esc(D.generatedAt.slice(5, 16))}</p>`;
}

// ---------- 時刻表 ----------
let tDate = null, tFrom = null, tMovie = '';
function showDates() { return Object.keys(D.shows).filter(d => d >= ymd()).sort(); }
function renderTimes() {
  const dates = showDates();
  if (!dates.length) { $('tList').innerHTML = '<div class="empty">沒有時刻表資料（資料可能太舊，請打開電腦版更新）</div>'; $('tDates').innerHTML = ''; return; }
  if (!tDate || !dates.includes(tDate)) { tDate = dates[0]; tFrom = null; }
  if (tFrom == null) tFrom = tDate === ymd() ? nowHM() : '';
  $('tDates').innerHTML = dates.map(d => `<button class="chip" data-d="${d}" aria-pressed="${d === tDate}">${dayLabel(d)}</button>`).join('');
  $('tFrom').value = tFrom; $('tNow').hidden = tDate !== ymd();
  const th = theaterMap(), items = [];
  for (const [tid, mid, ver, ...times] of D.shows[tDate]) {
    if (!th[tid] || !inArea(th[tid])) continue;
    for (const t of times) {
      const key = t < '05:00' ? `2${t}` : `1${t}`;
      if (tFrom && key < `1${tFrom}`) continue;
      items.push({ t, key, tid, mid, ver });
    }
  }
  items.sort((a, b) => a.key.localeCompare(b.key));
  const movies = [...new Set(items.map(i => i.mid))].map(id => [id, M(id)?.t || id]).sort((a, b) => a[1].localeCompare(b[1]));
  if (tMovie && !movies.find(m => m[0] === tMovie)) tMovie = '';
  $('tMovie').innerHTML = `<option value="">全部電影（${movies.length}）</option>${movies.map(([id, t]) => `<option value="${id}" ${id === tMovie ? 'selected' : ''}>${esc(t)}</option>`).join('')}`;
  let lastH = '';
  const shown = items.filter(i => !tMovie || i.mid === tMovie).slice(0, 300);
  $('tList').innerHTML = shown.map(i => {
    const m = M(i.mid) || {}, h = i.t.slice(0, 2);
    const head = h !== lastH ? `<div class="hourh">${h < '05' ? '凌晨 ' : ''}${h}:00</div>` : '';
    lastH = h;
    return `${head}<div class="slot" data-movie="${esc(i.mid)}"><span class="tm">${i.t}</span>${img(thumb(m.p))}
      <div><div class="tt">${esc(m.t || i.mid)}${i.ver ? `<span class="ver">${esc(i.ver)}</span>` : ''}</div>
        <div class="muted small">${esc(th[i.tid].n)}${m.rt ? `・${endTime(i.t, m.rt)} 散場` : ''}</div></div></div>`;
  }).join('') || '<div class="empty">這個時間之後沒有場次了</div>';
}
$('tDates').addEventListener('click', e => { const b = e.target.closest('[data-d]'); if (b) { tDate = b.dataset.d; tFrom = tDate === ymd() ? nowHM() : ''; renderTimes(); } });
$('tFrom').addEventListener('change', e => { tFrom = e.target.value; renderTimes(); });
$('tNow').addEventListener('click', () => { tFrom = nowHM(); renderTimes(); });
$('tMovie').addEventListener('change', e => { tMovie = e.target.value; renderTimes(); });

// ---------- 影城 ----------
let thOpen = null, thDate = null;
function priceHtml(p, at) {
  if (!p) return '';
  const rows = [['全票', p.regular], ['優待／學生', p.concession], ['早場', p.early], ['特殊廳', p.imax], ['其他廳', p.premium]].filter(r => r[1] != null && r[1] !== '');
  return `<details class="price"><summary>票價：全票 <b>${p.regular ?? '—'}</b>${p.concession ? `・優待 <b>${p.concession}</b>` : ''}${p.early ? `・早場 <b>${p.early}</b>` : ''}</summary>
    <div class="pg" style="margin-top:6px">${rows.map(([k, v]) => `<span class="muted">${k}</span><span>${typeof v === 'number' ? `${v} 元` : esc(v)}</span>`).join('')}</div>
    ${p.notes ? `<div class="muted" style="margin-top:4px">${esc(p.notes)}</div>` : ''}<div class="muted small">AI 查詢・參考用，以影城公告為準・${esc(String(at || '').slice(0, 10))}</div></details>`;
}
function renderTheaters() {
  const ths = D.theaters.filter(inArea);
  const today = ymd(), counts = {};
  for (const [tid, mid] of D.shows[today] || []) (counts[tid] ||= new Set()).add(mid);
  $('thList').innerHTML = ths.map(t => `<div class="th">
    <h3><span>${esc(t.n)}</span><span class="muted small">${esc(D.areas.find(a => a.id === t.a)?.name || '')}</span></h3>
    <div class="small muted">${esc(t.addr || '')}</div>
    <div class="links"><a href="${mapUrl(t)}" target="_blank" rel="noopener">📍 地圖</a>${t.tel ? `<a href="tel:${esc(t.tel.replace(/[^\d]/g, ''))}">☎ 電話</a>` : ''}${t.book ? `<a href="${esc(t.book)}" target="_blank" rel="noopener">訂票</a>` : ''}${t.web ? `<a href="${esc(t.web)}" target="_blank" rel="noopener">官網</a>` : ''}
      <a href="#" data-th="${t.id}">今天 ${counts[t.id]?.size || 0} 部片 ${thOpen === t.id ? '▴' : '▾'}</a></div>
    ${priceHtml(t.price, t.pat)}
    ${thOpen === t.id ? theaterDay(t.id) : ''}</div>`).join('') || '<div class="empty">沒有影城資料</div>';
}
function theaterDay(tid) {
  const dates = showDates().filter(d => (D.shows[d] || []).some(s => s[0] === tid));
  if (!thDate || !dates.includes(thDate)) thDate = dates[0];
  if (!thDate) return '<div class="muted small">沒有場次資料</div>';
  const films = (D.shows[thDate] || []).filter(s => s[0] === tid).map(([, mid, ver, ...times]) => ({ mid, ver, times, m: M(mid) || {} }))
    .sort((a, b) => (a.m.t || '').localeCompare(b.m.t || ''));
  return `<div class="thday"><div class="chips scroll">${dates.map(d => `<button class="chip" data-thd="${d}" aria-pressed="${d === thDate}">${dayLabel(d)}</button>`).join('')}</div>
    ${films.map(f => `<div class="film" data-movie="${esc(f.mid)}"><div class="name">${esc(f.m.t || f.mid)}${f.ver ? `<span class="ver">${esc(f.ver)}</span>` : ''}<span class="muted small">　${f.m.rt ? `${f.m.rt} 分` : ''}</span></div>
      <div class="times">${f.times.map(t => `<span class="time ${isPast(thDate, t) ? 'past' : ''}">${t}</span>`).join('')}</div></div>`).join('')}</div>`;
}
$('thList').addEventListener('click', e => {
  const a = e.target.closest('[data-th]');
  if (a) { e.preventDefault(); thOpen = thOpen === a.dataset.th ? null : a.dataset.th; thDate = null; renderTheaters(); return; }
  const d = e.target.closest('[data-thd]');
  if (d) { e.stopPropagation(); thDate = d.dataset.thd; renderTheaters(); }
});

// ---------- 票房 ----------
let boKind = 'tw';
function money(v, kind) {
  if (v == null) return '';
  if (kind === 'tw') return v >= 10000 ? `${(v / 10000).toFixed(2)} 億` : `${v.toLocaleString()} 萬`;
  const twd = v * (D.fx || 31.8);
  return `${v.toLocaleString()} 萬美元<div class="muted small">≈ ${twd >= 10000 ? `${(twd / 10000).toFixed(1)} 億` : `${Math.round(twd).toLocaleString()} 萬`}台幣</div>`;
}
function renderBox() {
  const b = D.box[boKind];
  $('boPeriod').textContent = b ? `統計期間 ${b.period || ''}・依週末票房排序` : '';
  $('boList').innerHTML = b ? b.rows.map(([rank, id, title, share, wk, total, last]) => {
    const m = id ? M(id) : null;
    const mv = last == null ? '<span class="up small">新</span>' : last > rank ? `<span class="up small">▲${last - rank}</span>` : last < rank ? `<span class="down small">▼${rank - last}</span>` : '';
    return `<div class="bo" ${m ? `data-movie="${esc(id)}"` : ''}><div class="rk">${rank}<div>${mv}</div></div>${img(thumb(m?.p))}
      <div><div class="tt">${esc(m?.t || title)}</div><div class="muted small">${esc(share || '')}　累計 ${money(total, boKind).replace(/<div[^>]*>.*<\/div>/, '')}</div></div>
      <div class="money">${money(wk, boKind)}</div></div>`;
  }).join('') : '<div class="empty">還沒有票房資料</div>';
}
$('boKind').addEventListener('click', e => { const b = e.target.closest('[data-k]'); if (!b) return; boKind = b.dataset.k; document.querySelectorAll('#boKind button').forEach(x => x.setAttribute('aria-pressed', String(x === b))); renderBox(); });

// ---------- 更多：上映中、即將上映、收藏、設定 ----------
let more = 'now';
const card = id => { const m = M(id); return m ? `<div class="card" data-movie="${esc(id)}">${img(thumb(m.p))}<div class="body"><div class="t">${esc(m.t)}</div><div class="meta">${m.r?.imdb != null ? `IMDb ${m.r.imdb}` : esc(m.rel ? m.rel.slice(5).replace('-', '/') : '')}</div></div></div>` : ''; };
function renderMore() {
  document.querySelectorAll('#moreSeg button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.m === more)));
  const el = $('moreBody');
  if (more === 'now') {
    const th = theaterMap(), local = new Set();
    for (const d of showDates().slice(0, 3)) for (const [tid, mid] of D.shows[d]) if (th[tid] && inArea(th[tid])) local.add(mid);
    const ids = D.now.filter(id => local.has(id) && M(id));
    el.innerHTML = `<p class="muted small">你的地區近 3 天有場次的電影（${ids.length} 部），依上映日排列</p><div class="grid">${ids.map(card).join('')}</div>`;
  } else if (more === 'next') {
    const by = {};
    for (const id of D.next) if (M(id)) (by[M(id).rel || '未定'] ||= []).push(id);
    el.innerHTML = Object.entries(by).map(([d, ids]) => `<h2>${d === '未定' ? '上映日未定' : `${fmtDate(d)} 上映`}</h2><div class="grid">${ids.map(card).join('')}</div>`).join('') || '<div class="empty">沒有即將上映的資料</div>';
  } else if (more === 'fav') {
    const ids = S.favs.filter(M);
    el.innerHTML = ids.length ? `<div class="grid">${ids.map(card).join('')}</div>` : '<div class="empty">還沒有收藏。在電影介紹裡按「☆ 收藏」。</div>';
  } else {
    el.innerHTML = `<div class="panel set">
      <div class="r"><span>資料更新時間</span><span class="muted">${esc(D.generatedAt.slice(5, 16))}</span></div>
      <div class="r"><span>轉接站</span><span class="muted small">${esc((S.apiBase || '').replace('https://', ''))}</span></div>
      <button class="btn" id="mSync">立即檢查更新</button>
      <button class="btn" id="mRepair">重新配對</button>
      <p class="muted small">資料由電腦版「電影指南」整理後上傳，電腦版開著時每分鐘檢查一次。手機上按「整理影評」，會請電腦版去做，整理好之後自動出現。</p>
      <p class="muted small">版本 ${APP_VERSION}</p></div>`;
    $('mSync').onclick = async () => { await sync(true); toast('已是最新資料'); };
    $('mRepair').onclick = () => { $('suUrl').value = S.apiBase || ''; $('setup').hidden = false; };
  }
}
$('moreSeg').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) { more = b.dataset.m; renderMore(); } });

// ---------- 電影介紹 ----------
let cur = null, curDate = null;
function openMovie(id, keepScroll = false) {
  const m = M(id); if (!m) return;
  if (cur !== id) curDate = null;
  cur = id;
  const sc = $('sheet').scrollTop;
  if ($('sheet').hidden) history.pushState({ sheet: id }, '');
  $('sheet').hidden = false; document.body.style.overflow = 'hidden';
  const r = m.r || {}, rv = D.reviews[id];
  const rbox = (src, v, sub, link) => `<a class="rbox" ${link ? `href="${esc(link)}" target="_blank" rel="noopener"` : ''}><span class="src">${src}</span><span class="v">${v}</span>${sub ? `<span class="src">${sub}</span>` : ''}</a>`;
  const boxes = [
    r.imdb != null && rbox('IMDb', `${r.imdb}<small>/10</small>`, r.imdbVotes ? `${r.imdbVotes.toLocaleString()} 人` : '', m.imdb && `https://m.imdb.com/title/${m.imdb}/`),
    r.rt != null && rbox('爛番茄', `${r.rt}%`, r.rt >= 60 ? '新鮮' : '爛'),
    r.mc != null && rbox('Metacritic', `${r.mc}<small>/100</small>`),
    r.tmdb != null && rbox('TMDB', `${r.tmdb}<small>/10</small>`),
    rv?.s?.avg != null && rbox('YouTube 影評', `${rv.s.avg}<small>/10</small>`, `${rv.s.recommend}/${rv.s.count} 推薦`),
  ].filter(Boolean);
  const fav = S.favs.includes(id);
  $('sheetBody').innerHTML = `
    <div class="mhead" style="background-image:url('${esc(m.bd || '')}')"><div class="in">${img(m.p)}
      <div><h2>${esc(m.t)}</h2><div class="muted small">${esc(m.en || '')}</div>
        <div class="muted small" style="margin-top:4px">${[m.rel && `${m.rel} 上映`, m.rt && `${m.rt} 分鐘`, m.cert, (m.g || []).join('／')].filter(Boolean).map(esc).join('・')}</div></div></div></div>
    <div class="mbody">
      <div class="ratings">${boxes.join('') || '<span class="muted small">還沒有國外評分</span>'}</div>
      <div class="acts"><button class="btn" id="favBtn">${fav ? '★ 已收藏' : '☆ 收藏'}</button>${m.imdb ? `<a class="btn" href="https://m.imdb.com/title/${m.imdb}/" target="_blank" rel="noopener">IMDb</a>` : ''}
        <a class="btn" href="https://www.atmovies.com.tw/movie/${esc(id)}/" target="_blank" rel="noopener">開眼電影網</a></div>
      ${m.tr?.length ? `<h2>預告片</h2><div class="player" id="player"></div>${m.tr.length > 1 ? `<div class="chips" style="margin-top:8px">${m.tr.map((k, i) => `<button class="chip" data-tr="${esc(k)}" aria-pressed="${i === 0}">預告 ${i + 1}</button>`).join('')}</div>` : ''}` : ''}
      <h2>場次</h2><div id="mShows"></div>
      <h2>YouTube 影評 AI 整理</h2><div class="aibox" id="aiBox"></div>
      <h2>劇情簡介</h2><div class="story">${esc(m.st || '（沒有簡介）')}</div>
      ${m.dir?.length ? `<p class="small"><span class="muted">導演</span>　${m.dir.map(esc).join('、')}</p>` : ''}
      ${m.cast?.length ? `<p class="small"><span class="muted">演員</span>　${m.cast.map(esc).join('、')}</p>` : ''}
      ${m.aw ? `<p class="small"><span class="muted">得獎</span>　${esc(m.aw)}</p>` : ''}
    </div>`;
  if (m.tr?.length) playTrailer(m.tr[0]);
  $('sheetBody').querySelectorAll('[data-tr]').forEach(b => b.onclick = () => { $('sheetBody').querySelectorAll('[data-tr]').forEach(x => x.setAttribute('aria-pressed', String(x === b))); playTrailer(b.dataset.tr); });
  $('favBtn').onclick = () => { const i = S.favs.indexOf(id); if (i >= 0) S.favs.splice(i, 1); else S.favs.unshift(id); saveS(); $('favBtn').textContent = i >= 0 ? '☆ 收藏' : '★ 已收藏'; };
  renderShows();
  renderReview();
  $('sheet').scrollTop = keepScroll ? sc : 0;
}
// 不自動播放；iPhone 上 playsinline 讓影片在頁面內播放
function playTrailer(k) { $('player').innerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${encodeURIComponent(k)}?playsinline=1&rel=0" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe>`; }
function closeSheet() { $('sheet').hidden = true; $('sheetBody').innerHTML = ''; document.body.style.overflow = ''; cur = null; }
$('sheetBack').addEventListener('click', () => history.back());
window.addEventListener('popstate', () => { if (!$('sheet').hidden) closeSheet(); });
function renderShows() {
  const th = theaterMap();
  const dates = showDates().filter(d => D.shows[d].some(s => s[1] === cur && th[s[0]] && inArea(th[s[0]])));
  const box = $('mShows');
  if (!dates.length) { box.innerHTML = `<p class="muted small">${M(cur).s === 'next' ? '還沒上映，上映前一週左右會有時刻表。' : '這個地區目前沒有場次。'}</p>`; return; }
  if (!curDate || !dates.includes(curDate)) curDate = dates[0];
  const by = new Map();
  for (const [tid, mid, ver, ...times] of D.shows[curDate]) {
    if (mid !== cur || !th[tid] || !inArea(th[tid])) continue;
    if (!by.has(tid)) by.set(tid, []);
    by.get(tid).push({ ver, times });
  }
  box.innerHTML = `<div class="chips scroll" style="margin-bottom:8px">${dates.map(d => `<button class="chip" data-md="${d}" aria-pressed="${d === curDate}">${dayLabel(d)}</button>`).join('')}</div>
    ${[...by.entries()].map(([tid, vs]) => { const t = th[tid]; return `<div class="showth"><div class="name"><span>${esc(t.n)}</span><span class="small">${t.book ? `<a href="${esc(t.book)}" target="_blank" rel="noopener">訂票</a>　` : ''}<a href="${mapUrl(t)}" target="_blank" rel="noopener">地圖</a></span></div>
      ${vs.map(v => `${v.ver ? `<div style="margin-top:5px"><span class="ver" style="margin:0">${esc(v.ver)}</span></div>` : ''}<div class="times">${v.times.map(x => `<span class="time ${isPast(curDate, x) ? 'past' : ''}">${x}</span>`).join('')}</div>`).join('')}</div>`; }).join('')}`;
  box.querySelectorAll('[data-md]').forEach(b => b.onclick = () => { curDate = b.dataset.md; renderShows(); });
}
function renderReview() {
  const box = $('aiBox'), rv = D.reviews[cur];
  if (rv) {
    box.innerHTML = `<div class="md">${md(rv.c)}</div>
      ${rv.v.map(([vid, title, ch, views, verdict, score]) => `<a class="vid" href="https://www.youtube.com/watch?v=${esc(vid)}" target="_blank" rel="noopener"><img src="https://i.ytimg.com/vi/${esc(vid)}/mqdefault.jpg" loading="lazy" alt="">
        <span><span class="vt">${esc(title)}</span><br>${esc(ch)}・${(views || 0).toLocaleString()} 次<br><span class="verdict ${esc(verdict)}">${esc(verdict)}</span> ${score ?? ''} 分</span></a>`).join('')}
      <p class="muted small">整理於 ${esc(rv.at)}</p>`;
    return;
  }
  const pend = S.pending[cur];
  box.innerHTML = pend
    ? `<p class="muted small" style="margin:0">已請電腦版整理（${esc(pend.slice(5, 16))}）。電腦版開著的話，大約 5～10 分鐘後會自動出現在這裡。</p>`
    : `<p class="muted small" style="margin-top:0">找 YouTube 上最多人看的影評影片，讓 AI 看完整理成「大家怎麼說」（不劇透）。會請電腦版去做，電腦版要開著。</p><button class="primary" id="aiGo">請電腦版整理影評</button>`;
  if ($('aiGo')) $('aiGo').onclick = async () => {
    try { await api('POST', '/movie/request', { type: 'review', id: cur }); S.pending[cur] = new Date().toLocaleString('sv-SE'); saveS(); renderReview(); toast('已送出'); }
    catch (e) { toast(e.message); }
  };
}
// 簡單的 Markdown 轉換
function md(src) {
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = []; let list = null;
  const flush = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(src || '').split('\n')) {
    const l = raw.trimEnd(); let m;
    if (/^\|/.test(l.trim())) { if (/^\|[\s:|-]+\|$/.test(l.trim())) continue; flush(); out.push(`<p>${inline(l.trim().slice(1, -1).split('|').map(c => c.trim()).join('｜'))}</p>`); }
    else if ((m = l.match(/^(#{1,3})\s+(.*)/))) { flush(); out.push(`<h${m[1].length + 1}>${inline(m[2])}</h${m[1].length + 1}>`); }
    else if ((m = l.match(/^\s*[-*]\s+(.*)/))) { if (list !== 'ul') { flush(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if ((m = l.match(/^\s*\d+[.)]\s+(.*)/))) { if (list !== 'ol') { flush(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inline(m[1])}</li>`); }
    else if (!l.trim()) flush();
    else { flush(); out.push(`<p>${inline(l)}</p>`); }
  }
  flush();
  return out.join('');
}

// ---------- 啟動 ----------
(async () => {
  D = await idbGet('snap').catch(() => null);
  $('loading').hidden = true;
  if (!S.token) { $('setup').hidden = false; }
  go(tab);
  if (!D) showEmpty(S.token ? '下載資料中…' : '請先連結電腦版');
  sync();
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { sync(); if (D) render(); } });
  setInterval(() => { if (!document.hidden) sync(); }, 5 * 60e3);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
})();
