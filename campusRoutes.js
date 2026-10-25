import { Router } from "express";
import { state, save, num } from "../store.js";

const router = Router();
const MAX_HISTORY = 100;
const ROOM_KEYS = ["classrooms", "deptRooms", "washrooms", "labs"];
const MAX_FLOORS = 60, MAX_ROOMS_PER_FLOOR = 500;
const FACILITY_TYPES = ["academic", "lab", "hostel", "library", "canteen", "admin", "sports", "auditorium", "medical", "workshop", "other"];

// Overview: config + latest readings + endpoint list
router.get("/overview", (req, res) => {
  res.json({
    ok: true,
    config: state.config,
    facilities: state.facilities,
    buildingsReporting: Object.keys(state.readings).length,
    endpoints: [
      "GET  /api/health",
      "GET  /api/campus/overview",
      "GET  /api/campus/buildings",
      "POST /api/campus/configure",
      "POST /api/campus/ingest",
      "GET  /api/campus/facilities",
      "POST /api/campus/facilities",
      "POST /api/simulation/scenarios",
      "GET  /api/simulation/scenarios",
      "POST /api/proposals",
      "GET  /api/proposals",
      "POST /api/ai/suggest"
    ]
  });
});

// Latest reading per building
router.get("/buildings", (req, res) => {
  const buildings = Object.entries(state.readings).map(([id, r]) => ({
    id,
    kw: r.latest.powerDrawKW,
    water: r.latest.waterFlowLPM,
    temp: r.latest.indoorTempC,
    empty: r.latest.emptyRoomsWithPowerOn,
    isLive: true,
    lastUpdate: r.latest.timestamp
  }));
  res.json({ ok: true, buildings });
});

// Save college details. Accepts the full flat shape (older clients may send utilityRates).
router.post("/configure", (req, res) => {
  const b = req.body || {};
  const next = { ...state.config };

  if (b.name !== undefined) {
    if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120)
      return res.status(400).json({ ok: false, error: "name must be a non-empty string (max 120 chars)" });
    next.name = b.name.trim();
  }

  const rates = b.utilityRates || {};
  const fields = {
    areaSqFt: [b.areaSqFt, 100, 1e8],
    buildingCount: [b.buildingCount, 1, 200],
    students: [b.students, 1, 1e6],
    rateElec: [b.rateElec ?? rates.electricityPerKWhINR, 0.01, 1000],
    monthlyKWh: [b.monthlyKWh, 1, 1e9],
    rateWater: [b.rateWater ?? rates.waterPerKiloLitreINR, 0.01, 10000],
    monthlyWaterKL: [b.monthlyWaterKL, 1, 1e7],
    rateWaste: [b.rateWaste, 0, 1000]
  };
  for (const [key, [val, min, max]] of Object.entries(fields)) {
    if (val === undefined) continue;
    const n = num(val, min, max);
    if (n === null) return res.status(400).json({ ok: false, error: `${key} must be a number between ${min} and ${max}` });
    next[key] = n;
  }

  state.config = next;
  save();
  res.json({ ok: true, config: state.config });
});

// Buildings and facilities entered by the user (null = auto-generated sample buildings)
router.get("/facilities", (req, res) => res.json({ ok: true, facilities: state.facilities }));

