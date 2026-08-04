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
- **The Gemini key is intentionally in the client.** Free tier, no billing
  attached — the owner's explicit choice. It is base64-wrapped only because
  GitHub push protection blocks the literal string. Same for `scripts/ai-queue.mjs`.
- **AI text is untrusted.** Always render it through `aiHtml()` (escape first,
  then format), never raw into `innerHTML`.
