// =====================================================================
// CampusTwin AI planner: offline rules engine
// Pure functions, no dependencies. The server uses this when Claude is not available,
// and a copy is inlined into client/dist/index.html so the planner still answers when the
// backend cannot be reached. After editing this file run:  npm run sync-planner
// =====================================================================

// slider ranges: all 0-100 step 5, except hvac 0-3 step 0.5
const RANGES = {
  sensors: [0, 100, 5], solar: [0, 100, 5], hvac: [0, 3, 0.5],
  aerators: [0, 100, 5], rain: [0, 100, 5], waste: [0, 100, 5], plastic: [0, 100, 5]
};
const KEYS = Object.keys(RANGES);

export function clampSliders(raw) {
  const out = {};
  for (const [k, [min, max, step]] of Object.entries(RANGES)) {
    let n = Number(raw?.[k]);
    if (!Number.isFinite(n)) n = 0;
    n = Math.min(max, Math.max(min, n));
    out[k] = Math.round(n / step) * step;
  }
  return out;
}

// ---------------------------------------------------------------------
// 1. Explicit measures ("add solar", "fix leaking taps")
// ---------------------------------------------------------------------
const MEASURES = [
  { key: "sensors", label: "occupancy sensors", dflt: 60, share: "kw",
    re: /\b(sensors?|motion|occupancy|presence|empty (?:rooms?|class\w*|halls?|labs?)|auto[- ]?off|switch(?:ed|ing)? off|turn(?:ed|ing)? off)\b/ },
  { key: "solar", label: "rooftop solar", dflt: 40, share: "roofSqFt", re: /\b(solar|photovoltaic|pv|panels?)\b/ },
  { key: "hvac", label: "a higher AC setpoint", dflt: 1.5, share: null,
    re: /\b(ac|a\/c|hvac|air[- ]?con\w*|cooling|thermostat|set ?point)\b/ },
  { key: "aerators", label: "tap aerators and leak fixes", dflt: 60, share: "water", re: /\b(aerators?|taps?|faucets?|low[- ]?flow|leaks?|leaking|leakage|fixtures?|cisterns?)\b/ },
  { key: "rain", label: "rainwater harvesting", dflt: 40, share: "roofSqFt", re: /\b(rainwater|rain ?water|harvest\w*|catchment|recharge)\b/ },
  { key: "waste", label: "waste segregation", dflt: 60, share: null,
    re: /\b(segregat\w*|compost\w*|biodigest\w*|biogas|bins?|food scraps?)\b/ },
  { key: "plastic", label: "plastic reduction", dflt: 50, share: null, re: /\b(plastic|bottles?|refill|single[- ]use)\b/ }
];
const EVERYTHING = { sensors: 80, solar: 60, hvac: 2, aerators: 80, rain: 60, waste: 80, plastic: 70 };
const BALANCED = { sensors: 50, solar: 30, hvac: 1, aerators: 50, rain: 30, waste: 50, plastic: 30 };
const LABEL = { sensors: "occupancy sensors", solar: "rooftop solar", hvac: "AC setpoint", aerators: "tap aerators and leak fixes",
  rain: "rainwater harvesting", waste: "waste segregation", plastic: "plastic reduction" };
const SHARE = Object.fromEntries(MEASURES.map((m) => [m.key, m.share]));

