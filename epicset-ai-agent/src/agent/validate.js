export function validateSetlistPayload(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid setlist payload.");
  }

  const { tracks } = payload;
  if (!Array.isArray(tracks) || tracks.length === 0) {
    throw new Error("Setlist must include at least one track.");
  }

  if (tracks.length < 3) {
    throw new Error("Setlist must include at least 3 tracks (MVP rule).");
  }

  for (let i = 0; i < tracks.length; i++) {
    const t = tracks[i];
    if (typeof t.position !== "number" || t.position !== i + 1) {
      throw new Error("Track positions must be ordered 1..N.");
    }
    if (!t.title || typeof t.title !== "string") {
      throw new Error("Each track must have a title.");
    }
    if (!t.artist || typeof t.artist !== "string") {
      throw new Error("Each track must have an artist.");
    }
    if (typeof t.duration !== "number" || t.duration <= 0) {
      throw new Error("Each track must have a positive duration (seconds).");
    }
  }

  return true;
}
