import dotenv from "dotenv";
dotenv.config();

import OpenAI from "openai";
import { v4 as uuidv4 } from "uuid";

import { safeJsonParse } from "./json.js";
import {
  ROUTE_DECISION_PROMPT,
  GENERATE_SETLIST_PROMPT,
  REGENERATE_SETLIST_PROMPT,
  REFINE_SETLIST_PROMPT
} from "./prompts.js";
import { validateSetlistPayload } from "./validate.js";
import { fetchUserLibrary } from "./library.js";

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

function normalize(s) {
  return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function libraryIndex(libraryTracks) {
  const idx = new Map();
  for (const t of libraryTracks || []) {
    const key = `${normalize(t.title)}::${normalize(t.artist)}`;
    idx.set(key, t);
  }
  return idx;
}

// Full required track shape:
// {
//   id, title, artist, genre, album, year, bpm, key, duration, youtubeUrl, tags, userId
// }
function asFullTrackShape({ base, source, libraryTrackId, userId }) {
  return {
    id: base?.id ?? uuidv4(),
    title: base?.title ?? null,
    artist: base?.artist ?? null,
    genre: base?.genre ?? null,
    album: base?.album ?? null,
    year: base?.year ?? null,
    bpm: base?.bpm ?? null,
    key: base?.key ?? null,
    duration: base?.duration ?? null,
    youtubeUrl: base?.youtubeUrl ?? null,
    tags: Array.isArray(base?.tags) ? base.tags : [],
    userId: base?.userId ?? userId ?? null,

    // integration extras
    source: source ?? "external",
    libraryTrackId: libraryTrackId ?? null
  };
}

function enrichSetlistWithLibrary(setlist, libraryTracks, userId) {
  const idx = libraryIndex(libraryTracks);

  const enrichedTracks = (setlist.tracks || []).map((t) => {
    const key = `${normalize(t.title)}::${normalize(t.artist)}`;
    const lib = idx.get(key);

    // AI minimal fields (now includes per-track genre)
    const minimal = {
      title: t.title,
      artist: t.artist,
      genre: t.genre ?? null,
      duration: t.duration
    };

    if (lib) {
      // Copy the library song exactly, but ensure duration is sane
      const merged = {
        ...lib,
        duration: typeof lib.duration === "number" && lib.duration > 0 ? lib.duration : minimal.duration
      };

      return {
        position: t.position,
        ...asFullTrackShape({
          base: merged,
          source: "library",
          libraryTrackId: lib.id,
          userId
        })
      };
    }

    // External: keep AI-provided genre if present, otherwise null
    const externalBase = {
      id: uuidv4(),
      title: minimal.title,
      artist: minimal.artist,
      genre: minimal.genre, // <-- keep per-track genre from AI
      album: null,
      year: null,
      bpm: null,
      key: null,
      duration: minimal.duration,
      youtubeUrl: null,
      tags: [],
      userId: userId ?? null
    };

    return {
      position: t.position,
      ...asFullTrackShape({
        base: externalBase,
        source: "external",
        libraryTrackId: null,
        userId
      })
    };
  });

  return { ...setlist, tracks: enrichedTracks };
}

function computeMeta(setlist) {
  const tracks = setlist?.tracks || [];
  const totalDurationSeconds = tracks.reduce((acc, t) => acc + (Number(t.duration) || 0), 0);
  const totalSongs = tracks.length;

  const sourcesBreakdown = tracks.reduce(
    (acc, t) => {
      const s = t.source || "external";
      acc[s] = (acc[s] || 0) + 1;
      return acc;
    },
    { library: 0, external: 0 }
  );

  return { totalSongs, totalDurationSeconds, sourcesBreakdown };
}

function titlesKey(setlist) {
  const tracks = setlist?.tracks || [];
  return new Set(tracks.map((t) => `${normalize(t.title)}::${normalize(t.artist)}`));
}

function formatLibraryForPrompt(libraryTracks, max = 60) {
  if (!Array.isArray(libraryTracks) || libraryTracks.length === 0) return "[]";
  const sample = libraryTracks.slice(0, max).map((t) => ({
    title: t.title,
    artist: t.artist,
    duration: t.duration,
    genre: t.genre,
    album: t.album,
    year: t.year
  }));
  return JSON.stringify(sample, null, 2);
}

async function getLibraryTracksIfNeeded({ libraryTracks, libraryEndpoint, userId, authToken }) {
  if (Array.isArray(libraryTracks)) return libraryTracks;

  const fetched = await fetchUserLibrary({
    baseUrl: libraryEndpoint,
    userId,
    authToken
  });

  return Array.isArray(fetched) ? fetched : [];
}

export async function runAgentTurn({
  prompt,
  targetDurationMinutes,
  refinement = null,
  previousSetlist = null,
  regenerate = false,

  userId = null,
  libraryTracks = null,
  libraryEndpoint = "http://localhost:3000/songs",
  authToken = null,

  state
}) {
  const nextState = { ...state };

  const resolvedLibraryTracks = await getLibraryTracksIfNeeded({
    libraryTracks,
    libraryEndpoint,
    userId,
    authToken
  });

  // 1) REFINEMENT (max 1)
  if (refinement && previousSetlist) {
    if (nextState.refinementUsed) {
      const meta = computeMeta(nextState.lastSetlist || previousSetlist);
      return {
        type: "setlist",
        setlist: nextState.lastSetlist || previousSetlist,
        followUp: "You can still edit manually in the app.",
        ...meta,
        state: nextState
      };
    }

    const refined = await chatJson({
      system: REFINE_SETLIST_PROMPT,
      user: `
ORIGINAL REQUEST:
"${prompt}"

USER LIBRARY SONGS (prefer these when adding/replacing):
${formatLibraryForPrompt(resolvedLibraryTracks)}

EXISTING SETLIST TO EDIT:
${JSON.stringify(previousSetlist, null, 2)}

CURRENT SETLIST NAME: ${previousSetlist.setlistName || "(none)"}

USER REFINEMENT (ONE cycle max):
"${refinement}"

Target duration minutes (if relevant): ${targetDurationMinutes ?? "not specified"}
`,
      temperature: 0.35
    });

    validateSetlistPayload(refined);

    const enriched = enrichSetlistWithLibrary(refined, resolvedLibraryTracks, userId);

    nextState.lastSetlist = enriched;
    nextState.refinementUsed = true;
    nextState.setlistName = enriched.setlistName;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState
    };
  }

  // 2) REGENERATE
  if (regenerate) {
    const prev = nextState.lastSetlist;
    const prevKeys = prev ? Array.from(titlesKey(prev)) : [];

    const regenerated = await chatJson({
      system: REGENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST (same as before):
"${prompt}"

USER LIBRARY SONGS (prefer these when relevant):
${formatLibraryForPrompt(resolvedLibraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}

PREVIOUS SETLIST TRACKS (avoid reusing these if possible):
${JSON.stringify(prevKeys.slice(0, 80), null, 2)}

Previous name (keep similar vibe): ${nextState.setlistName || (prev?.setlistName ?? "unknown")}
Generate a different setlist now.
`,
      temperature: 0.85
    });

    validateSetlistPayload(regenerated);

    const enriched = enrichSetlistWithLibrary(regenerated, resolvedLibraryTracks, userId);

    nextState.lastSetlist = enriched;
    nextState.refinementUsed = false;
    nextState.setlistName = enriched.setlistName;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState
    };
  }

  // 3) Clarification follow-up -> generate immediately
  if (nextState.clarificationAsked && nextState.pendingPrompt) {
    const combinedPrompt = `${nextState.pendingPrompt}\n\nClarification answer: ${prompt}`;

    const generated = await chatJson({
      system: GENERATE_SETLIST_PROMPT,
      user: `
USER REQUEST:
"${combinedPrompt}"

USER LIBRARY SONGS (prefer these when relevant):
${formatLibraryForPrompt(resolvedLibraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
      temperature: 0.7
    });

    validateSetlistPayload(generated);

    const enriched = enrichSetlistWithLibrary(generated, resolvedLibraryTracks, userId);

    nextState.pendingPrompt = null;
    nextState.clarificationAsked = false;
    nextState.lastSetlist = enriched;
    nextState.refinementUsed = false;
    nextState.originalPrompt = combinedPrompt;
    nextState.setlistName = enriched.setlistName;

    const meta = computeMeta(enriched);

    return {
      type: "setlist",
      setlist: enriched,
      followUp: "Want to make changes?",
      ...meta,
      state: nextState
    };
  }

  // 4) Decision: enough info?
  const decision = await chatJson({
    system: ROUTE_DECISION_PROMPT,
    user: `User prompt: "${prompt}"`,
    temperature: 0
  });

  if (decision.action === "clarify") {
    if (nextState.clarificationAsked) {
      const generated = await chatJson({
        system: GENERATE_SETLIST_PROMPT,
        user: `
USER REQUEST:
"${prompt}"

USER LIBRARY SONGS (prefer these when relevant):
${formatLibraryForPrompt(resolvedLibraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
        temperature: 0.7
      });

      validateSetlistPayload(generated);

      const enriched = enrichSetlistWithLibrary(generated, resolvedLibraryTracks, userId);

      nextState.pendingPrompt = null;
      nextState.clarificationAsked = false;
      nextState.lastSetlist = enriched;
      nextState.refinementUsed = false;
      nextState.originalPrompt = prompt;
      nextState.setlistName = enriched.setlistName;

      const meta = computeMeta(enriched);

      return {
        type: "setlist",
        setlist: enriched,
        followUp: "Want to make changes?",
        ...meta,
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

  // 5) Generate (first turn)
  const generated = await chatJson({
    system: GENERATE_SETLIST_PROMPT,
    user: `
USER REQUEST:
"${prompt}"

USER LIBRARY SONGS (prefer these when relevant):
${formatLibraryForPrompt(resolvedLibraryTracks)}

Target duration minutes: ${targetDurationMinutes ?? "not specified"}
`,
    temperature: 0.7
  });

  validateSetlistPayload(generated);

  const enriched = enrichSetlistWithLibrary(generated, resolvedLibraryTracks, userId);

  nextState.lastSetlist = enriched;
  nextState.refinementUsed = false;
  nextState.originalPrompt = prompt;
  nextState.setlistName = enriched.setlistName;

  const meta = computeMeta(enriched);

  return {
    type: "setlist",
    setlist: enriched,
    followUp: "Want to make changes?",
    ...meta,
    state: nextState
  };
}
