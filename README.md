# Rift Drafter — Adaptive Wild Rift Team Builds

An internal team tool. Enter both teams (your 5 + the enemy 5) and get an
**adaptive build for every champion on your side** — items, boots, enchant,
runes, skill order, situational substitutions, and team-wide strategic reasoning.

Unlike a static build site, recommendations **react to the exact enemy
composition**: heavy enemy healing surfaces anti-heal, a tanky frontline
surfaces %health / armor-pen, heavy CC surfaces tenacity, and so on.

Build data is scraped daily from [WildRiftCore](https://wildriftcore.com); the
adaptive layer and all reasoning are generated locally.

---

## How it works

```
scraper/scrape.py        -> downloads every champion's build + matchup wall
   (daily, GitHub Action)    from WildRiftCore, self-hosts item/rune images,
                             writes docs/data/champions.json
scraper/traits.py        -> curated champion traits (damage type, tank,
                             healing, hard CC, shield) -> docs/data/traits.json
docs/ (static site)      -> loads the JSON, you pick 5v5, the in-browser
                             engine (engine.js) produces adaptive builds
```

No backend, no server, no API keys. The site is 100% static — it just fetches
two JSON files and runs the recommendation engine in the browser.

### The adaptive engine (`docs/engine.js`)
1. Reads the enemy 5 and computes a **composition profile** (AP/AD split, tank
   count, healers, CC count, shielders).
2. For each of your champions, it:
   - shows the base WildRiftCore build (final items, boots, enchant, runes, skills);
   - **surfaces that champion's own situational items** whose context matches the
     enemy comp (e.g. "vs Healing", "vs Tanks");
   - adds **rule-based fallback advice** (anti-heal / anti-tank / tenacity /
     resist / anti-shield) when the champion has no matching situational card;
   - flags **direct matchups** (counters present on the enemy team) and
     **synergies** with your own team from the scraped matchup wall;
   - reports a **confidence** label based on data completeness.

The domain knowledge that makes it "smart" lives in `scraper/traits.py` — edit
those sets to refine which champions count as healers / tanks / CC / shields.

---

## Run it locally

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# 1. Scrape build data + download item/rune images (~2 min, polite crawl)
python scraper/scrape.py
python scraper/traits.py

# 2. Serve the static site (a plain file:// open will NOT work — fetch needs HTTP)
cd docs && python3 -m http.server 8765
# open http://localhost:8765
```

Useful scraper flags:

```bash
python scraper/scrape.py --only ahri,zed   # just a couple champions
python scraper/scrape.py --limit 5         # first 5 champions
python scraper/scrape.py --no-cache        # bypass the local HTML cache
```

---

## Host it for free (everyone hits the same live tool)

This repo is built to publish on **GitHub Pages** from the `docs/` folder, with a
**daily GitHub Action** that re-scrapes and commits fresh build data.

1. Push this repo to GitHub.
2. **Settings → Pages → Build and deployment → Deploy from a branch**, choose
   `main` branch and the `/docs` folder. Your tool is live at
   `https://<user>.github.io/<repo>/`.
3. The workflow in `.github/workflows/daily-update.yml` runs every day at
   06:00 UTC (and on-demand via **Actions → Daily build update → Run workflow**).
   It re-scrapes, downloads any new patch assets, and commits to `docs/data` +
   `docs/assets`; Pages redeploys automatically.

That's it — free hosting, free daily updates, no server to maintain.

---

## Updating each patch
Nothing manual is required: WildRiftCore updates per patch and the daily Action
picks it up. If you want to refine the *adaptive* layer (e.g. a champion was
reworked into a healer), edit the trait sets in `scraper/traits.py` and re-run
`python scraper/traits.py`.

---

## Notes & limitations
- Data is sourced from WildRiftCore for **private team use**; item/rune images
  are self-hosted because their CDN sets `cross-origin-resource-policy: same-site`.
  Be respectful of their bandwidth (the scraper rate-limits itself). Not
  affiliated with Riot Games or WildRiftCore.
- Champion *traits* are a hand-maintained knowledge base — accurate for the
  high-impact signals (healers, tanks, CC, shields) but not exhaustive. Anything
  unlisted simply won't trigger a specialised rule (safe default).
- The engine reuses WildRiftCore's per-champion situational recommendations and
  filters them to the actual matchup; it does not (yet) learn from match data.
