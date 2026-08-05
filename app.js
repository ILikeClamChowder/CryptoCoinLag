/* Slipstream — Crypto Lag Radar
 * Finds coins that trail the market leaders (lead-lag cross-correlation).
 * Runs entirely in the browser. Data: Coinbase Exchange public API (no key, US-friendly, CORS-enabled).
 *
 * HOW IT WORKS
 *  1. Pull recent candles for each coin, convert closes -> per-candle % returns.
 *  2. For a candidate coin X and a leader L, slide X against L over a range of lags k.
 *     We correlate X's move NOW with L's move k candles AGO  ->  corr( X[t], L[t-k] ).
 *     The lag k* with the highest correlation = how far X trails L.
 *  3. Confidence rewards a SHARP peak at a specific, non-zero lag and punishes coins
 *     that just co-move with everything (a flat, high correlation curve = boring, not a lag).
 *
 * Results stream in live: rows appear and re-rank as each coin's data arrives, and each
 * timeframe's data is cached so switching back is instant.
 */

// ------------------------------- CONFIG -------------------------------
const CONFIG = {
  apiBase: 'https://api.exchange.coinbase.com',
  quote: 'USD',
  leaders: ['BTC', 'ETH', 'SOL'],

  // The universe is EVERY coin Coinbase lists against USD (fetched live), minus the
  // stablecoins/fiat below (they'd just show 100% flat matches and add noise).
  exclude: new Set([
    'USDT', 'USDC', 'DAI', 'PYUSD', 'GUSD', 'USDP', 'PAX', 'BUSD', 'UST', 'USTC',
    'LUSD', 'USDD', 'EURC', 'EUROC', 'GYEN', 'RLUSD', 'WBTC', 'CBETH', 'CBBTC',
    'USD1', 'USDS', 'FDUSD', 'USDE', 'USDG', 'USDR', 'EURT', 'PAXG', 'XAUT',
  ]),

  maxCoins: 120,      // scan the top-N most liquid coins (ranked by volume) — keeps scans fast
  concurrency: 2,     // parallel candle fetches (Coinbase rate-limits bursts — keep this low)
  pacingMs: 220,      // gap between each request within a worker (~8-9 req/s, under Coinbase's ~10/s)
  minOverlap: 40,     // need at least this many aligned return points to trust a correlation
  reanalyzeMs: 450,   // how often to recompute+re-render while data is still streaming in

  timeframes: {
    '5m':  { label: '5-min · ~1 day',    granularity: 300,   maxLagCandles: 36 }, // up to 3h lag
    '15m': { label: '15-min · ~3 days',  granularity: 900,   maxLagCandles: 32 }, // up to 8h lag
    '1h':  { label: '1-hour · ~12 days', granularity: 3600,  maxLagCandles: 24 }, // up to 1 day lag
    '6h':  { label: '6-hour · ~75 days', granularity: 21600, maxLagCandles: 20 }, // up to 5 days lag
  },
};

// ------------------------------- STATE -------------------------------
let AVAILABLE = null;             // Set of live base symbols on Coinbase (quote = USD)
let ROWS = [];                    // last computed rows
const CACHE = new Map();          // `${sym}|${granularity}` -> returns[]  (per-timeframe candle cache)
let scanToken = 0;                // bumped on every new scan so stale streams stop touching the UI

