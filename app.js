/* Slipstream — Crypto Lag Radar
 * Finds coins that trail the market leaders (lead-lag cross-correlation).
 * Runs entirely in the browser. Price data: Coinbase Exchange (fine granularity) + CoinGecko
 * (one bulk call for volume ranking AND a fast 7-day hourly snapshot). No API key required.
 *
 * HOW IT WORKS
 *  1. Pull recent candles for each coin, convert closes -> per-candle % returns.
 *  2. For a candidate coin X and a leader L, slide X against L over a range of lags k.
 *     We correlate X's move NOW with L's move k candles AGO  ->  corr( X[t], L[t-k] ).
 *     The lag k* with the highest correlation = how far X trails L.
 *  3. Confidence rewards a SHARP peak at a specific, non-zero lag and punishes coins
 *     that just co-move with everything (a flat, high correlation curve = boring, not a lag).
 *
 * SPEED: the default "1-hour" view loads from a single CoinGecko call (7d hourly for ~250 coins),
 * so it's near-instant. Finer timeframes stream from Coinbase. Everything is cached per timeframe.
 */

// ------------------------------- CONFIG -------------------------------
const CONFIG = {
  apiBase: 'https://api.exchange.coinbase.com',
  quote: 'USD',
  leaders: ['BTC', 'ETH', 'SOL'],

  // Path B backend (optional). Leave '' for pure client-side. Set to your deployed Worker URL
  // (e.g. 'https://slipstream-worker.you.workers.dev') to show the server "Signals" panel.
  workerBase: '',

  exclude: new Set([
    'USDT', 'USDC', 'DAI', 'PYUSD', 'GUSD', 'USDP', 'PAX', 'BUSD', 'UST', 'USTC',
    'LUSD', 'USDD', 'EURC', 'EUROC', 'GYEN', 'RLUSD', 'WBTC', 'CBETH', 'CBBTC',
    'USD1', 'USDS', 'FDUSD', 'USDE', 'USDG', 'USDR', 'EURT', 'PAXG', 'XAUT',
  ]),

  maxCoins: 120,      // scan the top-N most liquid coins (ranked by volume)
  concurrency: 2,     // parallel Coinbase candle fetches (it rate-limits bursts — keep low)
  pacingMs: 220,      // gap between requests within a worker (~9 req/s, under Coinbase's ~10/s)
  minOverlap: 40,     // need at least this many aligned return points to trust a correlation
  reanalyzeMs: 450,   // how often to recompute+re-render while data is still streaming in

  timeframes: {
    // The default is powered by one bulk CoinGecko call → loads almost instantly.
    '1h':  { label: '1-hour · 7 days (fast)', source: 'gecko',    granularity: 3600,  maxLagCandles: 24 },
    '5m':  { label: '5-min · ~1 day',         source: 'coinbase', granularity: 300,   maxLagCandles: 36 },
    '15m': { label: '15-min · ~3 days',       source: 'coinbase', granularity: 900,   maxLagCandles: 32 },
    '6h':  { label: '6-hour · ~75 days',      source: 'coinbase', granularity: 21600, maxLagCandles: 20 },
  },
};

// ------------------------------- STATE -------------------------------
let AVAILABLE = null;             // Set of live base symbols on Coinbase (quote = USD)
let MARKETS = null;               // cached CoinGecko /coins/markets response (ranking + sparklines)
let ROWS = [];                    // last computed rows
let DATA = new Map();             // most recent returns map — for on-demand stats (watchlist + modal)
const CACHE = new Map();          // `${sym}|${granularity}` -> { closes:[], returns:[] }
let scanToken = 0;                // bumped on every new scan so stale streams stop touching the UI

// Watchlist: hearted coin→leader matches, persisted in localStorage so they survive refreshes.
const WATCH_KEY = 'slipstream.watch';
function loadWatch() {
  try { return new Set(JSON.parse(localStorage.getItem(WATCH_KEY) || '[]')); } catch { return new Set(); }
}
function saveWatch() {
  try { localStorage.setItem(WATCH_KEY, JSON.stringify([...WATCH])); } catch {}
}
let WATCH = loadWatch();          // Set of `${coin}|${leader}` keys
const pairKey = (coin, leader) => `${coin}|${leader}`;
function watchedSymbols() {       // every coin referenced by the watchlist (both sides)
  const s = new Set();
  for (const k of WATCH) { const [a, b] = k.split('|'); s.add(a); s.add(b); }
  return s;
}

