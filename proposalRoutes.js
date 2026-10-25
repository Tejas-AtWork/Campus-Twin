import { Router } from "express";
import { state, save } from "../store.js";

const router = Router();

// Save a generated proposal snapshot
router.post("/", (req, res) => {
  const b = req.body || {};
  if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 120)
    return res.status(400).json({ ok: false, error: "title is required (max 120 chars)" });
  const proposal = {
    id: "p" + Date.now().toString(36),
    title: b.title.trim(),
    summary: typeof b.summary === "string" ? b.summary.slice(0, 2000) : "",
    data: b.data && typeof b.data === "object" ? b.data : null,
    createdAt: new Date().toISOString()
  };
  state.proposals.unshift(proposal);
  state.proposals = state.proposals.slice(0, 50);
  save();
  res.json({ ok: true, proposal });
});

router.get("/", (req, res) => res.json({ ok: true, proposals: state.proposals }));

export default router;
