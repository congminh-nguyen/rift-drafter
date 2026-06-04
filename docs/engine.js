/*
 * Adaptive build recommendation engine (runs entirely in the browser).
 *
 * Inputs : 5 ally slugs, 5 enemy slugs, champions.json, traits.json, options.
 * Output : per-ally build with the base build from WildRiftCore PLUS an adaptive
 *          layer that (a) surfaces the champion's own situational items that match
 *          the *actual* enemy composition, and (b) adds rule-based fallback advice
 *          (anti-heal / anti-tank / tenacity / resist / anti-shield) when the
 *          enemy comp demands it.
 *
 * The engine is deterministic and explainable: every recommendation carries a
 * reason string, and a confidence score reflects data completeness + signal match.
 */

// Map an enemy-comp signal to the keywords WildRiftCore uses in its situational
// "context" labels (e.g. "vs Healing", "vs Tanks", "vs Crowd Control").
const CONTEXT_KEYWORDS = {
  healing: ["heal", "sustain", "lifesteal"],
  tanky: ["tank", "bruiser", "health", "hp", "armor stack"],
  cc: ["crowd control", "cc", "tenacity", "lockdown"],
  shield: ["shield"],
  ap: ["ap", "magic", "mage", "burst"],
  ad: ["ad ", "physical", "armor", "attack damage"],
};

// Generic fallback recommendations keyed by signal + your champion's damage type.
// Used only when the champion has no matching situational card of its own.
const FALLBACK = {
  healing: {
    AP: { item: "Morellonomicon", why: "AP anti-heal — your spells apply Grievous Wounds to enemy healers." },
    AD: { item: "Mortal Reminder", why: "AD anti-heal + armor pen against enemy sustain." },
    mixed: { item: "Chempunk Chainsword / Morellonomicon", why: "Apply Grievous Wounds to cut enemy healing." },
  },
  tanky: {
    AP: { item: "Void Staff", why: "Magic penetration to punch through stacked magic resist / health." },
    AD: { item: "Lord Dominik's Regards / Black Cleaver", why: "%health + armor penetration to shred the enemy frontline." },
    mixed: { item: "Liandry's Torment / Giant Slayer", why: "%health damage scales against the enemy tanks." },
  },
  cc: {
    any: { item: "Mercury's Treads (boots) or Quicksilver (enchant)", why: "Tenacity / cleanse to survive the enemy's heavy crowd control." },
  },
  ap: {
    any: { item: "Mercury's Treads + a Magic Resist item (Maw / Force of Nature)", why: "Enemy damage is mostly magic — stack MR on your vulnerable carries." },
  },
  ad: {
    any: { item: "Plated Steelcaps + an Armor item (Randuin's / Frozen Heart)", why: "Enemy damage is mostly physical — stack armor on your vulnerable carries." },
  },
  shield: {
    AD: { item: "Serpent's Fang", why: "Shreds enemy shields so your burst lands clean." },
    AP: { item: "Oceanid's Trident / anti-shield", why: "Breaks the enemy shields protecting their carries." },
    mixed: { item: "Serpent's Fang", why: "Anti-shield to negate enemy shielding." },
  },
};