// ---------------------------------------------------------------------
// 2. Situations: problems, seasons and goals described in plain words.
//    `all` = every regex must match. specific situations add to explicit measures;
//    generic ones are used only when nothing more specific was recognised.
// ---------------------------------------------------------------------
const SITUATIONS = [
  { id: "summer", name: "summer heat / peak AC load", specific: true,
    all: [/\b(summers?|heat ?waves?|hot (?:weather|season|days?|months?)|peak (?:load|demand|season)|scorching|sweltering)\b/],
    none: [/\b(water|taps?|bore ?wells?|tankers?)\b/], absorbs: ["ac_load"],
    plan: { hvac: 2, sensors: 50, solar: 50 } },
  { id: "ac_load", name: "heavy AC consumption", specific: true,
    all: [/\b(ac|a\/c|air[- ]?con\w*|cooling|hvac)\b/, /\b(high|huge|heavy|big|bill|cost|too|overload\w*|load|consum\w*|expens\w*|waste\w*|running)\b/],
    plan: { hvac: 2, sensors: 50 } },
  { id: "power_cut", name: "unreliable grid / power cuts", specific: true,
    all: [/\b(power ?cuts?|black ?outs?|load[- ]?shedding|outages?|grid (?:fail\w*|down|unreliable|issues?)|diesel|generators?|dg sets?|unstable (?:power|supply))\b/],
    plan: { solar: 60, sensors: 50 } },
  { id: "water_shortage", name: "water shortage", specific: true,
    all: [/\b(shortage|scarcity|crisis|stress|deficit|running out|drought|dries|drying|dry|tankers?|bore ?wells?|no water|low water|water (?:problem|issue|supply)|groundwater)\b/, /\b(water|tankers?|bore ?wells?|groundwater|taps?|supply)\b/],
    plan: { aerators: 70, rain: 70 } },
  { id: "monsoon", name: "monsoon / heavy rain", specific: true,
    all: [/\b(monsoons?|heavy rains?|rainy|rainfall|floods?|flooding|flooded|waterlogg\w*|runoff|storm ?water|cloudburst)\b/],
    plan: { rain: 80 } },
  { id: "empty_campus", name: "empty or idle buildings (exams, vacations, nights)", specific: true,
    all: [/\b(exams?|vacations?|holidays?|breaks?|weekends?|nights?|after[- ]hours|idle|unoccupied|vacant|nobody|no one|standby|phantom|vampire|lights? (?:left )?on|fans? (?:left )?on|left (?:on|running)|forgot\w*|campus (?:is |stays |remains )?(?:empty|closed|shut)|empty campus|(?:is |are |stays? )?empty|closed)\b/],
    absorbs: ["lights"],
    plan: { sensors: 85, hvac: 1 } },
  { id: "lights", name: "lighting and fans left running", specific: true,
    all: [/\b(lights?|lighting|lamps?|tube ?lights?|fans?|classrooms? (?:power|energy)|appliances?)\b/, /\b(waste\w*|left|running|unused|empty|forgot\w*|all (?:day|night)|24 ?x ?7|high|bill|cost)\b/],
    plan: { sensors: 70 } },
  { id: "food_waste", name: "canteen and food waste", specific: true,
    all: [/\b(canteens?|mess|kitchens?|food|dining|leftovers?|meals?)\b/, /\b(waste\w*|overflow\w*|dump\w*|throw\w*|discard\w*|smell\w*|garbage|trash|scraps?|leftovers?)\b/],
    absorbs: ["garbage"],
    plan: { waste: 80, plastic: 40 } },
  { id: "garbage", name: "garbage and litter", specific: true,
    all: [/\b(garbage|trash|litter\w*|landfill|dumps?|dumping|rubbish|solid waste|waste (?:problem|issue|pile)|zero[- ]waste)\b/],
    plan: { waste: 75, plastic: 50 } },
  { id: "low_budget", name: "a tight budget / quick wins", specific: true,
    all: [/\b(budget|cheap\w*|afford\w*|low[- ]?cost|inexpensive|quick wins?|low[- ]hanging|without spending|little money|no money|short payback|fast payback|quick payback|payback (?:fast|quick|short)|spend less|minimal (?:cost|investment)|small investment|bootstrap\w*|limited (?:funds?|money))\b/],
    plan: { sensors: 50, hvac: 1.5, aerators: 60, waste: 50 }, noSolar: true },
  { id: "ambitious", name: "an all-out sustainability push", specific: true,
    all: [/\b(net[- ]?zero|carbon[- ]?neutral|fully green|100% green|go all out|all[- ]in|maximum impact|max impact|most ambitious|aggressive(?:ly)?|biggest impact|flagship)\b/],
    plan: EVERYTHING },

  // ---- generic situations ----
  { id: "power_bill", name: "a high electricity bill", specific: false,
    all: [/\b(electric\w*|power|energy|kwh|current bill|light bill|units?|consumption|load)\b/, /\b(high|huge|too (?:much|high)|expensive|rising|increas\w*|spik\w*|reduce|cut|lower|decreas\w*|save|saving|waste\w*|bill|bills|cost|costs|overspend\w*|burden|drain\w*|heavy|improve|efficien\w*)\b/],
    plan: { sensors: 60, solar: 40, hvac: 1.5 } },
  { id: "water_bill", name: "high water use or water bills", specific: false,
    all: [/\b(water|tap|taps|hostels? water|borewell|municipal)\b/, /\b(high|huge|too (?:much|high)|expensive|rising|increas\w*|reduce|cut|lower|decreas\w*|save|saving|waste\w*|wastage|bill|bills|cost|costs|overuse|consumption|usage|efficien\w*|conserv\w*)\b/],
    plan: { aerators: 65, rain: 45 } },
  { id: "carbon", name: "a carbon / sustainability goal", specific: false,
    all: [/\b(carbon|emissions?|co2|co₂|footprint|climate|greenhouse|decarboni\w*|sustainab\w*|esg|naac|nirf|rating|ranking|eco[- ]?friendly|environment\w*|green(?:er)? campus|go(?:ing)? green|green(?:ing)?)\b/],
    plan: { sensors: 60, solar: 50, hvac: 1, aerators: 50, rain: 40, waste: 60, plastic: 40 } },
  { id: "waste_generic", name: "a waste problem", specific: false,
    all: [/\b(waste|wastage|recycl\w*|disposal|segregation|biodegradable)\b/],
    none: [/\bwast\w*\b[^.,;]{0,25}\b(water|electric\w*|power|energy|current|ac)\b/],
    plan: { waste: 70, plastic: 40 } },
  { id: "comfort", name: "heat complaints / comfort", specific: false,
    all: [/\b(hot|warm|uncomfortable|sweat\w*|stuffy|humid|temperature|complain\w*)\b/],
    plan: { hvac: 1, sensors: 40 } },
  { id: "energy_generic", name: "an energy question", specific: false,
    all: [/\b(electricity|electric|power|energy|kwh|kw|units?|grid|renewable|green energy|clean energy)\b/],
    plan: { sensors: 60, solar: 40, hvac: 1.5 } },
  { id: "water_generic", name: "a water question", specific: false,
    all: [/\b(water|taps?|plumbing|sanitation|washrooms?|toilets?|flush\w*)\b/],
    plan: { aerators: 60, rain: 40 } }
];

