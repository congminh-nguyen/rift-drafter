"""HTML parsers for WildRiftCore champion pages.

Two pages are parsed per champion:
  - /en/champions/{slug}/         -> overview (intent, core, boots, matchup wall)
  - /en/champions/{slug}/builds/  -> full build (items, runes, enchant, situational)

Parsing is defensive: the site is hand-maintained SSG markup, so every selector
is wrapped so a layout tweak degrades gracefully instead of crashing the run.
"""
from __future__ import annotations

import re
from bs4 import BeautifulSoup


def _soup(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")


def _txt(node) -> str:
    return re.sub(r"\s+", " ", node.get_text(" ", strip=True)).strip() if node else ""


def _img_name(img) -> str:
    """Best-effort item/rune name from an <img> alt attribute."""
    return (img.get("alt") or "").strip() if img else ""


def _slug_from_href(href: str) -> str:
    if not href:
        return ""
    parts = [p for p in href.strip("/").split("/") if p]
    return parts[-1] if parts else ""


_LANE_MAP = {
    "baron": "baron", "top": "baron",
    "jungle": "jungle", "jg": "jungle",
    "mid": "mid",
    "adc": "adc", "bot": "adc", "dragon": "adc",
    "support": "support", "sup": "support",
}
_LANE_ORDER = ["baron", "jungle", "mid", "adc", "support"]


def _normalize_lanes(raw) -> list:
    """Map messy data-lane strings to the five canonical lanes, dropping
    combined values like 'sup mid baron'."""
    found = set()
    for r in raw:
        r = (r or "").strip().lower()
        if " " in r:  # combined filter labels are not real single lanes
            continue
        m = _LANE_MAP.get(r)
        if m:
            found.add(m)
    return [l for l in _LANE_ORDER if l in found]


# ---------------------------------------------------------------------------
# Overview page: /en/champions/{slug}/
# ---------------------------------------------------------------------------
def parse_overview(html: str) -> dict:
    s = _soup(html)
    out: dict = {"intent": "", "core": [], "boots": [], "roles": [], "matchups": {}}

    intent = s.select_one(".build__intent")
    out["intent"] = _txt(intent)

    for slot in s.select(".build__row[aria-label='Core'] .build__slot"):
        label = slot.select_one(".build__slot__lbl")
        img = slot.find("img")
        name = _txt(label) or _img_name(img)
        if name:
            out["core"].append({"name": name, "img": (img.get("src") if img else "")})

    for pair in s.select(".build__boots .build__boots__pair"):
        name = _txt(pair.find("span"))
        if name:
            out["boots"].append(name)

    # Champion's primary role(s): inferred from the lanes referenced on the page,
    # normalised to the five canonical Wild Rift lanes.
    raw = set()
    for el in s.select("[data-lane]"):
        lane = el.get("data-lane")
        if lane and lane != "all":
            raw.add(lane)
    out["roles"] = _normalize_lanes(raw)

    out["matchups"] = _parse_matchup_wall(s)
    return out


_TIER_MAP = {
    "hard": "hard",
    "unfav": "unfavorable",
    "skill": "skill",
    "fav": "favorable",
    "syn": "synergy",
}


def _parse_matchup_wall(s: BeautifulSoup) -> dict:
    counters: list = []
    synergies: list = []
    for cell in s.select(".wall__cell"):
        classes = cell.get("class", [])
        tier = None
        for c in classes:
            if c.startswith("wall__cell--"):
                tier = _TIER_MAP.get(c.replace("wall__cell--", ""))
        section = cell.get("data-section", "")
        name = _txt(cell.select_one(".wall__cell__n"))
        note = _txt(cell.select_one(".wall__cell__note"))
        lane = cell.get("data-lane", "")
        slug = _slug_from_href(cell.get("href", ""))
        if not name:
            continue
        entry = {"name": name, "slug": slug, "tier": tier, "note": note, "lane": lane}
        if section == "synergies" or tier == "synergy":
            synergies.append(entry)
        else:
            counters.append(entry)
    return {"counters": counters, "synergies": synergies}


# ---------------------------------------------------------------------------
# Full build page: /en/champions/{slug}/builds/
# ---------------------------------------------------------------------------
_BOOT_WORDS = ("boots", "treads", "shoes", "steps", "greaves", "tabi", "sabre")


def _looks_like_boots(name: str) -> bool:
    n = name.lower()
    return any(w in n for w in _BOOT_WORDS)


def parse_full_build(html: str) -> dict:
    s = _soup(html)
    out: dict = {
        "starter": [],
        "core": [],
        "finalBuild": [],
        "boots": [],
        "enchant": [],
        "skillOrder": [],
        "skillMax": [],
        "runes": {"keystone": None, "list": []},
        "situational": [],
    }

    # Final build (6 items) -------------------------------------------------
    final_slots = s.select(".build-items-row--final .build-items-row__slot--final")
    for slot in final_slots:
        label = slot.select_one(".build-items-row__label")
        img = slot.find("img")
        name = _txt(label) or _img_name(img)
        if name:
            out["finalBuild"].append({
                "name": _img_name(img) or name,  # alt is the full name; label can truncate
                "slug": _slug_from_href(label.get("href", "")) if label and label.name == "a" else "",
                "img": (img.get("src") if img else ""),
            })

    # Core + starter sections ----------------------------------------------
    out["core"] = _items_in(s.select_one(".build-build-section--core"))
    out["starter"] = _items_in(s.select_one(".build-build-section--starter"))

    # Boots & enchant -------------------------------------------------------
    boots_imgs = [img for slot in s.select(".build-boots-row .build-boots-row__main")
                  for img in slot.find_all("img")]
    for img in boots_imgs:
        name = _img_name(img)
        if not name:
            continue
        if _looks_like_boots(name):
            if name not in out["boots"]:
                out["boots"].append(name)
        else:
            if name not in out["enchant"]:
                out["enchant"].append(name)

    # Skill order priority (e.g. Q > W > E). Alt text is sometimes a full
    # sentence, so normalise to the leading ability letter and keep the first
    # three distinct abilities.
    order: list = []
    for i in s.select(".so-prio .so-prio-img"):
        t = _img_name(i).strip().upper()
        if t and t[0] in "QWER" and t[0] not in order:
            order.append(t[0])
    out["skillOrder"] = order[:3]

    # Runes -----------------------------------------------------------------
    for row in s.select(".build-rune-list .build-rune-row"):
        img = row.find("img")
        name = _txt(row.select_one("strong")) or _img_name(img)
        desc = _txt(row.select_one("p"))
        if not name:
            continue
        rune = {"name": name, "desc": desc, "img": (img.get("src") if img else "")}
        if "build-rune-row--keystone" in row.get("class", []):
            out["runes"]["keystone"] = rune
        else:
            out["runes"]["list"].append(rune)

    # Situational items with the context that triggers them ----------------
    # The page renders situational cards twice (responsive layouts), so dedupe
    # on (context + item set).
    seen_sit = set()
    for card in s.select(".build-sit-card"):
        ctx = _txt(card.select_one(".build-sit-card__ctx"))
        items = []
        for slot in card.select(".build-sit-slot"):
            img = slot.find("img")
            name = _img_name(img) or _txt(slot.find("span"))
            note = _txt(slot.find("em"))
            if name:
                items.append({"name": name, "note": note, "img": (img.get("src") if img else "")})
        if not (ctx and items):
            continue
        key = (ctx.lower(), tuple(i["name"] for i in items))
        if key in seen_sit:
            continue
        seen_sit.add(key)
        out["situational"].append({"context": ctx, "items": items})

    return out


def _items_in(section) -> list:
    if not section:
        return []
    items = []
    seen = set()
    for slot in section.select(".build-items-row__slot, .build-starter-slot, .build-slot"):
        img = slot.find("img")
        label = slot.select_one(".build-items-row__label")
        name = _img_name(img) or _txt(label)
        if name and name not in seen:
            seen.add(name)
            items.append({"name": name, "img": (img.get("src") if img else "")})
    return items
