/* UI wiring: load data, build the 5v5 pickers, run the engine, render cards. */
(function () {
  const E = window.RiftEngine;
  let DB = null;        // champions.json
  let TRAITS = null;    // traits.json
  let CHAMP_LIST = [];  // [{slug, name}] sorted by name

  const GOALS = ["teamfight", "split push", "poke", "pick", "scaling", "anti-tank", "anti-heal", "protect carry"];
  const selectedGoals = new Set();
  const LANES = [
    { v: "baron", label: "Baron" },
    { v: "jungle", label: "Jungle" },
    { v: "mid", label: "Mid" },
    { v: "adc", label: "Dragon" },
    { v: "support", label: "Support" },
  ];

  async function boot() {
    try {
      // Cache-bust so the daily-refreshed data is always picked up.
      const bust = "?t=" + Date.now();
      const [champs, traits] = await Promise.all([
        fetch("data/champions.json" + bust).then((r) => r.json()),
        fetch("data/traits.json" + bust).then((r) => r.json()),
      ]);
      DB = champs;
      TRAITS = traits;
    } catch (e) {
      document.getElementById("emptyState").textContent =
        "Could not load build data. If running locally, serve the folder over HTTP (see README).";
      return;
    }

    CHAMP_LIST = Object.values(DB.champions)
      .map((c) => ({ slug: c.slug, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));

    document.getElementById("patchPill").textContent = "Patch " + (DB.meta.patch || "?");
    const d = DB.meta.scrapedAt ? new Date(DB.meta.scrapedAt) : null;
    document.getElementById("updatedPill").textContent =
      "Updated " + (d ? d.toISOString().slice(0, 10) : "?");

    buildSlots("allySlots", "ally");
    buildSlots("enemySlots", "enemy");
    buildGoals();

    document.getElementById("generateBtn").addEventListener("click", generate);
    document.getElementById("sampleBtn").addEventListener("click", fillExample);
    document.getElementById("clearBtn").addEventListener("click", clearAll);
  }

  function buildSlots(containerId, side) {
    const c = document.getElementById(containerId);
    c.innerHTML = "";
    for (let i = 0; i < 5; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const icon = document.createElement("img");
      icon.className = "slot__icon";
      icon.alt = "";
      icon.style.visibility = "hidden";
      const sel = document.createElement("select");
      sel.dataset.side = side;
      sel.dataset.idx = i;
      sel.innerHTML = `<option value="">— pick champion —</option>` +
        CHAMP_LIST.map((c) => `<option value="${c.slug}">${c.name}</option>`).join("");

      // Lane selector (your team only — you're building for them).
      let lane = null;
      if (side === "ally") {
        lane = document.createElement("select");
        lane.className = "slot__lane";
        lane.dataset.lane = i;
        lane.innerHTML = `<option value="">Lane</option>` +
          LANES.map((l) => `<option value="${l.v}">${l.label}</option>`).join("");
      }

      sel.addEventListener("change", () => {
        if (sel.value) {
          icon.src = E.championIcon(sel.value);
          icon.style.visibility = "visible";
          icon.onerror = () => { icon.style.visibility = "hidden"; };
          if (lane && !lane.value) {
            const champ = DB.champions[sel.value];
            const def = champ && champ.roles && champ.roles[0];
            if (def) lane.value = def;
          }
        } else {
          icon.style.visibility = "hidden";
          if (lane) lane.value = "";
        }
      });
      slot.appendChild(icon);
      slot.appendChild(sel);
      if (lane) slot.appendChild(lane);
      c.appendChild(slot);
    }
  }

  function buildGoals() {
    const c = document.getElementById("goalChips");
    c.innerHTML = "";
    for (const g of GOALS) {
      const chip = document.createElement("span");
      chip.className = "chip";
      chip.textContent = g;
      chip.addEventListener("click", () => {
        if (selectedGoals.has(g)) { selectedGoals.delete(g); chip.classList.remove("on"); }
        else { selectedGoals.add(g); chip.classList.add("on"); }
      });
      c.appendChild(chip);
    }
  }

  function readSide(side) {
    return [...document.querySelectorAll(`select[data-side="${side}"]`)]
      .map((s) => s.value).filter(Boolean);
  }

  function readLanes() {
    const lanes = {};
    [...document.querySelectorAll('select[data-side="ally"]')].forEach((s, i) => {
      if (!s.value) return;
      const laneSel = document.querySelector(`select[data-lane="${i}"]`);
      if (laneSel && laneSel.value) lanes[s.value] = laneSel.value;
    });
    return lanes;
  }

  function generate() {
    const ally = readSide("ally");
    const enemy = readSide("enemy");
    if (ally.length === 0) { alert("Pick at least one champion on your team."); return; }

    const options = {
      rank: document.getElementById("optRank").value,
      state: document.getElementById("optState").value,
      goals: [...selectedGoals],
      lanes: readLanes(),
    };
    const result = E.recommendTeam(ally, enemy, DB, TRAITS, options);
    renderSummary(result, options);
    renderResults(result.recommendations);
    document.getElementById("emptyState").classList.add("hidden");
  }

  function renderSummary(result, options) {
    const sec = document.getElementById("summary");
    sec.classList.remove("hidden");
    const list = document.getElementById("summaryList");
    const lines = [...result.teamSummary];
    if (options.state === "behind") lines.push("You're behind — prioritize safe, cost-efficient defensive items and avoid greedy spikes; play for scaling and picks.");
    if (options.state === "ahead") lines.push("You're ahead — buy into your power spikes aggressively and press timing advantages before the enemy stabilizes.");
    if (options.goals.includes("anti-heal")) lines.push("Goal: anti-heal — make sure Grievous Wounds is bought early, not as a last item.");
    if (options.goals.includes("split push")) lines.push("Goal: split push — prioritize dueling / waveclear items on your side-lane threat.");
    if (options.goals.includes("poke")) lines.push("Goal: poke — favor range and mana-sustain items to win the siege before committing.");
    list.innerHTML = lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("");

    const en = result.enemy;
    const tags = [
      tag("dmg", en.signals.apHeavy ? "AP-heavy" : en.signals.adHeavy ? "AD-heavy" : "Balanced damage", en.signals.apHeavy || en.signals.adHeavy),
      tag("heal", "Healing", en.signals.healing),
      tag("tank", "Tanky", en.signals.tanky),
      tag("cc", "Heavy CC", en.signals.cc),
      tag("shield", "Shields", en.signals.shield),
    ];
    document.getElementById("enemyTraits").innerHTML =
      `<span class="trait-tag off">Enemy comp:</span>` + tags.join("");
  }

  function tag(kind, label, on) {
    return `<span class="trait-tag ${kind} ${on ? "on" : "off"}">${label}</span>`;
  }

  function renderResults(recs) {
    const root = document.getElementById("results");
    root.innerHTML = "";
    for (const r of recs) root.appendChild(card(r));
  }

  function card(r) {
    const el = document.createElement("div");
    el.className = "card";

    const dmgBadge = `<span class="badge badge--${r.damage.toLowerCase()}">${r.damage}</span>`;
    const laneLabels = { baron: "Baron", jungle: "Jungle", mid: "Mid", adc: "Dragon", support: "Support" };
    const laneBadge = r.lane ? `<span class="badge badge--lane">${laneLabels[r.lane] || r.lane}</span>` : "";
    const roleBadges = laneBadge ||
      (r.roles || []).map((x) => `<span class="badge badge--role">${laneLabels[x] || x}</span>`).join("");

    el.innerHTML = `
      <div class="card__head">
        <img class="card__icon" src="${r.icon}" alt="${escapeHtml(r.name)}" onerror="this.style.visibility='hidden'">
        <div class="card__title">
          <h3>${escapeHtml(r.name)}</h3>
          <div class="card__badges">${roleBadges}${dmgBadge}</div>
        </div>
        <span class="conf conf--${r.confidenceLabel}" title="Data completeness">${r.confidenceLabel}</span>
      </div>
      ${r.intent ? `<p class="intent">${escapeHtml(r.intent)}</p>` : ""}
      ${itemBlock("Final build", r.finalBuild)}
      ${bootsBlock(r)}
      ${runesBlock(r.runes)}
      ${skillBlock(r.skillOrder)}
      ${adaptBlock(r)}
      ${matchupBlock(r)}
      ${allSituationalBlock(r)}
    `;
    return el;
  }

  function itemBlock(label, items) {
    if (!items || !items.length) return "";
    return `<div class="block"><div class="block__label">${label}</div>
      <div class="items">${items.map(itemEl).join("")}</div></div>`;
  }
  function itemEl(it) {
    return `<div class="item"><img src="${E.imgURL(it.img)}" alt="" loading="lazy" onerror="this.style.visibility='hidden'"><span>${escapeHtml(it.name)}</span></div>`;
  }

  function bootsBlock(r) {
    if (!(r.boots && r.boots.length) && !(r.enchant && r.enchant.length)) return "";
    const boots = (r.boots || []).join(" / ");
    const ench = (r.enchant || []).join(" / ");
    return `<div class="block"><div class="block__label">Boots &amp; enchant</div>
      <div>${escapeHtml(boots)}${ench ? ` <span class="arrow">›</span> <b>${escapeHtml(ench)}</b>` : ""}</div></div>`;
  }

  function runesBlock(runes) {
    if (!runes || (!runes.keystone && !(runes.list || []).length)) return "";
    let html = `<div class="block"><div class="block__label">Runes</div><div class="runes">`;
    if (runes.keystone) html += runeEl(runes.keystone, true);
    for (const r of runes.list || []) html += runeEl(r, false);
    return html + "</div></div>";
  }
  function runeEl(r, key) {
    return `<div class="rune ${key ? "rune--key" : ""}" title="${escapeHtml(r.desc || "")}">
      <img src="${E.imgURL(r.img)}" alt="" onerror="this.style.display='none'"><b>${escapeHtml(r.name)}</b></div>`;
  }

  function skillBlock(order) {
    if (!order || !order.length) return "";
    return `<div class="block"><div class="block__label">Skill priority</div>
      <div class="skill">${order.map((k) => `<span class="k">${escapeHtml(k)}</span>`).join('<span class="arrow">›</span>')}</div></div>`;
  }

  function adaptBlock(r) {
    if (!r.activeSituational.length && !r.fallbackReasons.length) return "";
    let html = `<div class="adapt"><div class="adapt__title">🎯 Adapted to this enemy team</div>`;
    for (const s of r.activeSituational) {
      html += `<div class="sit-card"><div class="sit-card__trigger">${escapeHtml(s.trigger)} → ${escapeHtml(s.context)}</div>
        <div class="sit-card__items">${s.items.map((it) => `
          <div class="sit-item"><img src="${E.imgURL(it.img)}" alt="" onerror="this.style.display='none'">
            <div><b style="font-size:12px">${escapeHtml(it.name)}</b>${it.note ? `<small>${escapeHtml(it.note)}</small>` : ""}</div></div>`).join("")}</div></div>`;
    }
    for (const f of r.fallbackReasons) html += `<div class="fallback">${escapeHtml(f)}</div>`;
    return html + "</div>";
  }

  function matchupBlock(r) {
    if (!r.matchupNotes.length && !r.synergyNotes.length) return "";
    let html = `<div class="matchup">`;
    for (const m of r.matchupNotes) {
      const tierLabel = { hard: "Hard counter", unfavorable: "Unfavorable", favorable: "Favorable", skill: "Skill matchup" }[m.type] || m.type;
      html += `<div class="mu mu--${m.type}"><b>vs ${escapeHtml(m.name)} — ${escapeHtml(tierLabel)}</b>${m.note ? `<small>${escapeHtml(m.note)}</small>` : ""}</div>`;
    }
    for (const s of r.synergyNotes) {
      html += `<div class="mu mu--synergy"><b>Synergy with ${escapeHtml(s.name)}</b>${s.note ? `<small>${escapeHtml(s.note)}</small>` : ""}</div>`;
    }
    return html + "</div>";
  }

  function allSituationalBlock(r) {
    if (!r.allSituational.length) return "";
    const rows = r.allSituational.map((s) =>
      `<div style="margin:6px 0"><b style="font-size:12px;color:var(--muted)">${escapeHtml(s.context)}:</b> ${s.items.map((i) => escapeHtml(i.name)).join(", ")}</div>`
    ).join("");
    return `<details><summary>All situational options (${r.allSituational.length})</summary><div style="margin-top:8px">${rows}</div></details>`;
  }

  function fillExample() {
    const ally = ["jinx", "leona", "ahri", "lee-sin", "malphite"];
    const allyLanes = ["adc", "support", "mid", "jungle", "baron"];
    const enemy = ["zed", "thresh", "soraka", "dr-mundo", "ornn"];
    setSide("ally", ally, allyLanes);
    setSide("enemy", enemy);
  }
  function setSide(side, slugs, lanes) {
    const sels = [...document.querySelectorAll(`select[data-side="${side}"]`)];
    sels.forEach((s, i) => {
      s.value = slugs[i] || "";
      s.dispatchEvent(new Event("change"));
      if (lanes && lanes[i]) {
        const laneSel = document.querySelector(`select[data-lane="${i}"]`);
        if (laneSel) laneSel.value = lanes[i];
      }
    });
  }
  function clearAll() {
    setSide("ally", []);
    setSide("enemy", []);
    document.getElementById("results").innerHTML = "";
    document.getElementById("summary").classList.add("hidden");
    document.getElementById("emptyState").classList.remove("hidden");
  }

  function escapeHtml(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  boot();
})();
