# Slipstream Worker (Path B backend)

A Cloudflare Worker that runs on a **cron every 10 minutes**, computes the 1-hour lead-lag
leaderboard, diffs it against the previous run, and records **signals** — matches that just
crossed a confidence threshold. The front-end reads these from `/api/signals` and shows a
"📡 Signals" panel, so you can see what happened while you were away.

The main site keeps working with or without this Worker. Until you set `workerBase` in the
front-end (see step 5), the signals panel simply stays hidden — zero impact.

## Endpoints

- `GET /api/signals` — `{ updatedAt, signals: [...] }`
- `GET /api/health`  — `{ ok, updatedAt, coins, board, runs }`
- `GET /api/refresh` — runs the compute once now (use it to seed KV right after deploying)

## Setup — no Node required (Cloudflare dashboard)

1. **Create a KV namespace.** Dashboard → *Storage & Databases → KV → Create* → name it
   `slipstream-snapshots`.
2. **Create the Worker.** Dashboard → *Workers & Pages → Create → Worker*. Name it
   `slipstream-worker`, deploy the default, then *Edit code*, delete the template, and paste
   the entire contents of [`src/index.js`](src/index.js). Save & deploy.
   - *(Or connect this GitHub repo via Workers Builds and point it at the `worker/` directory —
     then it deploys on every push.)*
3. **Bind the KV namespace.** Worker → *Settings → Bindings → Add → KV namespace*.
   Variable name **must be** `SNAPSHOTS`; pick the namespace from step 1.
4. **Add the cron trigger.** Worker → *Settings → Triggers → Cron Triggers → Add* → `*/10 * * * *`.
5. **Point the front-end at it.** Copy the Worker's URL
   (e.g. `https://slipstream-worker.<your-subdomain>.workers.dev`) and set it as
   `CONFIG.workerBase` at the top of the site's `app.js`. Commit & push.
6. **Seed it.** Visit `https://<worker-url>/api/refresh` once so there's data before the first
   cron fires. `/api/health` should then show a recent `updatedAt`.

## Setup — with wrangler (if you install Node later)

```bash
cd worker
npm install
npx wrangler kv namespace create SNAPSHOTS   # paste the id into wrangler.toml
npx wrangler deploy
```

## Notes

- Free plan is fine: Workers cron + KV are included.
- `/api/refresh` is open so you can seed KV easily. It only recomputes and overwrites KV
  (cheap, idempotent). Set a secret gate later if you want to lock it down.
- Signals currently fire when a coin's best-leader match crosses **55%** confidence with a
  non-zero lag. Tune `CROSS_T` in `src/index.js`.