function imgURL(src) {
  if (!src) return "";
  if (src.startsWith("http")) return src;
  return src.replace(/^\//, ""); // local self-hosted relative path (assets/...)
}

// Community Dragon square champion icon. A few slugs need an explicit alias.
const CDRAGON_ALIAS = {
  "wukong": "monkeyking",
  "nunu-willump": "nunu",
  "renata": "renataglasc",
};
function championIcon(slug) {
  const alias = CDRAGON_ALIAS[slug] || slug.replace(/-/g, "");
  return `https://cdn.communitydragon.org/latest/champion/${alias}/square`;
}

/** Aggregate the trait profile of a team of champion slugs. */
function analyzeTeam(slugs, traits) {
  const a = { ap: 0, ad: 0, mixed: 0, tank: 0, healing: 0, cc: 0, shield: 0, n: 0,
              healers: [], ccers: [], tanks: [], shielders: [] };
  for (const slug of slugs) {
    const t = traits[slug];
    if (!t) continue;
    a.n++;
    if (t.damage === "AP") a.ap++;
    else if (t.damage === "mixed") a.mixed++;
    else a.ad++;
    if (t.tank) { a.tank++; a.tanks.push(slug); }
    if (t.healing) { a.healing++; a.healers.push(slug); }
    if (t.hardCC) { a.cc++; a.ccers.push(slug); }
    if (t.shield) { a.shield++; a.shielders.push(slug); }
  }
  // Derived signals with thresholds tuned for Wild Rift (5-player teams).
  const apShare = a.ap + 0.5 * a.mixed;
  const adShare = a.ad + 0.5 * a.mixed;
  a.signals = {
    healing: a.healing >= 1,         // any real healer warrants anti-heal consideration
    heavyHealing: a.healing >= 2,
    tanky: a.tank >= 2,
    cc: a.cc >= 3,                   // a genuinely CC-heavy comp
    shield: a.shield >= 1,
    apHeavy: apShare >= 3 && apShare > adShare,
    adHeavy: adShare >= 3 && adShare > apShare,
  };
  return a;
}

/** Find this champion's own situational cards that match an active signal. */
function matchSituational(champ, signalKey) {
  const kws = CONTEXT_KEYWORDS[signalKey] || [];
  const out = [];
  for (const card of champ.situational || []) {
    const ctx = (card.context || "").toLowerCase();
    if (kws.some((k) => ctx.includes(k))) out.push(card);
  }
  return out;
}

/** Build a recommendation for a single ally champion given the enemy comp. */
function recommendForChampion(champ, traits, enemy, ally, options) {
  const myTrait = traits[champ.slug] || { damage: "AD" };
  const reasons = [];
  const activeSituational = [];
  const usedContexts = new Set();
  let signalsAddressed = 0;

  const consider = (signalKey, label, fallbackBucket) => {
    if (!enemy.signals[signalKey]) return;
    signalsAddressed++;
    const matches = matchSituational(champ, signalKey);
    if (matches.length) {
      for (const m of matches) {
        if (usedContexts.has(m.context)) continue;
        usedContexts.add(m.context);
        activeSituational.push({ ...m, trigger: label });
      }
    } else {
      const bucket = FALLBACK[fallbackBucket];
      const fb = bucket[myTrait.damage] || bucket.any;
      if (fb) {
        reasons.push(`${label}: consider ${fb.item} — ${fb.why}`);
      }
    }
  };

  // Order matters: most build-defining adaptations first.
  if (enemy.signals.healing) {
    const sev = enemy.signals.heavyHealing ? "Heavy enemy healing" : "Enemy healing";
    const who = enemy.healers.map(prettySlug).join(", ");
    consider("healing", `${sev} (${who})`, "healing");
  }
  if (enemy.signals.tanky) {
    consider("tanky", `Enemy frontline is tanky (${enemy.tanks.map(prettySlug).join(", ")})`, "tanky");
  }
  if (enemy.signals.cc) {
    consider("cc", `Enemy has heavy crowd control (${enemy.cc} CC champions)`, "cc");
  }
  if (enemy.signals.shield) {
    consider("shield", `Enemy shields carries (${enemy.shielders.map(prettySlug).join(", ")})`, "shield");
  }
  // Resist guidance applies mainly to squishy/carry champs.
  const squishy = !(traits[champ.slug] && traits[champ.slug].tank);
  if (squishy && enemy.signals.apHeavy) consider("ap", "Enemy damage is mostly magic", "ap");
  if (squishy && enemy.signals.adHeavy) consider("ad", "Enemy damage is mostly physical", "ad");

  // Matchup-wall intel: does this ally directly counter or get countered by an enemy?
  // If a lane is assigned, prefer matchups in that lane (more relevant).
  const lane = (options.lanes || {})[champ.slug] || "";
  const counters = champ.matchups?.counters || [];
  const laneCounters = lane ? counters.filter((c) => !c.lane || c.lane === lane) : counters;
  const matchupNotes = [];
  for (const c of (laneCounters.length ? laneCounters : counters)) {
    if (enemy.slugsSet.has(c.slug)) {
      matchupNotes.push({ type: c.tier, name: c.name, note: c.note });
    }
  }
  // Synergies with your OWN team.
  const synergyNotes = [];
  for (const sgy of (champ.matchups?.synergies || [])) {
    if (ally.slugsSet.has(sgy.slug)) synergyNotes.push({ name: sgy.name, note: sgy.note });
  }

  // Confidence: data completeness + how many enemy signals we could respond to.
  const completeness =
    (champ.finalBuild?.length >= 5 ? 0.4 : 0.15) +
    (champ.runes?.keystone ? 0.2 : 0) +
    (champ.situational?.length ? 0.2 : 0.05) +
    (champ.boots?.length ? 0.1 : 0) +
    (champ.skillOrder?.length ? 0.1 : 0);
  const confidence = Math.min(1, completeness);
  const confidenceLabel = confidence >= 0.85 ? "High" : confidence >= 0.6 ? "Medium" : "Low";

  return {
    slug: champ.slug,
    name: champ.name,
    roles: champ.roles,
    lane: lane,
    icon: championIcon(champ.slug),
    intent: champ.intent,
    damage: myTrait.damage,
    core: champ.core,
    finalBuild: champ.finalBuild,
    boots: champ.boots,
    enchant: champ.enchant,
    skillOrder: champ.skillOrder,
    runes: champ.runes,
    allSituational: champ.situational || [],
    activeSituational,
    fallbackReasons: reasons,
    matchupNotes,
    synergyNotes,
    confidence,
    confidenceLabel,
    signalsAddressed,
    patch: champ.patch,
  };
}

function prettySlug(slug) {
  return (slug || "").split("-").map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
}

/** Top-level: analyze both teams and produce per-ally recommendations + summary. */
function recommendTeam(allySlugs, enemySlugs, db, traits, options = {}) {
  const enemy = analyzeTeam(enemySlugs, traits);
  enemy.slugsSet = new Set(enemySlugs);
  const ally = analyzeTeam(allySlugs, traits);
  ally.slugsSet = new Set(allySlugs);

  const recs = [];
  for (const slug of allySlugs) {
    const champ = db.champions[slug];
    if (!champ) continue;
    recs.push(recommendForChampion(champ, traits, enemy, ally, options));
  }

  const teamSummary = buildTeamSummary(enemy, ally);
  return { recommendations: recs, enemy, ally, teamSummary };
}

function buildTeamSummary(enemy, ally) {
  const lines = [];
  if (enemy.signals.heavyHealing) lines.push(`Enemy runs heavy sustain (${enemy.healers.map(prettySlug).join(", ")}) — anti-heal is a team priority; make sure your main damage dealers carry Grievous Wounds.`);
  else if (enemy.signals.healing) lines.push(`Enemy has healing (${enemy.healers.map(prettySlug).join(", ")}) — at least one anti-heal item on the team.`);
  if (enemy.signals.tanky) lines.push(`Enemy has ${enemy.tank} tanky frontliners — your physical/magic carries want %health & penetration to avoid bouncing off.`);
  if (enemy.signals.cc) lines.push(`Enemy crowd control is heavy (${enemy.cc} champions) — tenacity (Mercury's Treads / Quicksilver) on dive-threatened carries; respect their engage timing.`);
  if (enemy.signals.shield) lines.push(`Enemy shields their carries (${enemy.shielders.map(prettySlug).join(", ")}) — anti-shield (Serpent's Fang) lets your burst go through.`);
  if (enemy.signals.apHeavy) lines.push(`Enemy is AP-weighted — itemize magic resist on your squishies and consider a magic-resist support item.`);
  if (enemy.signals.adHeavy) lines.push(`Enemy is AD-weighted — itemize armor; armor supports / Randuin's are strong here.`);
  if (!lines.length) lines.push("Enemy comp is balanced — follow standard core builds and adapt situationally as the game develops.");
  return lines;
}

// Expose for the browser.
window.RiftEngine = { recommendTeam, analyzeTeam, championIcon, imgURL, prettySlug };
