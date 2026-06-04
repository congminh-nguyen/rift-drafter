"""Curated champion traits that power the adaptive recommendation rules.

These are the high-value signals the engine uses to read an enemy composition:
  - damage type   -> what defensive stat your squishies want (armor vs MR)
  - tankiness     -> whether to add %health / armor-pen / anti-tank
  - healing       -> whether to add anti-heal (Grievous Wounds)
  - hard CC       -> whether to add tenacity (Mercury's / Quicksilver)
  - shielding     -> whether to add anti-shield (Serpent's Fang etc.)

This is intentionally a hand-maintained knowledge base: it is the domain layer
that makes recommendations smart. Anything not listed falls back to AD / no flag,
which is safe (it simply won't trigger a specialised rule).

Run `python scraper/traits.py` to (re)generate data/traits.json.
"""
from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

# --- Primary damage type ----------------------------------------------------
AP = {
    "ahri", "akali", "amumu", "annie", "aurelion-sol", "aurora", "brand", "diana",
    "ekko", "evelynn", "fiddlesticks", "fizz", "galio", "gragas", "gwen",
    "heimerdinger", "karma", "kassadin", "katarina", "kennen", "lillia",
    "lissandra", "lulu", "lux", "mel", "milio", "mordekaiser", "morgana", "nami",
    "norra", "orianna", "rumble", "ryze", "seraphine", "singed", "sona", "soraka",
    "swain", "syndra", "taliyah", "teemo", "twisted-fate", "veigar", "vel-koz",
    "vex", "viktor", "vladimir", "zilean", "zoe", "zyra", "ziggs", "nunu-willump",
}
MIXED = {
    "aatrox", "ezreal", "jayce", "kog-maw", "kai-sa", "nidalee", "shyvana",
    "kayle", "corki", "varus", "yone", "volibear", "warwick",
}
# everything else defaults to AD (physical)

# --- Tanks / heavy frontline -----------------------------------------------
TANK = {
    "alistar", "amumu", "braum", "dr-mundo", "galio", "gragas", "k-sante",
    "leona", "malphite", "maokai", "nautilus", "nunu-willump", "ornn", "poppy",
    "rammus", "rell", "shen", "shyvana", "sion", "singed", "thresh", "volibear",
    "blitzcrank", "sett", "zac",
}

# --- Significant healing / lifesteal / sustain (anti-heal targets) ----------
HEALING = {
    "soraka", "sona", "nami", "yuumi", "milio", "seraphine", "vladimir", "swain",
    "dr-mundo", "warwick", "aatrox", "fiora", "nilah", "olaf", "tryndamere",
    "master-yi", "senna", "kayn", "sett", "gwen", "ryze", "darius", "renekton",
    "maokai",
}

# --- Hard CC (stun / root / knockup / suppress -> tenacity matters) ---------
HARD_CC = {
    "alistar", "amumu", "annie", "ashe", "blitzcrank", "brand", "braum", "camille",
    "diana", "fiddlesticks", "galio", "gnar", "gragas", "hecarim", "irelia",
    "jarvan-iv", "jax", "kennen", "leona", "lissandra", "lux", "malphite",
    "maokai", "morgana", "nami", "nautilus", "nocturne", "nunu-willump", "ornn",
    "pantheon", "poppy", "pyke", "rakan", "rammus", "rell", "riven", "sett",
    "seraphine", "singed", "sion", "sona", "swain", "syndra", "taliyah", "thresh",
    "twisted-fate", "urgot", "varus", "veigar", "vex", "vi", "volibear", "warwick",
    "wukong", "xin-zhao", "zoe", "zyra", "k-sante", "ambessa", "neeko",
}

# --- Shields (anti-shield targets) -----------------------------------------
SHIELD = {
    "janna", "karma", "lulu", "seraphine", "orianna", "morgana", "milio", "sona",
    "riven", "diana", "sett", "camille", "shen", "lux", "nilah", "renata",
}


def trait_for(slug: str) -> dict:
    if slug in AP:
        dmg = "AP"
    elif slug in MIXED:
        dmg = "mixed"
    else:
        dmg = "AD"
    return {
        "damage": dmg,
        "tank": slug in TANK,
        "healing": slug in HEALING,
        "hardCC": slug in HARD_CC,
        "shield": slug in SHIELD,
    }


def build_traits(slugs: list[str]) -> dict:
    return {slug: trait_for(slug) for slug in slugs}


def main() -> int:
    champ_file = ROOT / "docs" / "data" / "champions.json"
    if champ_file.exists():
        data = json.loads(champ_file.read_text(encoding="utf-8"))
        slugs = sorted(data.get("champions", {}).keys())
    else:
        # Fall back to fetching the roster from the sitemap.
        import sys
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import scrape
        slugs = scrape.champion_slugs()

    traits = build_traits(slugs)
    out = ROOT / "docs" / "data" / "traits.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(traits, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"Wrote traits for {len(traits)} champions to {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
