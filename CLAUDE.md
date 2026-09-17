# Oregon Hunt Planner — working notes

Single-file PWA (`index.html`) for Oregon controlled-hunt draw odds and harvest
data. Family-only app. Firestore backend (compat SDK, no auth by design).
GitHub Pages serves **directly from `main`** — there is no build step, so
whatever is on `main` is what the family sees.

## Shipping (standing instruction from the owner)

- **Merge to `main` and push at the end of every turn.** The owner gave
  standing permission for this. Work still happens on the assigned feature
  branch, but a turn is not finished until it is merged into `main` and pushed
  — otherwise the change is invisible on the live site.
- **Do not re-run the full test suite against merged `main` as a pre-push
  gate.** Testing belongs in development, where it catches things; repeating
  the whole battery after the merge was redundant and slow. Still verify work
  while building it, just don't gate the merge on a second full run.
- Bump the version chip in the header (`class="ver"`) and the `CACHE` constant
  in `sw.js` when shipping user-visible changes, so the service worker rolls
  over and the owner can tell at a glance which build they're looking at.
- **Start each turn by returning to the feature branch**, since the previous
  turn's merge leaves you on `main`:
  `git checkout <branch> && git merge --ff-only main`. Editing first and
  switching later means `git checkout` refuses (or a stash pop conflicts),
  because the branch tip is behind the merge commit.

## Layout

- `index.html` — the entire app: styles, markup, and one inline script.
  Notable sections are marked with `─── BANNER ───` comments.
- `sw.js` — offline service worker. Network-first for the page, cache-first for
  assets, never caches Firestore or Gemini.
- `scripts/fetch-odfw.mjs` — monthly ODFW scraper (draw XLSX + harvest PDF).
- `scripts/ai-queue.mjs` — headless Gemini queue drainer for the nightly Action.
- `scripts/scrape-synopsis.py` — pulls yellow-highlighted changes out of the
  Big Game Synopsis PDF.

## Things that will bite you

- **Derived-value cache.** `grade`/`blendHarvest`/`trendData`/`specialKeys` and
  friends are memoised behind `invalidate()`. Anything that mutates `S.years`,
  `P`, or the stored tag definitions must call it — `saveLocal()` and
  `savePrefs()` already do.
- **localStorage is near its limit.** Four seasons is ~5 MB against a ~5 MB
  quota; `saveLocal()` trims the oldest seasons rather than failing silently.
- **Gemini model choice is the whole ballgame on the free tier.** `AI_MODELS`
  is a ladder tried in order, dropping to the next on 503/404. Measured live:
  `gemini-flash-latest` returned 503 "experiencing high demand" on essentially
  every real prompt (47s to fail) and refused every grounded call with a 429 —
  which is why nightly runs managed ~4 answers against a 1,600-item queue.
  `gemini-2.5-flash` answers AND grounds fine on the same key. Never assume a
  429/503 means "out of quota": probe the API before concluding anything.
- **Quota is per MODEL, not just per key — including "daily".** A 429 whose
  QuotaFailure names PerDay applies to that model, not the key: the key that
  reported a daily limit answered fine on the same model a minute later and on
  another model immediately. So `aiCallKey` walks the ladder on 429 as well as
  503, and only when EVERY model is out does `keyOffN` get stamped. Getting
  this wrong benches the family's only working key for a day it could still be
  answering — it happened twice while building this.
- **Grounding refusal is per (key, model) and runtime-only** (`_aiGroundOut`).
  Never persist it as a per-key day-marker: gemini-2.5-flash grounds fine on
  the same key flash-lite refuses, and the sourced research is the point.
- **Counts come from `:runAggregationQuery`, not from a page of docs.** The
  queue runs to four figures; the first cut of the progress view fed a
  `limit(300)` snapshot into the coverage maths and reported ~1,300 queued
  questions as "not asked" with an ETA 5x too rosy. `FB_CONFIG` exists so REST
  endpoints the compat SDK doesn't expose can reuse the project and key.
- **`keyDeadN` is permanent, `keyOffN` clears daily.** A 403 "project has been
  denied access" never recovers; benching it as a day-marker meant re-probing a
  dead key forever while the panel claimed it was "running on the next key".
- **The nightly run reports through `ai_log`, not console.log.** The GitHub
  Actions log is invisible to the owner. One summary row per run, plus a
  `meta/aiPulse` heartbeat so a run killed by the 55-minute timeout is
  distinguishable from one that never fired. Only the Action prunes `ai_log` —
  a phone-side pruner would read 200 docs per drain pass and race other devices.
- **The Gemini key is intentionally in the client.** Free tier, no billing
  attached — the owner's explicit choice. It is base64-wrapped only because
  GitHub push protection blocks the literal string. Same for `scripts/ai-queue.mjs`.
- **AI text is untrusted.** Always render it through `aiHtml()` (escape first,
  then format), never raw into `innerHTML`.
