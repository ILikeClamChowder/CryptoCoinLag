/* Slipstream Worker — Path B backend
 *
 * Runs on a cron trigger every ~10 minutes: pulls the market data, computes the 1-hour
 * lead-lag leaderboard, DIFFS it against the previous run, and records "signals" — matches
 * that just crossed a confidence threshold. Serves those signals to the front-end.
 *
 * Single-file ES-module Worker: no build step. Paste into the Cloudflare dashboard editor,
 * or deploy the repo via Workers Builds / wrangler. Needs one KV namespace bound as SNAPSHOTS.
 * See worker/README.md for setup.
 */

const GECKO = 'https://api.coingecko.com/api/v3/coins/markets'
  + '?vs_currency=usd&order=volume_desc&per_page=250&page=1&sparkline=true';

const LEADERS = ['BTC', 'ETH', 'SOL'];
const EXCLUDE = new Set([
  'USDT', 'USDC', 'DAI', 'PYUSD', 'GUSD', 'USDP', 'PAX', 'BUSD', 'UST', 'USTC',
  'LUSD', 'USDD', 'EURC', 'EUROC', 'GYEN', 'RLUSD', 'WBTC', 'CBETH', 'CBBTC',
  'USD1', 'USDS', 'FDUSD', 'USDE', 'USDG', 'USDR', 'EURT', 'PAXG', 'XAUT',
]);

const MAX_COINS = 120;
const MAX_LAG = 24;      // hourly candles (7d sparkline)
const MIN_OVERLAP = 40;
const CROSS_T = 55;      // confidence % that fires a "crossed up" signal
const SIGNAL_CAP = 40;   // keep the most recent N signals
const GRANULARITY = 3600;

// ------------------------------- MATH (ported from the front-end) -------------------------------
function toReturns(closes) {
  const r = new Array(closes.length - 1);
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    r[i - 1] = prev ? (closes[i] - prev) / prev : 0;
  }
  return r;
}

