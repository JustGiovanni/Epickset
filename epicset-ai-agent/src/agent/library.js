// src/agent/library.js
// Node 22+ has global fetch, so no extra dependency needed.

export async function fetchUserLibrary({
  baseUrl,
  userId = null,
  authToken = null
}) {
  const url = userId
    ? `${baseUrl}?userId=${encodeURIComponent(userId)}`
    : baseUrl;

  const headers = {};
  // Optional: if backend protects /songs route with JWT, pass it through.
  if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

  const res = await fetch(url, { headers });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Failed to fetch libraryTracks (${res.status}). ${text}`);
  }

  const data = await res.json();

  // Support both styles:
  // - raw array: [...]
  // - wrapped: { songs: [...] }
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.songs)) return data.songs;

  return [];
}
