import { Router } from "express";
import { state, save, num } from "../store.js";

const router = Router();
const KEYS = ["sensors", "solar", "hvac", "aerators", "rain", "waste", "plastic"];

// Save a scenario (sliders + the results the browser computed) for later comparison
router.post("/scenarios", (req, res) => {
  const b = req.body || {};
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 80)
    return res.status(400).json({ ok: false, error: "name is required (max 80 chars)" });
  const sliders = {};
  for (const k of KEYS) {
    const n = num(b.sliders?.[k], 0, 100);
    if (n === null) return res.status(400).json({ ok: false, error: `sliders.${k} must be a number 0-100` });
    sliders[k] = n;
  }
  const scenario = {
    id: "s" + Date.now().toString(36),
    name: b.name.trim(),
    sliders,
    results: b.results && typeof b.results === "object" ? b.results : null,
    createdAt: new Date().toISOString()
  };
  state.scenarios.unshift(scenario);
  state.scenarios = state.scenarios.slice(0, 50);
  save();
  res.json({ ok: true, scenario });
});

router.get("/scenarios", (req, res) => res.json({ ok: true, scenarios: state.scenarios }));

export default router;