const UNSUPPORTED = [
  [/\b(budget|lakhs?|crores?|₹|rs\.?|rupees?|inr|loan|fund\w*|grant|subsid\w*)\b/, "budgets and funding are not controls; read cost and payback in the results"],
  [/\b(tariffs?|per unit|price hike|rate hike)\b/, "tariffs are set in College Details"],
  [/\b(enrol\w*|headcount|admissions?|population|expansion|growth|more students|(?:\d[\d,]*|extra|additional|new) students?|new (?:building|block|hostel))\b/, "headcount and new buildings are set in College Details and Buildings & Facilities"],
  [/\b(leds?|bulbs?|lamps?|tube ?lights?|batter(?:y|ies)|storage|evs?|electric vehicles?|wind|generators?|diesel|dg sets?|inverters?)\b/, "LED retrofits, batteries, generators, EVs and wind have no slider yet"],
  [/\b(reduce|cut|lower|decrease|save|drop|slash|bring down)\b[^.,;]{0,60}\bby\s+\d+(?:\.\d+)?\s*(?:%|percent|per cent)/, "a specific % target is not a control, so this is a strong starting plan: read the savings in the results and adjust the sliders to reach your target"]
];

const ON_TOPIC = /\b(campus|college|university|institute|hostels?|buildings?|blocks?|classrooms?|labs?|library|canteen|bills?|costs?|sav(?:e|ing|ings)|electric\w*|power|energy|water|waste|carbon|sustainab\w*|green|emissions?|climate|efficien\w*|resources?|utility|utilities|what (?:should|can|do) we|recommend\w*|suggest\w*|advice|where (?:do|should) we start|best way|priorit\w*|improve|plan)\b/;

export const EXAMPLES = [
  "Our electricity bill is too high, what can we do?",
  "Water shortage in the hostels this summer",
  "Exams are over and the campus is empty for two months",
  "We have a tight budget, what are the quick wins?",
  "Heavy monsoon expected, make use of the rain",
  "Canteen waste is overflowing every day"
];