function corrAtLag(rx, rl, k) {
  const n = Math.min(rx.length, rl.length);
  const m = n - k;
  if (m < MIN_OVERLAP) return NaN;
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

function scoreCurve(rx, rl) {
  let peakCorr = -Infinity, peakLag = 0, sum = 0, count = 0;
  for (let k = 0; k <= MAX_LAG; k++) {
    const c = corrAtLag(rx, rl, k);
    if (Number.isNaN(c)) continue;
    sum += c; count++;
    if (c > peakCorr) { peakCorr = c; peakLag = k; }
  }
  if (count === 0 || peakCorr <= 0) return { confidence: 0, peakCorr: 0, peakLag: 0 };
  const mean = sum / count;
  const strength = Math.min(1, peakCorr);
  const sharp = Math.min(1, Math.max(0, (peakCorr - mean) / 0.30));
  const lagFactor = peakLag === 0 ? 0.35 : 1;
  const confidence = 100 * Math.pow(strength, 1.5) * (0.35 + 0.65 * sharp) * lagFactor;
  return { confidence: Math.round(confidence * 10) / 10, peakCorr, peakLag };
}

function analyzeLeaders(returns) {
  const rows = [];
  const leaders = LEADERS.filter((l) => returns.has(l));
  for (const [sym, rx] of returns) {
    if (LEADERS.includes(sym)) continue;
    let best = null;
    for (const L of leaders) {
      const s = scoreCurve(rx, returns.get(L));
      if (!best || s.confidence > best.confidence) best = { ...s, coin: sym, leader: L };
    }
    if (best && best.confidence > 0) rows.push(best);
  }
  return rows.sort((a, b) => b.confidence - a.confidence);
}

// ------------------------------- DATA -------------------------------
async function fetchMarkets(env) {
  const headers = { accept: 'application/json' };
  // Optional: if CoinGecko rate-limits Cloudflare's shared IPs, add a free demo key as a
  // Worker secret named COINGECKO_KEY (Settings > Variables) and it'll be used automatically.
  if (env && env.COINGECKO_KEY) headers['x-cg-demo-api-key'] = env.COINGECKO_KEY;
  const res = await fetch(GECKO, { headers });
  if (!res.ok) throw new Error('coingecko HTTP ' + res.status);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('coingecko: unexpected payload');
  return data;
}

function buildReturns(markets) {
  const map = new Map();
  const seen = new Set();
  for (const m of markets) {
    const sym = (m.symbol || '').toUpperCase();
    const prices = m.sparkline_in_7d && m.sparkline_in_7d.price;
    if (!sym || seen.has(sym) || EXCLUDE.has(sym)) continue;
    if (!Array.isArray(prices) || prices.length < MIN_OVERLAP + 5) continue;
    seen.add(sym);
    map.set(sym, toReturns(prices));
    if (map.size >= MAX_COINS) break;
  }
  return map;
}

// ------------------------------- COMPUTE + DIFF -------------------------------
async function runCompute(env) {
  const markets = await fetchMarkets(env);
  const returns = buildReturns(markets);
  const board = analyzeLeaders(returns);
  const now = new Date().toISOString();

  // Diff against the previous board to detect matches that just crossed the threshold.
  const prevRaw = await env.SNAPSHOTS.get('board:1h:leaders');
  const prev = prevRaw ? JSON.parse(prevRaw) : [];
  const prevMap = new Map(prev.map((r) => [r.coin, r]));

  const fresh = [];
  for (const r of board) {
    const prevConf = prevMap.has(r.coin) ? prevMap.get(r.coin).confidence : 0;
    if (r.confidence >= CROSS_T && prevConf < CROSS_T && r.peakLag > 0) {
      fresh.push({
        coin: r.coin, leader: r.leader,
        confidence: r.confidence, prevConfidence: prevConf,
        peakLag: r.peakLag, at: now,
      });
    }
  }

  const sigRaw = await env.SNAPSHOTS.get('signals');
  const signals = [...fresh, ...(sigRaw ? JSON.parse(sigRaw) : [])].slice(0, SIGNAL_CAP);

  const slim = board.map((r) => ({ coin: r.coin, leader: r.leader, confidence: r.confidence, peakLag: r.peakLag }));
  const prevMeta = await env.SNAPSHOTS.get('meta');
  const runs = (prevMeta ? JSON.parse(prevMeta).runs || 0 : 0) + 1;

  await env.SNAPSHOTS.put('board:1h:leaders', JSON.stringify(slim));
  await env.SNAPSHOTS.put('signals', JSON.stringify(signals));
  await env.SNAPSHOTS.put('meta', JSON.stringify({ updatedAt: now, coins: returns.size, board: board.length, runs, newSignals: fresh.length }));

  return { updatedAt: now, coins: returns.size, board: board.length, newSignals: fresh.length };
}

// ------------------------------- HTTP -------------------------------
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,OPTIONS',
  'access-control-allow-headers': 'content-type',
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...CORS } });

export default {
  // Cron trigger — see [triggers].crons in wrangler.toml.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCompute(env).catch((e) => console.error('compute failed:', e)));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
    try {
      if (url.pathname === '/api/signals') {
        const [sig, meta] = await Promise.all([env.SNAPSHOTS.get('signals'), env.SNAPSHOTS.get('meta')]);
        return json({ updatedAt: meta ? JSON.parse(meta).updatedAt : null, signals: sig ? JSON.parse(sig) : [] });
      }
      if (url.pathname === '/api/health') {
        const meta = await env.SNAPSHOTS.get('meta');
        return json({ ok: true, ...(meta ? JSON.parse(meta) : { runs: 0 }) });
      }
      if (url.pathname === '/api/refresh') {
        // Manual trigger — seed KV right after deploy without waiting for the cron.
        const res = await runCompute(env);
        return json({ ok: true, ...res });
      }
      return json({ error: 'not found', endpoints: ['/api/signals', '/api/health', '/api/refresh'] }, 404);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  },
};
