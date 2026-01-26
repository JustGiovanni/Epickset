import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";
import { safeJsonParse } from "./json.js";
import {
  ROUTE_DECISION_PROMPT,
  GENERATE_SETLIST_PROMPT,
  REGENERATE_SETLIST_PROMPT,
  REFINE_SETLIST_PROMPT
} from "./prompts.js";
import { validateSetlistPayload } from "./validate.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function chatJson({ system, user, temperature = 0.4 }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ]
  });

  const text = resp.choices?.[0]?.message?.content ?? "";
  return safeJsonParse(text);
}

function titlesKey(setlist) {
  const tracks = setlist?.tracks || [];
  return new Set(
    tracks.map((t) => `${(t.title || "").toLowerCase().trim()}::${(t.artist || "").toLowerCase().trim()}`)
  );
}

export async function runAgentTurn({
  prompt,
  targetDurationMinutes,
  refinement = null,
  previousSetlist = null,
  regenerate = false,
  state
}) {
  const nextState = { ...state };

  // -------------------------
  // 1) REFINEMENT (max 1)
  // -------------------------
  if (refinement && previousSetlist) {
    if (nextState.refinementUsed) {
      // MVP rule: only one refinement cycle
      return {
        type: "setlist",
        setlist: nextState.lastSetlist || previousSetlist,
        followUp: "You can still edit manually in the app.",
        state: nextState
      };
    }

    const refined = await chatJson({
      system: REFINE_SETLIST_PROMPT,
      user: `
ORIGINAL REQUEST (for context):
"${prompt}"

EXISTING SETLIST TO EDIT:
${JSON.stringify(previousSetlist, null, 2)}

USER REFINEMENT (ONE cycle max):
"${refinement}"

Target duration minutes (if relevant): ${targetDurationMinutes ?? "not specified"}

Remember: minimal edits, keep most tracks, do not regenerate from scratch.
`,
      temperature: 0.35
    });

    validateSetlistPayload(refined);

    nextState.lastSetlist = refined;
    nextState.refinementUsed = true;

    return {
      type: "setlist",
      setlist: refined,
      followUp: "Want to make changes?",
      state: nextState
    };
  }

  // 
  // 2) REGENERATE (fresh setlist)
  //
  if (regenerate) {
    const prev = nextState.lastSetlist;
    const prevKeys = prev ? Array.from(titlesKey(prev)) : [];

    const regenerated = await chatJson({
      system: REGENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST (same as before):
"${prompt}"

Target duration minutes: ${targetDurationMinutes ?? "not specified"}

PREVIOUS SETLIST TRACKS (avoid reusing these if possible):
${JSON.stringify(prevKeys.slice(0, 50), null, 2)}

Generate a different setlist now.
`,
      temperature: 0.85
    });

    validateSetlistPayload(regenerated);

    // reset refinement allowance for the new setlist (still MVP one cycle on the new result)
    nextState.lastSetlist = regenerated;
    nextState.refinementUsed = false;

    return {
      type: "setlist",
      setlist: regenerated,
      followUp: "Want to make changes?",
      state: nextState
    };
  }

  // 
  // 3) If a clarification was asked previously, generate immediately now
  //
  if (nextState.clarificationAsked && nextState.pendingPrompt) {
    const combinedPrompt = `${nextState.pendingPrompt}\n\nClarification answer: ${prompt}`;

    const generated = await chatJson({
      system: GENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST:
"${combinedPrompt}"

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
      temperature: 0.7
    });

    validateSetlistPayload(generated);

    nextState.pendingPrompt = null;
    nextState.clarificationAsked = false;
    nextState.lastSetlist = generated;
    nextState.refinementUsed = false;

    // store the “resolved prompt” so regen can reuse it later
    nextState.originalPrompt = combinedPrompt;

    return {
      type: "setlist",
      setlist: generated,
      followUp: "Want to make changes?",
      state: nextState
    };
  }

  // 
  // 4) Decision: enough info?
  // 
  const decision = await chatJson({
    system: ROUTE_DECISION_PROMPT,
    user: `User prompt: "${prompt}"`,
    temperature: 0
  });

  if (decision.action === "clarify") {
    // Enforce global MVP rule: max 1 clarification question
    if (nextState.clarificationAsked) {
      // already asked once; must generate anyway
      const generated = await chatJson({
        system: GENERATE_SETLIST_PROMPT,
        user: `
USER REQUEST:
"${prompt}"

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
        temperature: 0.7
      });

      validateSetlistPayload(generated);

      nextState.pendingPrompt = null;
      nextState.clarificationAsked = false;
      nextState.lastSetlist = generated;
      nextState.refinementUsed = false;
      nextState.originalPrompt = prompt;

      return {
        type: "setlist",
        setlist: generated,
        followUp: "Want to make changes?",
        state: nextState
      };
    }

    nextState.pendingPrompt = prompt;
    nextState.clarificationAsked = true;

    return {
      type: "clarify",
      question: decision.question || "What style or event is this setlist for?",
      state: nextState
    };
  }

  // 
  // 5) Generate
  // 
  const generated = await chatJson({
    system: GENERATE_SETLIST_PROMPT,
    user: `
USER REQUEST:
"${prompt}"

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
    temperature: 0.7
  });

  validateSetlistPayload(generated);

  nextState.lastSetlist = generated;
  nextState.refinementUsed = false;
  nextState.originalPrompt = prompt;

  return {
    type: "setlist",
    setlist: generated,
    followUp: "Want to make changes?",
    state: nextState
  };
}