function quantityIn(text, key) {
  if (key === "hvac") {
    const m = text.match(/(\d+(?:\.\d+)?)\s*(?:°|deg\w*|c\b)/);
    if (!m) return null;
    const n = Number(m[1]);
    return n >= 16 ? Math.max(0, n - 24) : n;   // "AC at 26°C" is read as +2°C over a 24°C baseline
  }
  const pct = text.match(/(\d+(?:\.\d+)?)\s*(?:%|percent|per cent)/);
  if (pct) return Number(pct[1]);
  if (/\bhalf\b/.test(text)) return 50;
  if (/\bquarter\b/.test(text)) return 25;
  if (/\bthird\b/.test(text)) return 33;
  if (/\b(most|majority)\b/.test(text)) return 75;
  if (/\b(some|few|partial\w*|pilot|small)\b/.test(text)) return 25;
  if (/\b(all|every|entire|whole|full|fully|everywhere)\b/.test(text)) return 100;
  return null;
}

// Share of a campus resource held by the buildings a clause names ("hostel", "library", ...)
function scopeShare(text, resource, campus) {
  if (!campus?.buildings?.length || !resource) return null;
  const words = new Set(text.split(/[^a-z]+/).filter((w) => w.length >= 4).map((w) => w.replace(/s$/, "")));
  const field = (b) => (resource === "kw" ? b.kw : resource === "water" ? b.water : b.roofSqFt);
  const total = campus.buildings.reduce((t, b) => t + field(b), 0);
  if (!(total > 0)) return null;
  const skip = ["block", "campus", "center", "centre", "complex", "water", "power", "energy"];
  const matched = campus.buildings.filter((b) => {
    const tokens = `${b.name} ${b.type || ""}`.toLowerCase().split(/[^a-z]+/).filter((w) => w.length >= 4).map((w) => w.replace(/s$/, ""));
    return tokens.some((t) => words.has(t) && !skip.includes(t));
  });
  if (!matched.length || matched.length === campus.buildings.length) return null;
  return matched.reduce((t, b) => t + field(b), 0) / total;
}

const fmtVal = (key, v) => (key === "hvac" ? `+${v}°C` : `${v}%`);

