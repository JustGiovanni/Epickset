import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";
import { safeJsonParse } from "./json.js";
import {
  ROUTE_DECISION_PROMPT,
  GENERATE_SETLIST_PROMPT,
  REGENERATE_SETLIST_PROMPT,
  REFINE_SETLIST_PROMPT,
} from "./prompts.js";
import { validateSetlistPayload } from "./validate.js";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
import { youtubeSearchFirstVideo } from "../services/youtube.js";

async function enrichWithYoutube(setlist) {
  if (!setlist || !setlist.tracks || !Array.isArray(setlist.tracks))
    return setlist;

  console.log(`Searching YouTube for ${setlist.tracks.length} tracks...`);

  // Parallel fetch
  await Promise.all(
    setlist.tracks.map(async (track) => {
      if (track.youtubeUrl) return; // already has it?

      try {
        const query = `${track.title} ${track.artist}`;
        const video = await youtubeSearchFirstVideo(query);
        if (video) {
          track.youtubeUrl = `https://www.youtube.com/watch?v=${video.videoId}`;
        }
      } catch (err) {
        console.error(`Failed to find video for ${track.title}:`, err.message);
      }
    }),
  );

  return setlist;
}

async function chatJson({ system, user, temperature = 0.4 }) {
  const resp = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    temperature,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  });

  const text = resp.choices?.[0]?.message?.content ?? "";
  return safeJsonParse(text);
}

function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function libraryIndex(libraryTracks) {
  const idx = new Map();
  for (const t of libraryTracks || []) {
    const key = `${normalize(t.title)}::${normalize(t.artist)}`;
    idx.set(key, t);
  }
  return idx;
}

function attachLibraryMeta(setlist, libraryTracks) {
  const idx = libraryIndex(libraryTracks);

  const enrichedTracks = (setlist.tracks || []).map((t) => {
    const key = `${normalize(t.title)}::${normalize(t.artist)}`;
    const lib = idx.get(key);

    if (lib) {
      return {
        ...t,
        source: "library",
        libraryTrackId: lib.id ?? lib.trackId ?? lib._id ?? null,
        // prefer library duration if available and sane
        duration:
          typeof lib.duration === "number" && lib.duration > 0
            ? lib.duration
            : t.duration,
      };
    }

    return { ...t, source: "external", libraryTrackId: null };
  });

  return { ...setlist, tracks: enrichedTracks };
}

