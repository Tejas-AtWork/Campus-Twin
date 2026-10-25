import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "data.json");

const defaults = {
  config: {
    name: "Apex Institute of Technology",
    areaSqFt: 252000,
    buildingCount: 6,
    students: 4800,
    rateElec: 9.5,
    monthlyKWh: 125000,
    rateWater: 45,
    monthlyWaterKL: 1800,
    rateWaste: 5.5
  },
  facilities: null,   // null = auto-generated sample buildings; array = buildings entered by the user
  readings: {},   // buildingId -> { latest, history[] }
  scenarios: [],
  proposals: []
};

let loaded = {};
try { loaded = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { /* first run */ }

export const state = { ...defaults, ...loaded };

let timer = null;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { fs.writeFileSync(FILE, JSON.stringify(state)); } catch { /* read-only disk is fine */ }
  }, 300);
}

export function num(v, min, max) {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : null;
}
