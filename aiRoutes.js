import { Router } from "express";
import { clampSliders, fallback } from "../planner.js";

const router = Router();

const MAX_QUESTION = 600;
const KEYS = ["sensors", "solar", "hvac", "aerators", "rain", "waste", "plastic"];
export { clampSliders, fallback };

// Simple per-IP limiter so a public demo cannot drain the API key
const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 60000);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > 15;
}

// ---- Sanitise what the browser sends along (it is untrusted input) ----
const finite = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
function cleanCampus(raw) {
  if (!raw || typeof raw !== "object") return null;
  const buildings = (Array.isArray(raw.buildings) ? raw.buildings : []).slice(0, 50).map((b) => ({
    name: String(b?.name ?? "").slice(0, 60),
    type: b?.type ? String(b.type).slice(0, 20) : null,
    areaSqFt: finite(b?.areaSqFt), roofSqFt: finite(b?.roofSqFt), kw: finite(b?.kw), water: finite(b?.water)
  }));
  return {
    name: String(raw.name ?? "").slice(0, 120),
    areaSqFt: finite(raw.areaSqFt), monthlyKWh: finite(raw.monthlyKWh), monthlyWaterKL: finite(raw.monthlyWaterKL),
    buildings
  };
}

// =====================================================================
// Claude planner
// =====================================================================
const SYSTEM = `You are the planner inside CampusTwin, a campus sustainability simulator for Indian colleges. Turn what the user writes into simulator slider settings by calling the set_simulator tool. Always call the tool; never answer in prose.

Sliders (each is a share of the campus-wide potential for that measure):
- sensors 0-100: % of campus floor area with occupancy sensors (lights and AC switch off in empty rooms)
- solar 0-100: % of the usable roof area covered by solar PV
- hvac 0-3: degrees C the AC setpoint is raised (steps of 0.5)
- aerators 0-100: % of taps fitted with flow aerators or leaks fixed
- rain 0-100: % of the rainwater-harvesting potential that is built
- waste 0-100: % coverage of waste segregation and canteen food-waste processing
- plastic 0-100: % reduction in single-use plastic

The user may write a measure ("add solar"), a SITUATION or PROBLEM ("our power bill is too high", "water shortage in the hostels", "summer peak", "exams are over and the campus is empty", "power cuts and diesel costs", "canteen waste is overflowing"), or a GOAL ("cut emissions", "tight budget, quick wins", "go net zero"). For a situation or goal, YOU choose the measures that address it best and set them; this is the main job. Typical mappings: high power bill -> sensors, solar, hvac; summer heat -> hvac, sensors, solar; idle or empty buildings -> sensors high, hvac; water shortage or water bill -> aerators, rain; monsoon -> rain high; waste or canteen problems -> waste, plastic; tight budget or quick wins -> low-cost measures (sensors, hvac, aerators, waste) and no solar or rain; unreliable grid -> solar, sensors; net zero or ambitious -> everything high.

Rules:
1. Measures the user does not mention and the situation does not call for are 0, unless they clearly build on the current setup ("in addition to what we have", "on top of the current plan", "keep the current settings and also add X"): then start from the current slider values supplied in the request. A plain "A and also B" is one new plan, not an addition.
2. If the request targets particular buildings or building types, convert it to a campus-wide percentage using the campus data: roof-area share for solar and rain, load (kW) share for sensors and AC, water share for aerators. Example: solar on every hostel roof, where hostels hold 26% of the roof area, means solar 25. Say how you converted in the explanation.
3. "50%" or "half" means that share of the measure's potential; "all" or "everywhere" is 100; "some" or "a few" is about 25; "most" is about 75. With no quantity, pick a moderate value (50, or hvac 1.5). A target such as "cut the bill by 30%" is not a slider amount: choose a strong plan for it and mention in "unsupported" that the exact target must be checked in the results.
4. Anything the sliders cannot represent (budgets, tariffs, headcount, LED retrofits, batteries, generators, EV charging, new buildings) goes in "unsupported". Still set the sliders for the parts that can be modelled.
5. Set modelled to false ONLY when the message has nothing to do with campus energy, water, waste or costs (a greeting, small talk, an unrelated question). Then repeat the current slider values and use "explanation" to say, in one friendly sentence, what you can help with and give one example situation. A vague but on-topic message ("how can we improve?") is still modelled: set a balanced starter plan.
6. Keep "explanation" to one or two plain sentences that name the situation you recognised and why these measures fit.`;

const TOOL = {
  name: "set_simulator",
  description: "Set the simulator sliders that best represent the user's what-if.",
  input_schema: {
    type: "object",
    properties: {
      sensors: { type: "number", description: "0-100" },
      solar: { type: "number", description: "0-100" },
      hvac: { type: "number", description: "0-3 in steps of 0.5" },
      aerators: { type: "number", description: "0-100" },
      rain: { type: "number", description: "0-100" },
      waste: { type: "number", description: "0-100" },
      plastic: { type: "number", description: "0-100" },
      modelled: { type: "boolean", description: "false when nothing in the what-if maps to a slider" },
      explanation: { type: "string", description: "One or two plain sentences on what was set and why" },
      unsupported: { type: "string", description: "Parts of the what-if the sliders cannot model, or empty" }
    },
    required: [...KEYS, "modelled", "explanation"]
  }
};

