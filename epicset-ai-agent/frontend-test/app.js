const API = "http://localhost:4000/api/setlist/generate";

const screenLanding = document.getElementById("screenLanding");
const screenGenerating = document.getElementById("screenGenerating");
const screenResult = document.getElementById("screenResult");

const promptInput = document.getElementById("promptInput");
const durationInput = document.getElementById("durationInput");
const generateBtn = document.getElementById("generateBtn");

const regenerateBtn = document.getElementById("regenerateBtn");
const saveBtn = document.getElementById("saveBtn");

const bottomPrompt = document.getElementById("bottomPrompt");
const sendBtn = document.getElementById("sendBtn");

const genPromptBubble = document.getElementById("genPromptBubble");
const resultExplanation = document.getElementById("resultExplanation");

const songsStat = document.getElementById("songsStat");
const durationStat = document.getElementById("durationStat");
const trackList = document.getElementById("trackList");

const charCount = document.getElementById("charCount");
const toast = document.getElementById("toast");

const chipsEl = document.getElementById("chips");

const SUGGESTED_PROMPTS = [
  "Upbeat indie rock set for a summer festival with crowd favourites…",
  "Chill acoustic coffee shop vibes with soft sing-alongs…",
  "High energy 90s rock throwback night (big choruses)…",
  "Romantic jazz evening for a wedding reception…",
  "Classic country hits for a honky tonk…",
  "Church service setlist based on Mark 3:11 (uplifting worship)…"
];

let lastPrompt = "";
let lastDuration = 45;

function show(el) {
  screenLanding.classList.add("hidden");
  screenGenerating.classList.add("hidden");
  screenResult.classList.add("hidden");
  el.classList.remove("hidden");
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.remove("hidden");
  setTimeout(() => toast.classList.add("hidden"), 2600);
}

function minutesFromSeconds(sec) {
  return Math.round((sec || 0) / 60);
}

function renderChips() {
  chipsEl.innerHTML = "";
  SUGGESTED_PROMPTS.forEach((p) => {
    const b = document.createElement("button");
    b.className = "chip";
    b.type = "button";
    b.textContent = p;
    b.addEventListener("click", () => {
      promptInput.value = p;
      charCount.textContent = String(promptInput.value.length);
      promptInput.focus();
    });
    chipsEl.appendChild(b);
  });
}

function renderResult(data) {
  trackList.innerHTML = "";

  // NEW: handle special response types
  if (data.type === "refusal") {
    resultExplanation.textContent = data.message || "I can only help with music-related requests.";
    songsStat.textContent = "0";
    durationStat.textContent = "0";
    return;
  }

  if (data.type === "question") {
    const qs = (data.questions || []).map((q, i) => `${i + 1}. ${q}`).join(" ");
    resultExplanation.textContent =
      (data.message || "Quick question before I generate your setlist:") +
      (qs ? ` ${qs}` : "");
    songsStat.textContent = "0";
    durationStat.textContent = "0";
    return;
  }

  if (data.type === "error") {
    resultExplanation.textContent = data.message || "Something went wrong.";
    songsStat.textContent = "0";
    durationStat.textContent = "0";
    return;
  }

  // Normal setlist
  const totalSongs = data.totalSongs ?? (data.tracks?.length || 0);
  const totalMins = minutesFromSeconds(data.totalDuration);

  songsStat.textContent = String(totalSongs);
  durationStat.textContent = String(totalMins);

  resultExplanation.textContent =
    data.explanation || "Here’s your setlist based on your request:";

  (data.tracks || []).forEach((t, idx) => {
    const row = document.createElement("div");
    row.className = "track";

    const left = document.createElement("div");
    left.className = "trackLeft";

    const num = document.createElement("div");
    num.className = "trackNum";
    num.textContent = String(idx + 1);

    const meta = document.createElement("div");
    meta.className = "trackMeta";

    const title = document.createElement("div");
    title.className = "trackTitle";
    title.textContent = t.title || "Untitled";

    const sub = document.createElement("div");
    sub.className = "trackSub";
    const src = t.source ? ` • ${t.source}` : "";
    sub.textContent = `${t.artist || "Unknown artist"}${src}`;

    meta.appendChild(title);
    meta.appendChild(sub);

    left.appendChild(num);
    left.appendChild(meta);

    const right = document.createElement("div");
    right.className = "trackRight";
    right.textContent = `${minutesFromSeconds(t.duration)} min`;

    row.appendChild(left);
    row.appendChild(right);

    trackList.appendChild(row);
  });
}

async function callGenerate(prompt, mins) {
  const res = await fetch(API, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      prompt,
      targetDurationMinutes: mins
    })
  });

  const json = await res.json();

  // backend can return { type:"error" } but with 500/400, so handle both
  if (!res.ok) {
    throw new Error(json?.message || "Request failed");
  }
  return json;
}

async function generate({ prompt, mins }) {
  lastPrompt = prompt;
  lastDuration = mins;

  genPromptBubble.textContent = prompt;
  show(screenGenerating);

  try {
    const data = await callGenerate(prompt, mins);
    renderResult(data);
    show(screenResult);
  } catch (e) {
    showToast(e.message);
    show(screenLanding);
  }
}

generateBtn.addEventListener("click", () => {
  const p = promptInput.value.trim();
  const mins = Number(durationInput.value) || 45;
  if (!p) return showToast("Enter a prompt or click one of the suggestions.");
  generate({ prompt: p, mins });
});

promptInput.addEventListener("input", () => {
  charCount.textContent = String(promptInput.value.length);
});

regenerateBtn.addEventListener("click", async () => {
  await generate({ prompt: lastPrompt, mins: lastDuration });
});

saveBtn.addEventListener("click", () => {
  alert("Save Setlist (mock). Next step: integrate with your backend APIs.");
});

sendBtn.addEventListener("click", () => {
  const p = bottomPrompt.value.trim();
  if (!p) return;
  bottomPrompt.value = "";
  const mins = Number(durationInput.value) || lastDuration || 45;
  generate({ prompt: p, mins });
});

bottomPrompt.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    sendBtn.click();
  }
});

renderChips();
charCount.textContent = "0";
show(screenLanding);
