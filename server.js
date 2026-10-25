import "dotenv/config";
import express from "express";
import cors from "cors";
import compression from "compression";
import path from "path";
import { fileURLToPath } from "url";
import campusRoutes from "./routes/campusRoutes.js";
import simulationRoutes from "./routes/simulationRoutes.js";
import proposalRoutes from "./routes/proposalRoutes.js";
import aiRoutes, { activeProvider } from "./routes/aiRoutes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 5000;

app.set("trust proxy", 1);          // correct client IPs behind Render/Railway
app.use(compression());          // gzip: the page is ~180 KB uncompressed
app.use(cors());
app.use(express.json({ limit: "100kb" }));

// API Routes
app.use("/api/campus", campusRoutes);
app.use("/api/simulation", simulationRoutes);
app.use("/api/simulate", simulationRoutes);
app.use("/api/proposals", proposalRoutes);
app.use("/api/ai", aiRoutes);

// Health check
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    status: "online",
    system: "CampusTwin Backend Core",
    version: "1.1.0",
    ai: activeProvider()?.name ?? "fallback-rules",
    uptimeSeconds: Math.floor(process.uptime())
  });
});

// Unknown API routes return JSON, not HTML
app.use("/api", (req, res) => res.status(404).json({ ok: false, error: "unknown endpoint" }));

// Serve the front end
const clientDistPath = path.join(__dirname, "../client/dist");
app.get("/favicon.ico", (req, res) => res.redirect(301, "/favicon.svg"));   // browsers ask for this by default
app.use(express.static(clientDistPath));

// Anything else is a real 404 (custom page, correct status code), not the home page
app.use((req, res) => {
  res.status(404).sendFile(path.join(clientDistPath, "404.html"), (err) => {
    if (err && !res.headersSent) res.status(404).type("text/plain").send("404: page not found");
  });
});

// Malformed JSON and other errors
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed") return res.status(400).json({ ok: false, error: "invalid JSON body" });
  console.error(err);
  res.status(500).json({ ok: false, error: "internal server error" });
});

app.listen(PORT, () => {
  console.log(`[CampusTwin] Backend server active at http://localhost:${PORT}`);
  console.log(`[CampusTwin] Endpoint list: http://localhost:${PORT}/api/campus/overview`);
});
