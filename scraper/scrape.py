"""WildRiftCore scraper.

Pulls every champion's build + matchup data into data/champions.json.
Designed to run unattended (e.g. a daily GitHub Action). Polite by default:
a small delay between requests, retries with backoff, and an on-disk HTML cache
so re-runs during development don't hammer the source site.

Usage:
    python scraper/scrape.py                 # full run
    python scraper/scrape.py --limit 5       # quick test on 5 champions
    python scraper/scrape.py --only ahri,zed # specific champions
    python scraper/scrape.py --no-cache      # bypass local HTML cache
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import requests

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import parse as P  # noqa: E402

BASE = "https://wildriftcore.com"
SITEMAP = f"{BASE}/sitemap.xml"
ROOT = Path(__file__).resolve().parent.parent
DOCS_DIR = ROOT / "docs"
DATA_DIR = DOCS_DIR / "data"
CACHE_DIR = Path(__file__).resolve().parent / ".cache"
HEADERS = {
    "User-Agent": "WildRiftTeamBuildBot/1.0 (private team tool; respectful crawl)",
    "Accept-Language": "en",
}
DELAY_S = 0.4  # polite gap between requests


def get(url: str, use_cache: bool = True) -> str | None:
    cache_key = re.sub(r"[^a-z0-9]+", "_", url.lower()).strip("_") + ".html"
    cache_file = CACHE_DIR / cache_key
    if use_cache and cache_file.exists():
        return cache_file.read_text(encoding="utf-8")

    for attempt in range(3):
        try:
            r = requests.get(url, headers=HEADERS, timeout=20)
            if r.status_code == 200:
                CACHE_DIR.mkdir(parents=True, exist_ok=True)
                cache_file.write_text(r.text, encoding="utf-8")
                time.sleep(DELAY_S)
                return r.text
            if r.status_code == 404:
                return None
        except requests.RequestException as e:
            print(f"  ! {url} attempt {attempt+1} failed: {e}", file=sys.stderr)
        time.sleep(1.5 * (attempt + 1))
    return None


def download_asset(src: str) -> str:
    """Download a WildRiftCore /assets/... image into docs/ and return a
    site-relative path. Images are served with cross-origin-resource-policy
    same-site, so they cannot be hotlinked — we must self-host them.
    Returns the original src unchanged for non-asset/external URLs."""
    if not src or not src.startswith("/assets/"):
        return src
    rel = src.lstrip("/")  # e.g. assets/images/newItems/x.webp
    dest = DOCS_DIR / rel
    if dest.exists():
        return rel
    try:
        r = requests.get(BASE + src, headers=HEADERS, timeout=20)
        if r.status_code == 200 and r.content:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(r.content)
            time.sleep(0.05)
    except requests.RequestException:
        pass
    return rel  # keep the path even on failure; the UI hides broken images


def rewrite_assets(node) -> int:
    """Walk the scraped structure, downloading every `img` and rewriting it to
    a local relative path. Returns the number of assets processed."""
    count = 0
    if isinstance(node, dict):
        for k, v in node.items():
            if k == "img" and isinstance(v, str):
                node[k] = download_asset(v)
                count += 1
            else:
                count += rewrite_assets(v)
    elif isinstance(node, list):
        for item in node:
            count += rewrite_assets(item)
    return count


def champion_slugs(use_cache: bool = True) -> list[str]:
    xml = get(SITEMAP, use_cache=use_cache)
    if not xml:
        raise RuntimeError("Could not fetch sitemap")
    slugs = re.findall(r"https://wildriftcore\.com/en/champions/([a-z0-9-]+)/", xml)
    # Drop sub-pages like .../ahri/builds (those have an extra path segment, so
    # the regex above only captures the slug — dedupe and remove non-champ words).
    blacklist = {"builds"}
    out = sorted({s for s in slugs if s not in blacklist})
    return out


def detect_patch(html: str) -> str:
    m = re.search(r"Patch\s+([0-9]+\.[0-9]+[a-z]?)", html or "")
    return m.group(1) if m else ""


def scrape_champion(slug: str, use_cache: bool = True) -> dict | None:
    overview_html = get(f"{BASE}/en/champions/{slug}/", use_cache=use_cache)
    if not overview_html:
        return None
    builds_html = get(f"{BASE}/en/champions/{slug}/builds/", use_cache=use_cache)

    overview = P.parse_overview(overview_html)
    full = P.parse_full_build(builds_html) if builds_html else {}

    name = _display_name(overview_html, slug)

    champ = {
        "slug": slug,
        "name": name,
        "roles": overview.get("roles", []),
        "intent": overview.get("intent", ""),
        "core": full.get("core") or overview.get("core", []),
        "starter": full.get("starter", []),
        "finalBuild": full.get("finalBuild", []),
        "boots": full.get("boots") or overview.get("boots", []),
        "enchant": full.get("enchant", []),
        "skillOrder": full.get("skillOrder", []),
        "runes": full.get("runes", {"keystone": None, "list": []}),
        "situational": full.get("situational", []),
        "matchups": overview.get("matchups", {"counters": [], "synergies": []}),
        "patch": detect_patch(builds_html) or detect_patch(overview_html),
    }
    return champ


def _display_name(html: str, slug: str) -> str:
    m = re.search(r"<title>([^<|]+)", html or "")
    if m:
        title = m.group(1).strip()
        # Titles look like "Ahri Wild Rift Build ..." -> take leading champ name.
        name = re.split(r"\bWild Rift\b", title)[0].strip(" -—|")
        if name:
            return name
    return slug.replace("-", " ").title()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="only scrape first N champions")
    ap.add_argument("--only", type=str, default="", help="comma-separated slugs to scrape")
    ap.add_argument("--no-cache", action="store_true", help="bypass local HTML cache")
    args = ap.parse_args()
    use_cache = not args.no_cache

    slugs = champion_slugs(use_cache=use_cache)
    if args.only:
        wanted = {s.strip() for s in args.only.split(",") if s.strip()}
        slugs = [s for s in slugs if s in wanted]
    if args.limit:
        slugs = slugs[: args.limit]

    print(f"Scraping {len(slugs)} champions...")
    champions = []
    patch = ""
    failures = []
    for i, slug in enumerate(slugs, 1):
        try:
            champ = scrape_champion(slug, use_cache=use_cache)
        except Exception as e:  # never let one bad page kill the run
            print(f"[{i}/{len(slugs)}] {slug}: ERROR {e}", file=sys.stderr)
            failures.append(slug)
            continue
        if not champ:
            print(f"[{i}/{len(slugs)}] {slug}: not found", file=sys.stderr)
            failures.append(slug)
            continue
        patch = patch or champ.get("patch", "")
        n_final = len(champ["finalBuild"])
        n_sit = len(champ["situational"])
        print(f"[{i}/{len(slugs)}] {champ['name']}: {n_final} items, {n_sit} situational")
        champions.append(champ)

    print("\nDownloading item / rune assets locally...")
    n_assets = rewrite_assets(champions)
    print(f"Processed {n_assets} asset references.")

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    payload = {
        "meta": {
            "source": BASE,
            "patch": patch,
            "scrapedAt": datetime.now(timezone.utc).isoformat(),
            "championCount": len(champions),
            "failures": failures,
        },
        "champions": {c["slug"]: c for c in champions},
    }
    out_file = DATA_DIR / "champions.json"
    out_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nWrote {len(champions)} champions to {out_file} (patch {patch or '?'})")
    if failures:
        print(f"Failures ({len(failures)}): {', '.join(failures)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