// ------------------------------- DOM -------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  timeframe: $('timeframe'), mode: $('mode'), minConf: $('minConf'), minConfVal: $('minConfVal'),
  refresh: $('refresh'), lastUpdated: $('lastUpdated'), coinCount: $('coinCount'),
  statusDot: $('statusDot'), statusText: $('statusText'),
  progress: $('progress'), progressFill: $('progressFill'), progressText: $('progressText'),
  body: $('resultsBody'),
  signalsPanel: $('signalsPanel'), signalsBody: $('signalsBody'), signalsMeta: $('signalsMeta'),
  watchPanel: $('watchPanel'), watchBody: $('watchBody'), watchCount: $('watchCount'),
  modal: $('chartModal'), modalTitle: $('modalTitle'), modalStats: $('modalStats'),
  modalChart: $('modalChart'), modalClose: $('modalClose'), alignLag: $('alignLag'),
};

// ------------------------------- MATH -------------------------------
function toReturns(closes) {
  const r = new Array(closes.length - 1);
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    r[i - 1] = prev ? (closes[i] - prev) / prev : 0;
  }
  return r;
}

// Pearson correlation of X[t] vs L[t-k], computed in place (no array allocation).
function corrAtLag(rx, rl, k, minOverlap) {
  const n = Math.min(rx.length, rl.length);
  const m = n - k;
  if (m < minOverlap) return NaN;
  let sx = 0, sy = 0;
  for (let t = k; t < n; t++) { sx += rx[t]; sy += rl[t - k]; }
  const mx = sx / m, my = sy / m;
  let num = 0, dx = 0, dy = 0;
  for (let t = k; t < n; t++) {
    const a = rx[t] - mx, b = rl[t - k] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return den ? num / den : 0;
}

function lagCurve(rx, rl, maxLag) {
  const curve = new Array(maxLag + 1);
  for (let k = 0; k <= maxLag; k++) curve[k] = corrAtLag(rx, rl, k, CONFIG.minOverlap);
  return curve;
}

/* Confidence: turn a lag curve into a 0-100 score.
 *  - strength : how high the peak correlation is (must clear a real bar)
 *  - sharpness: how far the peak stands above the average of the whole curve
 *  - lagFactor: a peak at lag 0 means "coincident", not "lagging" -> heavily discounted
 */
function scoreCurve(curve) {
  let peakCorr = -Infinity, peakLag = 0, sum = 0, count = 0;
  for (let k = 0; k < curve.length; k++) {
    const c = curve[k];
    if (Number.isNaN(c)) continue;
    sum += c; count++;
    if (c > peakCorr) { peakCorr = c; peakLag = k; }
  }
  if (count === 0 || peakCorr <= 0) return { confidence: 0, peakCorr: 0, peakLag: 0 };

  const mean = sum / count;
  const prominence = peakCorr - mean;
  const strength = Math.min(1, peakCorr);
  const sharp = Math.min(1, Math.max(0, prominence / 0.30));
  const lagFactor = peakLag === 0 ? 0.35 : 1;

  const confidence = 100 * Math.pow(strength, 1.5) * (0.35 + 0.65 * sharp) * lagFactor;
  return { confidence: Math.round(confidence * 10) / 10, peakCorr, peakLag, curve };
}

// ------------------------------- DATA -------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJSON(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 429) { await sleep(600 * (i + 1)); continue; }
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } catch (e) {
      if (i === tries - 1) throw e;
      await sleep(400);
    }
  }
}

function cachePut(sym, granularity, closes) {
  const entry = { closes, returns: toReturns(closes) };
  CACHE.set(`${sym}|${granularity}`, entry);
  return entry;
}

async function loadAvailable() {
  if (AVAILABLE) return AVAILABLE;
  const products = await fetchJSON(`${CONFIG.apiBase}/products`);
  AVAILABLE = new Set(
    products
      .filter((p) => p.quote_currency === CONFIG.quote && p.status === 'online' && !p.trading_disabled)
      .map((p) => p.base_currency)
  );
  return AVAILABLE;
}