router.post("/facilities", (req, res) => {
  const list = req.body?.facilities;
  if (list === null) {
    state.facilities = null;
    save();
    return res.json({ ok: true, facilities: null });
  }
  if (!Array.isArray(list) || list.length < 1 || list.length > 50)
    return res.status(400).json({ ok: false, error: "facilities must be null or a list of 1 to 50 buildings" });

  const clean = [];
  const ids = new Set();
  for (let i = 0; i < list.length; i++) {
    const f = list[i] || {};
    const at = `facilities[${i}]`;
    if (typeof f.id !== "string" || !/^b\d{1,3}$/.test(f.id)) return res.status(400).json({ ok: false, error: `${at}.id must look like "b7"` });
    if (ids.has(f.id)) return res.status(400).json({ ok: false, error: `${at}.id "${f.id}" is used twice` });
    ids.add(f.id);
    if (typeof f.name !== "string" || !f.name.trim() || f.name.length > 60)
      return res.status(400).json({ ok: false, error: `${at}.name must be a non-empty string (max 60 chars)` });
    if (!FACILITY_TYPES.includes(f.type)) return res.status(400).json({ ok: false, error: `${at}.type must be one of ${FACILITY_TYPES.join(", ")}` });
    const areaSqFt = num(f.areaSqFt, 100, 1e7), roofSqFt = num(f.roofSqFt, 0, 1e7), capacity = num(f.capacity, 0, 1e5);
    const kw = num(f.kw, 0, 1e5), water = num(f.water, 0, 1e5);
    for (const [k, v, rule] of [["areaSqFt", areaSqFt, "100-10,000,000"], ["roofSqFt", roofSqFt, "0-10,000,000"], ["capacity", capacity, "0-100,000"], ["kw", kw, "0-100,000"], ["water", water, "0-100,000"]])
      if (v === null) return res.status(400).json({ ok: false, error: `${at}.${k} must be a number ${rule}` });
    if (roofSqFt > areaSqFt) return res.status(400).json({ ok: false, error: `${at}.roofSqFt cannot exceed areaSqFt` });
    // Floors and rooms per floor (optional for older clients; validated when present)
    let floors = null, floorPlan = null;
    if (f.floors !== undefined && f.floors !== null) {
      floors = num(f.floors, 1, MAX_FLOORS);
      if (floors === null || !Number.isInteger(floors))
        return res.status(400).json({ ok: false, error: `${at}.floors must be a whole number 1-${MAX_FLOORS}` });
      if (f.floorPlan !== undefined && f.floorPlan !== null) {
        if (!Array.isArray(f.floorPlan) || f.floorPlan.length !== floors)
          return res.status(400).json({ ok: false, error: `${at}.floorPlan must list exactly ${floors} floors` });
        floorPlan = [];
        for (let k = 0; k < floors; k++) {
          const row = {};
          for (const key of ROOM_KEYS) {
            const v = num(f.floorPlan[k]?.[key], 0, MAX_ROOMS_PER_FLOOR);
            if (v === null || !Number.isInteger(v))
              return res.status(400).json({ ok: false, error: `${at}.floorPlan[${k}].${key} must be a whole number 0-${MAX_ROOMS_PER_FLOOR}` });
            row[key] = v;
          }
          floorPlan.push(row);
        }
      }
    }
    clean.push({
      id: f.id, code: typeof f.code === "string" ? f.code.slice(0, 20) : null, name: f.name.trim(), type: f.type,
      areaSqFt, roofSqFt, capacity: Math.round(capacity), kw, water, floors, floorPlan,
      temp: num(f.temp, 0, 60) ?? 25, waste: num(f.waste, 0, 100) ?? 50,
      alert: typeof f.alert === "string" ? f.alert.slice(0, 200) : null, warn: f.warn === true
    });
  }
  state.facilities = clean;
  state.config = { ...state.config, buildingCount: clean.length };
  save();
  res.json({ ok: true, facilities: state.facilities, config: state.config });
});

// Sensor packet
router.post("/ingest", (req, res) => {
  const required = process.env.INGEST_API_KEY;
  if (required && req.get("x-api-key") !== required)
    return res.status(401).json({ ok: false, error: "missing or invalid x-api-key" });

  const b = req.body || {};
  if (typeof b.buildingId !== "string" || !/^b\d{1,3}$/.test(b.buildingId))
    return res.status(400).json({ ok: false, error: "buildingId is required, like \"b1\"" });

  const powerDrawKW = num(b.powerDrawKW, 0, 100000);
  const waterFlowLPM = num(b.waterFlowLPM, 0, 100000);
  const indoorTempC = num(b.indoorTempC, 0, 60);
  const emptyRoomsWithPowerOn = num(b.emptyRoomsWithPowerOn ?? 0, 0, 10000);
  if (powerDrawKW === null) return res.status(400).json({ ok: false, error: "powerDrawKW must be a number 0-100000" });
  if (waterFlowLPM === null) return res.status(400).json({ ok: false, error: "waterFlowLPM must be a number 0-100000" });
  if (indoorTempC === null) return res.status(400).json({ ok: false, error: "indoorTempC must be a number 0-60" });
  if (emptyRoomsWithPowerOn === null) return res.status(400).json({ ok: false, error: "emptyRoomsWithPowerOn must be a number >= 0" });

  const received = new Date().toISOString();
  const reading = {
    powerDrawKW, waterFlowLPM, indoorTempC, emptyRoomsWithPowerOn,
    deviceId: typeof b.deviceId === "string" ? b.deviceId.slice(0, 60) : null,
    timestamp: received
  };

  const entry = state.readings[b.buildingId] || { latest: null, history: [] };
  entry.latest = reading;
  entry.history.push(reading);
  if (entry.history.length > MAX_HISTORY) entry.history.shift();
  state.readings[b.buildingId] = entry;
  save();

  res.json({ ok: true, received });
});

export default router;
