export function totalDurationSeconds(tracks) {
  return (tracks || []).reduce((sum, t) => sum + (t.duration || 0), 0);
}

/**
 * Keep required tracks, then fill up to target with the remaining tracks in order.
 * If required tracks already exceed target, we still return them (and report it).
 */
export function fitTracksToTarget({ tracks, targetSeconds, requiredPredicate }) {
  if (!targetSeconds || targetSeconds <= 0) {
    return { tracks, exceeded: false };
  }

  const required = [];
  const optional = [];

  for (const tr of tracks) {
    if (requiredPredicate(tr)) required.push(tr);
    else optional.push(tr);
  }

  let out = [...required];
  let cur = totalDurationSeconds(out);

  for (const tr of optional) {
    if (cur + tr.duration > targetSeconds) continue;
    out.push(tr);
    cur += tr.duration;
  }

  return {
    tracks: out,
    exceeded: totalDurationSeconds(required) > targetSeconds
  };
}