export function readModelOutput(data) {
  const blocks = Array.isArray(data?.content) ? data.content : [];
  const tool = blocks.find((b) => b.type === "tool_use" && b.input && typeof b.input === "object");
  if (tool) return tool.input;
  // Plain-text reply: tolerate prose or code fences around the JSON
  const text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const a = text.indexOf("{"), z = text.lastIndexOf("}");
  if (a >= 0 && z > a) return JSON.parse(text.slice(a, z + 1));
  throw new Error("the model reply had no usable settings");
}

// Turn whatever the model returned into the one shape the client expects
function shapeResult(parsed) {
  return {
    matched: parsed.modelled !== false,
    sliders: clampSliders(parsed.sliders && typeof parsed.sliders === "object" ? parsed.sliders : parsed),
    explanation: String(parsed.explanation || "").slice(0, 500) || "Settings suggested by the AI planner.",
    unsupported: String(parsed.unsupported || "").slice(0, 300)
  };
}

// Tolerates code fences or a sentence around the JSON object
function parseJsonLoose(text) {
  const a = text.indexOf("{"), z = text.lastIndexOf("}");
  if (a >= 0 && z > a) return JSON.parse(text.slice(a, z + 1));
  throw new Error("the model reply had no usable settings");
}

function userMessage(q, current, campus) {
  const parts = ["What-if: " + q, "Current slider values: " + JSON.stringify(current)];
  if (campus) parts.push("Campus data: " + JSON.stringify(campus));
  return parts.join("\n\n");
}

async function askClaude(key, q, current, campus) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5",
        max_tokens: 800,
        system: SYSTEM,
        tools: [TOOL],
        tool_choice: { type: "tool", name: TOOL.name },
        messages: [{ role: "user", content: userMessage(q, current, campus) }]
      })
    });
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      throw new Error(`Claude API HTTP ${r.status}${body?.error?.message ? ": " + String(body.error.message).slice(0, 120) : ""}`);
    }
    return shapeResult(readModelOutput(await r.json()));
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Claude did not answer within 25 seconds");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// =====================================================================
// Gemini planner (Google AI Studio key, free tier available)
// =====================================================================
const JSON_RULES = `

OUTPUT FORMAT (this overrides any mention of calling a tool above): reply with ONLY one JSON object, no code fences and no other text, with exactly these keys: sensors, solar, hvac, aerators, rain, waste, plastic (numbers), modelled (boolean), explanation (string), unsupported (string, empty if none).`;

async function askGemini(key, q, current, campus) {
  const base = (process.env.GEMINI_API_BASE || "https://generativelanguage.googleapis.com").replace(/\/+$/, "");
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 25000);
  try {
    const r = await fetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "content-type": "application/json", "x-goog-api-key": key },   // key stays in a header, never in the URL
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM + JSON_RULES }] },
        contents: [{ role: "user", parts: [{ text: userMessage(q, current, campus) }] }],
        generationConfig: { responseMimeType: "application/json", temperature: 0.2, maxOutputTokens: 4096 }
      })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Gemini API HTTP ${r.status}${data?.error?.message ? ": " + String(data.error.message).slice(0, 120) : ""}`);
    const cand = data?.candidates?.[0];
    if (!cand) throw new Error("Gemini returned no answer" + (data?.promptFeedback?.blockReason ? " (blocked: " + data.promptFeedback.blockReason + ")" : ""));
    const text = (cand.content?.parts || []).filter((p) => !p.thought).map((p) => p.text || "").join("\n");
    return shapeResult(parseJsonLoose(text));
  } catch (err) {
    if (err.name === "AbortError") throw new Error("Gemini did not answer within 25 seconds");
    if (err instanceof SyntaxError) throw new Error("the model reply was not valid JSON");
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// Which AI is active? AI_PROVIDER=anthropic|gemini forces one; otherwise whichever key exists (Claude first).
export function activeProvider() {
  const a = process.env.ANTHROPIC_API_KEY, g = process.env.GEMINI_API_KEY;
  const want = (process.env.AI_PROVIDER || "").toLowerCase();
  if (want === "gemini") return g ? { name: "gemini", key: g } : null;
  if (want === "anthropic" || want === "claude") return a ? { name: "claude", key: a } : null;
  if (a) return { name: "claude", key: a };
  if (g) return { name: "gemini", key: g };
  return null;
}

router.post("/suggest", async (req, res) => {
  const q = req.body?.question;
  if (typeof q !== "string" || !q.trim() || q.length > MAX_QUESTION)
    return res.status(400).json({ ok: false, error: `question is required (max ${MAX_QUESTION} chars)` });
  if (limited(req.ip)) return res.status(429).json({ ok: false, error: "too many requests, wait a minute" });

  const question = q.trim();
  const current = clampSliders(req.body?.current);
  const campus = cleanCampus(req.body?.campus);

  const prov = activeProvider();
  if (!prov) return res.json({ ok: true, source: "fallback", fallbackReason: "no API key set", ...fallback(question, current, campus) });

  try {
    const out = prov.name === "gemini" ? await askGemini(prov.key, question, current, campus) : await askClaude(prov.key, question, current, campus);
    res.json({ ok: true, source: prov.name, ...out });
  } catch (err) {
    console.error(`[CampusTwin] AI error (${prov.name}):`, err.message);
    // The demo never breaks, but the screen says why Claude was not used
    res.json({ ok: true, source: "fallback", fallbackReason: err.message.slice(0, 140), ...fallback(question, current, campus) });
  }
});

export default router;
