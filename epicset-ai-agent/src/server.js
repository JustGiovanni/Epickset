import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { runAgentTurn } from "./agent/agent.js";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 4000;

app.use(cors());
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", service: "epicset-ai-agent" });
});

app.post("/api/setlist/generate", async (req, res) => {
  try {
    const {
      prompt,
      targetDurationMinutes = null,
      refinement = null,
      previousSetlist = null,
      regenerate = false,
      state = {}
    } = req.body;

    if (typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt must be a string" });
    }

    const p = prompt.trim();
    if (p.length < 5 || p.length > 500) {
      return res.status(400).json({
        error: "Prompt must be between 5 and 500 characters."
      });
    }

    if (refinement != null) {
      if (typeof refinement !== "string") {
        return res.status(400).json({ error: "refinement must be a string" });
      }
      const r = refinement.trim();
      if (r.length < 1 || r.length > 500) {
        return res.status(400).json({
          error: "Refinement must be between 1 and 500 characters."
        });
      }
    }

    const result = await runAgentTurn({
      prompt: p,
      targetDurationMinutes: Number(targetDurationMinutes) || null,
      refinement,
      previousSetlist,
      regenerate: !!regenerate,
      state: {
        pendingPrompt: state.pendingPrompt ?? null,
        clarificationAsked: !!state.clarificationAsked,
        refinementUsed: !!state.refinementUsed,
        lastSetlist: state.lastSetlist ?? null,
        originalPrompt: state.originalPrompt ?? null
      }
    });

    return res.json(result);
  } catch (err) {
    console.error(" Agent error:", err);
    return res.status(500).json({
      error: "Failed to generate setlist",
      message: err.message
    });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(` EpicSet AI Agent running on http://localhost:${PORT}`);
  console.log(` Health check: http://localhost:${PORT}/health`);
});
