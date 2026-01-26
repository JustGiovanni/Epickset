function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`${name} missing in .env`);
  return v;
}

export async function youtubeSearchFirstVideo(query) {
  const key = requireEnv("YOUTUBE_API_KEY");
  const url =
    "https://www.googleapis.com/youtube/v3/search" +
    `?part=snippet&type=video&maxResults=1&q=${encodeURIComponent(query)}&key=${encodeURIComponent(key)}`;

  const res = await fetch(url);
  const data = await res.json();

  if (!res.ok) {
    const reason = data?.error?.message || "YouTube API error";
    throw new Error(`YouTube  error: ${res.status} ${reason}`);
  }

  const item = data.items?.[0];
  if (!item) return null;

  return {
    videoId: item.id.videoId,
    title: item.snippet.title,
    channel: item.snippet.channelTitle
  };
}
