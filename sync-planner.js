// Copies server/planner.js into client/dist/index.html (between the PLANNER markers) so the
// browser planner works even when the backend cannot be reached.  Run: npm run sync-planner
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = fs.readFileSync(path.join(root, "server/planner.js"), "utf8").replace(/^export /gm, "");
const htmlPath = path.join(root, "client/dist/index.html");
let html = fs.readFileSync(htmlPath, "utf8");

const start = "/* PLANNER:START (generated from server/planner.js by scripts/sync-planner.js, do not edit here) */";
const end = "/* PLANNER:END */";
const block = `${start}\nconst CampusPlanner = (() => {\n${src}\nreturn { fallback, clampSliders, EXAMPLES };\n})();\n${end}`;
const a = html.indexOf(start), b = html.indexOf(end);
if (a < 0 || b < a) throw new Error("PLANNER markers not found in index.html");
html = html.slice(0, a) + block + html.slice(b + end.length);
fs.writeFileSync(htmlPath, html);
console.log("planner synced into client/dist/index.html");