// One bulk CoinGecko call: coins ordered by 24h volume, each with a 7-day hourly sparkline.
async function loadMarkets() {
  if (MARKETS) return MARKETS;
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=true';
    const data = await fetchJSON(url, 2);
    MARKETS = Array.isArray(data) ? data : [];
  } catch {
    MARKETS = [];
  }
  return MARKETS;
}

// Volume-ranked list of upper-case symbols (for ordering the Coinbase universe), or null.
async function loadRanked() {
  const m = await loadMarkets();
  if (!m.length) return null;
  const seen = new Set(); const out = [];
  for (const c of m) {
    const s = (c.symbol || '').toUpperCase();
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

// Returns closes[] ascending by time, or null on failure.
async function fetchCandles(symbol, granularity) {
  const url = `${CONFIG.apiBase}/products/${symbol}-${CONFIG.quote}/candles?granularity=${granularity}`;
  try {
    const raw = await fetchJSON(url); // rows: [time, low, high, open, close, volume], newest first
    if (!Array.isArray(raw) || raw.length < CONFIG.minOverlap + 5) return null;
    return raw.slice().sort((a, b) => a[0] - b[0]).map((r) => r[4]);
  } catch {
    return null;
  }
}

// Stream returns for a universe from Coinbase. onData(sym) fires as each coin lands.
async function streamUniverse(symbols, granularity, target, token, onData, onProgress) {
  let done = 0;
  const queue = symbols.slice();
  async function worker() {
    while (queue.length) {
      if (token !== scanToken) return;
      const sym = queue.shift();
      const key = `${sym}|${granularity}`;
      let entry = CACHE.get(key);
      if (!entry) {
        const closes = await fetchCandles(sym, granularity);
        if (closes) entry = cachePut(sym, granularity, closes);
      }
      if (token !== scanToken) return;
      if (entry) { target.set(sym, entry.returns); onData(sym); }
      onProgress(++done, symbols.length, sym);
      if (queue.length && !CACHE.has(`${queue[0]}|${granularity}`)) await sleep(CONFIG.pacingMs);
    }
  }
  await Promise.all(Array.from({ length: CONFIG.concurrency }, worker));
}

// ------------------------------- ANALYSIS -------------------------------
function analyzeLeaders(returns, maxLag) {
  const rows = [];
  const leaders = CONFIG.leaders.filter((l) => returns.has(l));
  for (const [sym, rx] of returns) {
    if (CONFIG.leaders.includes(sym)) continue;
    let best = null;
    for (const L of leaders) {
      const s = scoreCurve(lagCurve(rx, returns.get(L), maxLag));
      if (!best || s.confidence > best.confidence) best = { ...s, coin: sym, leader: L };
    }
    if (best && best.confidence > 0) rows.push(best);
  }
  return rows;
}

function analyzePairs(returns, maxLag) {
  const rows = [];
  const syms = Array.from(returns.keys());
  for (const follower of syms) {
    const rx = returns.get(follower);
    let best = null;
    for (const leader of syms) {
      if (leader === follower) continue;
      const s = scoreCurve(lagCurve(rx, returns.get(leader), maxLag));
      if (!best || s.confidence > best.confidence) best = { ...s, coin: follower, leader };
    }
    if (best && best.confidence > 0) rows.push(best);
  }
  return rows;
}

// ------------------------------- RENDER -------------------------------
function setStatus(kind, text) {
  el.statusDot.className = 'dot ' + kind;
  el.statusText.textContent = text;
}

function fmtLag(candles, granularity) {
  if (candles === 0) return 'coincident';
  const secs = candles * granularity;
  const h = Math.floor(secs / 3600);
  const m = Math.round((secs % 3600) / 60);
  const parts = [];
  if (h) parts.push(h + 'h');
  if (m) parts.push(m + 'm');
  return (parts.join(' ') || '0m') + ' behind';
}

function confColor(v) {
  if (v >= 65) return 'var(--good)';
  if (v >= 40) return 'var(--accent)';
  if (v >= 20) return 'var(--warn)';
  return 'var(--bad)';
}

function sparkline(curve) {
  const w = 120, h = 26, pad = 2;
  const vals = curve.map((c) => (Number.isNaN(c) ? 0 : c));
  const max = Math.max(0.05, ...vals), min = Math.min(0, ...vals);
  const range = max - min || 1;
  const pts = vals.map((v, i) => {
    const x = pad + (i / (vals.length - 1)) * (w - 2 * pad);
    const y = h - pad - ((v - min) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  let peakLag = 0, peak = -Infinity;
  vals.forEach((v, i) => { if (v > peak) { peak = v; peakLag = i; } });
  const px = pad + (peakLag / (vals.length - 1)) * (w - 2 * pad);
  const py = h - pad - ((peak - min) / range) * (h - 2 * pad);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">
    <polyline points="${pts}" fill="none" stroke="var(--accent-2)" stroke-width="1.5"/>
    <circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="2.6" fill="var(--accent)"/>
  </svg>`;
}

function render() {
  const tf = CONFIG.timeframes[el.timeframe.value];
  const minConf = Number(el.minConf.value);
  const rows = ROWS
    .filter((r) => r.confidence >= minConf)
    .sort((a, b) => b.confidence - a.confidence);

  if (!rows.length) {
    el.body.innerHTML = `<tr><td colspan="8" class="empty">No laggards cleared the ${minConf}% bar yet. Lower the filter or try another timeframe.</td></tr>`;
    return;
  }

  el.body.innerHTML = rows.map((r, i) => {
    const c = confColor(r.confidence);
    return `<tr>
      <td>${i + 1}</td>
      <td class="left"><span class="coin">${r.coin}<small>${r.coin}-USD</small></span></td>
      <td class="left"><span class="leader-badge">${r.leader}</span></td>
      <td class="lag">${r.peakLag === 0 ? '<small>coincident</small>' : fmtLag(r.peakLag, tf.granularity)}</td>
      <td class="match">${(r.peakCorr * 100).toFixed(0)}%</td>
      <td><div class="conf-wrap">
        <div class="conf-bar"><i style="width:${Math.min(100, r.confidence)}%;background:${c}"></i></div>
        <span class="conf-num" style="color:${c}">${r.confidence.toFixed(0)}%</span>
      </div></td>
      <td class="left">${sparkline(r.curve || [])}</td>
      <td class="acts">
        <button class="heart ${WATCH.has(pairKey(r.coin, r.leader)) ? 'on' : ''}" data-coin="${r.coin}" data-leader="${r.leader}" title="Watch this match">${WATCH.has(pairKey(r.coin, r.leader)) ? '♥' : '♡'}</button>
        <button class="cmp" data-coin="${r.coin}" data-leader="${r.leader}" title="Compare ${r.coin} vs ${r.leader}">⇋</button>
      </td>
    </tr>`;
  }).join('');
}

// Current stats for any coin→leader pair, computed from the latest data (null if data missing).
function statsFor(coin, leader) {
  const tf = CONFIG.timeframes[el.timeframe.value];
  const rx = DATA.get(coin), rl = DATA.get(leader);
  if (!rx || !rl) return null;
  return { coin, leader, ...scoreCurve(lagCurve(rx, rl, tf.maxLagCandles)) };
}

function toggleWatch(coin, leader) {
  const k = pairKey(coin, leader);
  if (WATCH.has(k)) WATCH.delete(k); else WATCH.add(k);
  saveWatch();
  render();       // refresh hearts in the main table
  renderWatch();  // refresh the watch panel
}

// The pinned "Watching" panel — always shows hearted matches with their CURRENT stats,
// regardless of the confidence filter or whether they made the main list this scan.
function renderWatch() {
  if (!WATCH.size) { el.watchPanel.classList.add('hidden'); return; }
  el.watchPanel.classList.remove('hidden');
  el.watchCount.textContent = `(${WATCH.size})`;
  const tf = CONFIG.timeframes[el.timeframe.value];

  const rows = [...WATCH].map((k) => {
    const [coin, leader] = k.split('|');
    return statsFor(coin, leader) || { coin, leader, missing: true };
  }).sort((a, b) => (b.confidence || 0) - (a.confidence || 0));

  el.watchBody.innerHTML = rows.map((r) => {
    const heart = `<button class="heart on" data-coin="${r.coin}" data-leader="${r.leader}" title="Stop watching">♥</button>`;
    if (r.missing) {
      return `<tr>
        <td class="left"><span class="coin">${r.coin}</span></td>
        <td class="left"><span class="leader-badge">${r.leader}</span></td>
        <td colspan="3" class="muted-cell">no data this timeframe</td>
        <td></td><td>${heart}</td></tr>`;
    }
    const c = confColor(r.confidence);
    return `<tr>
      <td class="left"><span class="coin">${r.coin}</span></td>
      <td class="left"><span class="leader-badge">${r.leader}</span></td>
      <td class="lag">${r.peakLag === 0 ? '<small>coincident</small>' : fmtLag(r.peakLag, tf.granularity)}</td>
      <td class="match">${(r.peakCorr * 100).toFixed(0)}%</td>
      <td><div class="conf-wrap">
        <div class="conf-bar"><i style="width:${Math.min(100, r.confidence)}%;background:${c}"></i></div>
        <span class="conf-num" style="color:${c}">${r.confidence.toFixed(0)}%</span>
      </div></td>
      <td><button class="cmp" data-coin="${r.coin}" data-leader="${r.leader}" title="Compare">⇋</button></td>
      <td>${heart}</td>
    </tr>`;
  }).join('');
}

// ------------------------------- COMPARE CHART (modal) -------------------------------
let modalCtx = null; // { coin, leader, lag, granularity }

function normalize(closes) {
  const base = closes[0] || 1;
  return closes.map((c) => (100 * c) / base);
}

// Build an SVG overlay of coin vs leader; optionally shift the leader by the detected lag.
function buildCompareSVG(coinCloses, leaderCloses, lag, alignByLag) {
  const w = 760, h = 340, padL = 46, padR = 16, padT = 16, padB = 30;
  const n = Math.min(coinCloses.length, leaderCloses.length);
  const coin = normalize(coinCloses.slice(-n));
  const lead = normalize(leaderCloses.slice(-n));

  // Series to plot: coin, leader, and (optionally) leader shifted right by `lag`.
  const series = [
    { vals: coin.map((v, i) => [i, v]), stroke: 'var(--accent)', width: 2, dash: '' },
    { vals: lead.map((v, i) => [i, v]), stroke: 'var(--accent-2)', width: 1.6, dash: '', opacity: 0.45 },
  ];
  if (alignByLag && lag > 0) {
    const shifted = [];
    for (let i = lag; i < n; i++) shifted.push([i, lead[i - lag]]);
    series.push({ vals: shifted, stroke: 'var(--accent-2)', width: 1.8, dash: '5 4', opacity: 0.95 });
  }

  let lo = Infinity, hi = -Infinity;
  for (const s of series) for (const [, v] of s.vals) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const range = hi - lo || 1;
  const X = (i) => padL + (i / (n - 1)) * (w - padL - padR);
  const Y = (v) => padT + (1 - (v - lo) / range) * (h - padT - padB);

  const gridY = [lo, lo + range / 2, hi].map((v) => {
    const y = Y(v).toFixed(1);
    return `<line x1="${padL}" y1="${y}" x2="${w - padR}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
      <text x="${padL - 6}" y="${(+y + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--muted)">${v.toFixed(0)}</text>`;
  }).join('');

  const paths = series.map((s) => {
    const d = s.vals.map(([i, v], k) => `${k ? 'L' : 'M'}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.stroke}" stroke-width="${s.width}"
      stroke-dasharray="${s.dash}" opacity="${s.opacity ?? 1}" stroke-linejoin="round"/>`;
  }).join('');

  return `<svg viewBox="0 0 ${w} ${h}" width="100%" preserveAspectRatio="xMidYMid meet">
    ${gridY}
    <text x="${padL}" y="${h - 8}" font-size="10" fill="var(--muted)">← older</text>
    <text x="${w - padR}" y="${h - 8}" font-size="10" fill="var(--muted)" text-anchor="end">newer →</text>
    ${paths}
  </svg>`;
}

function drawModal() {
  if (!modalCtx) return;
  const { coin, leader, lag, granularity, row } = modalCtx;
  const c = CACHE.get(`${coin}|${granularity}`);
  const l = CACHE.get(`${leader}|${granularity}`);
  if (!c || !l) { el.modalChart.innerHTML = '<p class="empty">Price data unavailable — run a scan first.</p>'; return; }
  el.modalChart.innerHTML = buildCompareSVG(c.closes, l.closes, lag, el.alignLag.checked);

  const tf = CONFIG.timeframes[el.timeframe.value];
  el.modalStats.innerHTML = `
    <span><b style="color:var(--accent)">${coin}</b> follows <b style="color:var(--accent-2)">${leader}</b></span>
    <span class="pill">${lag === 0 ? 'coincident' : fmtLag(lag, tf.granularity)}</span>
    <span class="pill">match ${(row.peakCorr * 100).toFixed(0)}%</span>
    <span class="pill">confidence ${row.confidence.toFixed(0)}%</span>`;
}

function openModal(coin, leader) {
  const row = statsFor(coin, leader);
  if (!row) return;
  const tf = CONFIG.timeframes[el.timeframe.value];
  modalCtx = { coin, leader, lag: row.peakLag, granularity: tf.granularity, row };
  el.modalTitle.textContent = `${coin} vs ${leader}`;
  el.alignLag.checked = row.peakLag > 0;
  drawModal();
  el.modal.classList.remove('hidden');
}

function closeModal() { el.modal.classList.add('hidden'); modalCtx = null; }

// ------------------------------- SCAN -------------------------------
// Fast path: build the whole field from the single bulk CoinGecko sparkline call.
async function runGecko(tf, returns, token) {
  el.progressText.textContent = 'Loading market data…';
  el.progressFill.style.width = '25%';
  const markets = await loadMarkets();
  if (token !== scanToken) return true;
  if (!markets.length) return false;

  const need = watchedSymbols();
  const seen = new Set();
  for (const m of markets) {
    const sym = (m.symbol || '').toUpperCase();
    const prices = m.sparkline_in_7d && m.sparkline_in_7d.price;
    if (!sym || seen.has(sym) || CONFIG.exclude.has(sym)) continue;
    if (!Array.isArray(prices) || prices.length < CONFIG.minOverlap + 5) continue;
    if (returns.size >= CONFIG.maxCoins && !need.has(sym)) continue; // keep watched coins beyond the cap
    seen.add(sym);
    const entry = cachePut(sym, tf.granularity, prices);
    returns.set(sym, entry.returns);
  }
  el.progressFill.style.width = '100%';
  el.progressText.textContent = `${returns.size} coins loaded`;
  return returns.size > 0;
}

// Coinbase path: stream fine-grained candles, top coins first.
async function runCoinbase(tf, returns, token, onData) {
  const [avail, ranked] = await Promise.all([loadAvailable(), loadRanked()]);
  if (token !== scanToken) return;
  const order = ranked && ranked.length ? ranked : Array.from(avail).sort();
  const rest = order.filter((s) => avail.has(s) && !CONFIG.leaders.includes(s) && !CONFIG.exclude.has(s));
  const base = [...CONFIG.leaders.filter((l) => avail.has(l)), ...rest].slice(0, CONFIG.maxCoins);
  const extra = [...watchedSymbols()].filter((s) => avail.has(s) && !base.includes(s)); // watched coins beyond the cap
  const universe = [...base, ...extra];
  el.progressText.textContent = `0 / ${universe.length} coins`;
  await streamUniverse(universe, tf.granularity, returns, token, onData, (done, total, sym) => {
    if (token !== scanToken) return;
    el.progressFill.style.width = `${(done / total) * 100}%`;
    el.progressText.textContent = `${done} / ${total} — ${sym}`;
  });
}

async function scan() {
  const token = ++scanToken;
  el.refresh.disabled = true;
  setStatus('working', 'Scanning…');
  el.progress.classList.remove('hidden');
  el.progressFill.style.width = '0%';

  const tf = CONFIG.timeframes[el.timeframe.value];
  const returns = new Map();
  DATA = returns;
  ROWS = [];
  render();
  renderWatch();

  // Throttled recompute so the table fills in and re-ranks live without janking.
  let lastRun = 0, pending = null, dirty = false;
  const reanalyze = (force) => {
    if (token !== scanToken) return;
    const run = () => {
      lastRun = performance.now(); dirty = false; pending = null;
      ROWS = el.mode.value === 'pairs'
        ? analyzePairs(returns, tf.maxLagCandles)
        : analyzeLeaders(returns, tf.maxLagCandles);
      render();
      renderWatch();
      el.coinCount.textContent = `${returns.size} coins analyzed · ${ROWS.length} laggards`;
    };
    if (force) { if (pending) { clearTimeout(pending); pending = null; } run(); return; }
    if (el.mode.value === 'pairs') return; // O(n²) — final pass only
    dirty = true;
    const since = performance.now() - lastRun;
    if (since >= CONFIG.reanalyzeMs) run();
    else if (!pending) pending = setTimeout(() => { if (dirty) run(); }, CONFIG.reanalyzeMs - since);
  };

  try {
    if (tf.source === 'gecko') {
      const ok = await runGecko(tf, returns, token);
      if (token !== scanToken) return;
      if (!ok) await runCoinbase(tf, returns, token, () => reanalyze(false)); // fallback
    } else {
      await runCoinbase(tf, returns, token, () => reanalyze(false));
    }
    if (token !== scanToken) return;

    reanalyze(true);
    el.lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
    setStatus('live', 'Live');
  } catch (e) {
    if (token !== scanToken) return;
    setStatus('error', 'Error');
    if (!ROWS.length) {
      el.body.innerHTML = `<tr><td colspan="8" class="empty">Scan failed: ${e.message}. The data source may be rate-limiting — wait a moment and scan again.</td></tr>`;
    }
  } finally {
    if (token === scanToken) {
      el.progress.classList.add('hidden');
      el.refresh.disabled = false;
    }
  }
}

// ------------------------------- SIGNALS (Path B backend) -------------------------------
function fmtAgo(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 90) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return m + 'm ago';
  const h = Math.round(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.round(h / 24) + 'd ago';
}

function renderSignals(signals, updatedAt) {
  if (!signals || !signals.length) { el.signalsPanel.classList.add('hidden'); return; }
  el.signalsPanel.classList.remove('hidden');
  el.signalsMeta.textContent = updatedAt ? `server checked ${fmtAgo(updatedAt)}` : '';
  el.signalsBody.innerHTML = signals.slice(0, 12).map((s) => {
    const from = s.prevConfidence ? `${s.prevConfidence.toFixed(0)}%` : 'off-list';
    return `<li>
      <span class="sig-pair"><b>${s.coin}</b> → <span class="sig-leader">${s.leader}</span></span>
      <span class="sig-jump">crossed to <b>${s.confidence.toFixed(0)}%</b> <small>(was ${from})</small></span>
      <span class="sig-time">${fmtAgo(s.at)}</span>
    </li>`;
  }).join('');
}

async function loadSignals() {
  if (!CONFIG.workerBase) return;
  try {
    const res = await fetch(`${CONFIG.workerBase.replace(/\/$/, '')}/api/signals`);
    if (!res.ok) return;
    const data = await res.json();
    renderSignals(data.signals || [], data.updatedAt);
  } catch { /* backend not reachable — stay silent, panel hidden */ }
}

// ------------------------------- INIT -------------------------------
function init() {
  for (const [key, tf] of Object.entries(CONFIG.timeframes)) {
    const o = document.createElement('option');
    o.value = key; o.textContent = tf.label;
    if (key === '1h') o.selected = true;
    el.timeframe.appendChild(o);
  }
  el.minConf.addEventListener('input', () => {
    el.minConfVal.textContent = el.minConf.value;
    render();
  });
  el.mode.addEventListener('change', scan);
  el.timeframe.addEventListener('change', scan);
  el.refresh.addEventListener('click', () => { CACHE.clear(); MARKETS = null; scan(); });

  // Compare + heart buttons (event-delegated on both tables) + modal wiring.
  const onActionClick = (e) => {
    const cmp = e.target.closest('button.cmp');
    if (cmp) { openModal(cmp.dataset.coin, cmp.dataset.leader); return; }
    const heart = e.target.closest('button.heart');
    if (heart) toggleWatch(heart.dataset.coin, heart.dataset.leader);
  };
  el.body.addEventListener('click', onActionClick);
  el.watchBody.addEventListener('click', onActionClick);
  el.modalClose.addEventListener('click', closeModal);
  el.modal.addEventListener('click', (e) => { if (e.target === el.modal) closeModal(); });
  el.alignLag.addEventListener('change', drawModal);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  setStatus('', 'Idle');
  renderWatch(); // show any persisted watchlist immediately
  scan();        // auto-run on load

  // Path B: pull server-detected signals now and refresh periodically (no-op if workerBase is '').
  loadSignals();
  if (CONFIG.workerBase) setInterval(loadSignals, 120000);
}
init();