function computeMeta(setlist) {
  const tracks = setlist?.tracks || [];
  const totalDurationSeconds = tracks.reduce(
    (acc, t) => acc + (Number(t.duration) || 0),
    0,
  );
  const totalSongs = tracks.length;

  const sourcesBreakdown = tracks.reduce(
    (acc, t) => {
      const s = t.source || "external";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { library: 0, external: 0 },
  );

  return { totalSongs, totalDurationSeconds, sourcesBreakdown };
}

function titlesKey(setlist) {
  const tracks = setlist?.tracks || [];
  return new Set(
    tracks.map((t) => `${normalize(t.title)}::${normalize(t.artist)}`),
  );
}

function formatLibraryForPrompt(libraryTracks, max = 60) {
  if (!Array.isArray(libraryTracks) || libraryTracks.length === 0) return "[]";
  const sample = libraryTracks.slice(0, max).map((t) => ({
    title: t.title,
    artist: t.artist,
    duration: t.duration,
  }));
  return JSON.stringify(sample, null, 2);
}

export async function runAgentTurn({
  prompt,
  targetDurationMinutes,
  refinement = null,
  previousSetlist = null,
  regenerate = false,
  libraryTracks = [],
  state,
}) {
  const nextState = { ...state };

  // -------------------------
  // 1) REFINEMENT (max 1)
  // -------------------------
  if (refinement && previousSetlist) {
    if (nextState.refinementUsed) {
      const meta = computeMeta(nextState.lastSetlist || previousSetlist);
      return {
        type: "setlist",
        setlist: nextState.lastSetlist || previousSetlist,
        followUp: "You can still edit manually in the app.",
        ...meta,
        state: nextState,
      };
    }

    const refined = await chatJson({
      system: REFINE_SETLIST_PROMPT,
      user: `
ORIGINAL REQUEST:
"${prompt}"

USER LIBRARY TRACKS (prefer these when adding/replacing):
${formatLibraryForPrompt(libraryTracks)}

EXISTING SETLIST TO EDIT:
${JSON.stringify(previousSetlist, null, 2)}

USER REFINEMENT (ONE cycle max):
"${refinement}"

Target duration minutes (if relevant): ${targetDurationMinutes ?? "not specified"}
`,
      temperature: 0.35,
    });

    validateSetlistPayload(refined);
    await enrichWithYoutube(refined);

    const enriched = attachLibraryMeta(refined, libraryTracks);

    nextState.lastSetlist = enriched;
    nextState.refinementUsed = true;
    nextState.genre = enriched.genre;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState,
    };
  }

  // -------------------------
  // 2) REGENERATE
  // -------------------------
  if (regenerate) {
    const prev = nextState.lastSetlist;
    const prevKeys = prev ? Array.from(titlesKey(prev)) : [];

    const regenerated = await chatJson({
      system: REGENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST (same as before):
"${prompt}"

USER LIBRARY TRACKS (prefer these when relevant):
${formatLibraryForPrompt(libraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}

PREVIOUS SETLIST TRACKS (avoid reusing these if possible):
${JSON.stringify(prevKeys.slice(0, 80), null, 2)}

If there was a previous genre, keep it consistent: ${nextState.genre || (prev?.genre ?? "unknown")}
Generate a different setlist now.
`,
      temperature: 0.85,
    });

    validateSetlistPayload(regenerated);
    await enrichWithYoutube(regenerated);

    const enriched = attachLibraryMeta(regenerated, libraryTracks);

    nextState.lastSetlist = enriched;
    nextState.refinementUsed = false;
    nextState.genre = enriched.genre;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState,
    };
  }

  // -------------------------
  // 3) If clarification was asked previously, generate now
  // -------------------------
  if (nextState.clarificationAsked && nextState.pendingPrompt) {
    const combinedPrompt = `${nextState.pendingPrompt}\n\nClarification answer: ${prompt}`;

    const generated = await chatJson({
      system: GENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST:
"${combinedPrompt}"

USER LIBRARY TRACKS (prefer these when relevant):
${formatLibraryForPrompt(libraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
      temperature: 0.7,
    });

    validateSetlistPayload(generated);
    await enrichWithYoutube(generated);

    const enriched = attachLibraryMeta(generated, libraryTracks);

    nextState.pendingPrompt = null;
    nextState.clarificationAsked = false;
    nextState.lastSetlist = enriched;
    nextState.refinementUsed = false;
    nextState.originalPrompt = combinedPrompt;
    nextState.genre = enriched.genre;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState,
    };
  }

  // -------------------------
  // 4) Decision: enough info?
  // -------------------------
  const decision = await chatJson({
    system: ROUTE_DECISION_PROMPT,
    user: `User prompt: "${prompt}"`,
    temperature: 0,
  });

  if (decision.action === "clarify") {
    if (nextState.clarificationAsked) {
      const generated = await chatJson({
        system: GENERATE_SETLIST_PROMPT,
        user: `
USER REQUEST:
"${prompt}"

USER LIBRARY TRACKS (prefer these when relevant):
${formatLibraryForPrompt(libraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
        temperature: 0.7,
      });

      validateSetlistPayload(generated);
      await enrichWithYoutube(generated);

      const enriched = attachLibraryMeta(generated, libraryTracks);

      nextState.pendingPrompt = null;
      nextState.clarificationAsked = false;
      nextState.lastSetlist = enriched;
      nextState.refinementUsed = false;
      nextState.originalPrompt = prompt;
      nextState.genre = enriched.genre;

      const meta = computeMeta(enriched);

      return {
        type: "setlist",
        setlist: enriched,
        followUp: "Want to make changes?",
        ...meta,
        state: nextState,
      };
    }

    nextState.pendingPrompt = prompt;
    nextState.clarificationAsked = true;

    return {
      type: "clarify",
      question: decision.question || "What style or event is this setlist for?",
      state: nextState,
    };
  }

  // -------------------------
  // 5) Generate
  // -------------------------
  const generated = await chatJson({
    system: GENERATE_SETLIST_PROMPT,
    user: `
USER REQUEST:
"${prompt}"

USER LIBRARY TRACKS (prefer these when relevant):
${formatLibraryForPrompt(libraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
    temperature: 0.7,
  });

  validateSetlistPayload(generated);
  await enrichWithYoutube(generated);

  const enriched = attachLibraryMeta(generated, libraryTracks);

  nextState.lastSetlist = enriched;
  nextState.refinementUsed = false;
  nextState.originalPrompt = prompt;
  nextState.genre = enriched.genre;

  const meta = computeMeta(enriched);

  return {
    type: "setlist",
    setlist: enriched,
    followUp: "Want to make changes?",
    ...meta,
    state: nextState,
  };
}