// ------------------------------- DOM -------------------------------
const $ = (id) => document.getElementById(id);
const el = {
  timeframe: $('timeframe'), mode: $('mode'), minConf: $('minConf'), minConfVal: $('minConfVal'),
  refresh: $('refresh'), lastUpdated: $('lastUpdated'), coinCount: $('coinCount'),
  statusDot: $('statusDot'), statusText: $('statusText'),
  progress: $('progress'), progressFill: $('progressFill'), progressText: $('progressText'),
  body: $('resultsBody'),
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

// Pearson correlation of X[t] vs L[t-k], computed in place (no array allocation — fast enough
// to recompute the full all-pairs grid many times per scan).
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
 *               (a flat curve = generic co-movement, NOT a lag relationship)
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
  const prominence = peakCorr - mean;              // sharpness of the peak
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

// One bulk CoinGecko call → coin symbols ordered by 24h trading volume (most liquid first).
// Used only to PICK and ORDER the universe; all price data still comes from Coinbase.
// Returns an ordered array of upper-case symbols, or null if unavailable (we then fall back).
let RANKED = null;
async function loadRanked() {
  if (RANKED) return RANKED;
  try {
    const url = 'https://api.coingecko.com/api/v3/coins/markets'
      + '?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=false';
    const data = await fetchJSON(url, 2);
    if (!Array.isArray(data)) return null;
    const seen = new Set();
    RANKED = [];
    for (const c of data) {
      const s = (c.symbol || '').toUpperCase();
      if (s && !seen.has(s)) { seen.add(s); RANKED.push(s); }
    }
    return RANKED;
  } catch {
    return null;
  }
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

// Stream returns for a universe. onData(sym) fires as each coin lands; leaders are fetched first.
async function streamUniverse(symbols, granularity, target, token, onData, onProgress) {
  let done = 0;
  const queue = symbols.slice();
  async function worker() {
    while (queue.length) {
      if (token !== scanToken) return;         // a newer scan started — abandon this one
      const sym = queue.shift();
      const key = `${sym}|${granularity}`;
      let returns = CACHE.get(key);
      if (!returns) {
        const closes = await fetchCandles(sym, granularity);
        if (closes) { returns = toReturns(closes); CACHE.set(key, returns); }
      }
      if (token !== scanToken) return;
      if (returns) { target.set(sym, returns); onData(sym); }
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
  return parts.join(' ') + ' behind';
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
    el.body.innerHTML = `<tr><td colspan="7" class="empty">No laggards cleared the ${minConf}% bar yet. Lower the filter or try another timeframe.</td></tr>`;
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
    </tr>`;
  }).join('');
}

// ------------------------------- SCAN -------------------------------
let scanning = false;
async function scan() {
  const token = ++scanToken;   // invalidate any in-flight older scan
  scanning = true;
  el.refresh.disabled = true;
  setStatus('working', 'Scanning…');
  el.progress.classList.remove('hidden');

  const tf = CONFIG.timeframes[el.timeframe.value];
  const returns = new Map();
  ROWS = [];
  render();

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
      el.coinCount.textContent = `${returns.size} coins analyzed · ${ROWS.length} laggards`;
    };
    if (force) { if (pending) { clearTimeout(pending); pending = null; } run(); return; }
    // All-pairs is O(n²) over ~400 coins — too heavy to recompute mid-stream, so it only
    // runs on the final pass. Leaders mode is cheap and updates live.
    if (el.mode.value === 'pairs') return;
    dirty = true;
    const since = performance.now() - lastRun;
    if (since >= CONFIG.reanalyzeMs) run();
    else if (!pending) pending = setTimeout(() => { if (dirty) run(); }, CONFIG.reanalyzeMs - since);
  };

  try {
    const [avail, ranked] = await Promise.all([loadAvailable(), loadRanked()]);
    if (token !== scanToken) return;

    // Order the field by liquidity (CoinGecko volume rank), keep only coins live on Coinbase,
    // drop stablecoins, and cap at maxCoins. Leaders always go first. If the ranking call
    // failed, fall back to Coinbase's full list alphabetically.
    const order = ranked && ranked.length ? ranked : Array.from(avail).sort();
    const rest = order.filter((s) => avail.has(s) && !CONFIG.leaders.includes(s) && !CONFIG.exclude.has(s));
    const universe = [...CONFIG.leaders.filter((l) => avail.has(l)), ...rest].slice(0, CONFIG.maxCoins);

    el.progressText.textContent = `0 / ${universe.length} coins`;
    await streamUniverse(
      universe, tf.granularity, returns, token,
      () => reanalyze(false),
      (done, total, sym) => {
        if (token !== scanToken) return;
        el.progressFill.style.width = `${(done / total) * 100}%`;
        el.progressText.textContent = `${done} / ${total} — ${sym}`;
      }
    );
    if (token !== scanToken) return;

    reanalyze(true); // final, authoritative pass
    el.lastUpdated.textContent = 'Updated ' + new Date().toLocaleTimeString();
    setStatus('live', 'Live');
  } catch (e) {
    if (token !== scanToken) return;
    setStatus('error', 'Error');
    if (!ROWS.length) {
      el.body.innerHTML = `<tr><td colspan="7" class="empty">Scan failed: ${e.message}. Coinbase may be rate-limiting — wait a moment and scan again.</td></tr>`;
    }
  } finally {
    if (token === scanToken) {
      el.progress.classList.add('hidden');
      el.refresh.disabled = false;
      scanning = false;
    }
  }
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
  el.refresh.addEventListener('click', () => { CACHE.clear(); scan(); }); // force fresh prices
  setStatus('', 'Idle');
  scan(); // auto-run on load
}
init();