export function fallback(q, current, campus) {
  let t = " " + String(q).toLowerCase().replace(/[’']/g, "'") + " ";
  // "every day" is a frequency, not "100%"
  t = t.replace(/\bevery (?:day|night|week|month|year|morning|evening|semester|summer|time)\b/g, "daily");

  // "also add X" builds on the current sliders; "A and also B" is just a conjunction
  const incremental = /\b(?:we|i) also\b|\balso (?:add|install|put|include|fix|do)\b|\bin addition\b|\badditionally\b|\bon top of\b|\bas well as (?:the )?(?:current|existing)\b|\bkeep (?:the )?(?:current|existing)\b/.test(t);
  const s = incremental && current ? { ...clampSliders(current) } : Object.fromEntries(KEYS.map((k) => [k, 0]));
  const noteMap = {};
  const reasons = [];
  let everything = false;
  let matched = false;

  // A goal such as "cut the bill by 30%" is not a slider amount
  const goalRe = /\b(reduce|cut|lower|decrease|save|drop|slash|bring down)\b([^.,;]{0,60}?)\bby\s+\d+(?:\.\d+)?\s*(?:%|percent|per cent)/g;
  const tq = t.replace(goalRe, (m, verb, mid) => verb + mid);

  // ---- explicit measures ----
  const fixed = new Set();       // keys the user gave an explicit amount (or switched off)
  const defaulted = new Set();   // keys named without an amount
  if (/\b(everything|all (?:the )?measures|all of (?:the )?above|full package|max(?:imum)? out)\b/.test(tq)) {
    Object.assign(s, EVERYTHING);
    KEYS.forEach((k) => fixed.add(k));
    everything = true;
    matched = true;
  } else {
    const clauses = tq.split(/[,;.?!]|\band\b|\bplus\b|\balso\b|\bwhile\b|\bthen\b|\bbut\b/).map((c) => c.trim()).filter(Boolean);
    const pcts = tq.match(/\d+(?:\.\d+)?\s*(?:%|percent|per cent)/g) || [];
    for (const m of MEASURES) {
      const hit = clauses.filter((c) => m.re.test(c));
      if (!hit.length) continue;
      matched = true;
      const clause = hit[0];
      if (/\b(without|no|skip|except|exclude|remove|drop|don'?t|do not|not)\b/.test(clause)) {
        s[m.key] = 0;
        fixed.add(m.key);
        noteMap[m.key] = { off: true };
        continue;
      }
      // A quantity counts only inside the clause that names the measure,
      // except one lone percentage in the whole sentence ("solar and sensors at 50%")
      let amount = quantityIn(clause, m.key) ?? (m.key !== "hvac" && pcts.length === 1 ? quantityIn(pcts[0], m.key) : null);
      let how = "";
      if (amount === null) { amount = m.dflt; defaulted.add(m.key); how = "default"; } else fixed.add(m.key);
      const share = scopeShare(clause, m.share, campus);
      if (share !== null && m.key !== "hvac") { amount = amount * share; how = "scaled to the named buildings"; }
      s[m.key] = amount;
      noteMap[m.key] = { how: how ? " (" + how + ")" : "" };
    }
  }

  // ---- situations ----
  const hits = SITUATIONS.filter((sit) => sit.all.every((re) => re.test(tq)) && !(sit.none || []).some((re) => re.test(tq)));
  const specific = hits.filter((h) => h.specific);
  let use = specific;
  if (!specific.length && !matched) {
    use = hits.slice();
    // the broad energy / water catch-alls only speak when nothing sharper matched
    if (use.length > 1) use = use.filter((u) => u.id !== "energy_generic" && u.id !== "water_generic");
    use = use.slice(0, 3);
  }
  use = use.filter((u) => !use.some((o) => (o.absorbs || []).includes(u.id)));
  if (use.length) {
    const plan = {};
    for (const sit of use) {
      for (const [k, v] of Object.entries(sit.plan)) plan[k] = Math.max(plan[k] ?? 0, v);
      reasons.push(sit.name);
    }
    if (use.some((u) => u.noSolar)) { delete plan.solar; delete plan.rain; }
    let any = false;
    for (const [k, v0] of Object.entries(plan)) {
      if (fixed.has(k)) continue;                       // the user's own number wins
      let v = v0;
      const share = k === "hvac" ? null : scopeShare(tq, SHARE[k], campus);
      if (share !== null) v = v * share;
      s[k] = Math.max(s[k], v);
      noteMap[k] = { how: share !== null ? " (scaled to the named buildings)" : "" };
      any = true;
    }
    if (any) matched = true;
  }

  // ---- on-topic but nothing specific: balanced starter plan ----
  let starter = false;
  if (!matched && ON_TOPIC.test(tq)) {
    Object.assign(s, BALANCED);
    matched = true;
    starter = true;
  }
  const unsupported = UNSUPPORTED.filter(([re]) => re.test(t)).map(([, msg]) => msg).join("; ");
  const sliders = clampSliders(s);
  const notes = KEYS.filter((k) => noteMap[k]).map((k) => noteMap[k].off ? `${LABEL[k]} off` : `${LABEL[k]} ${fmtVal(k, sliders[k])}${noteMap[k].how || ""}`);
  if (everything) notes.unshift("every measure at a high level");

  if (!matched) {
    return {
      matched: false, sliders, unsupported, intent: "off-topic",
      explanation: "I turn campus problems and what-ifs into simulator settings, but I could not connect that to energy, water or waste. Describe a situation, for example “our power bill is too high”, “water shortage in the hostels” or “campus is empty during exams”."
    };
  }

  let explanation;
  if (starter) {
    explanation = "I could not pin that to one problem, so I set a balanced starter plan across energy, water and waste. Tell me what hurts most, such as the power bill, water, waste or heat, and I will focus it.";
  } else if (reasons.length) {
    explanation = `That sounds like ${reasons.join(" and ")}. I set ${notes.join(", ")}. Fine-tune with the sliders.`;
  } else {
    explanation = "Offline rules set: " + notes.join(", ") + ". Percentages are read from your wording, so fine-tune with the sliders.";
  }
  return { matched: true, sliders, unsupported, explanation, intent: starter ? "starter" : reasons.length ? "situation" : "measures" };
}
