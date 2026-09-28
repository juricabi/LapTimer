"use strict";

// ═══════════════════════════════════════════════════════════════════
//  Helpers and constants
// ═══════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

const BANDS = ["A", "B", "E", "F", "R", "L"];
const FREQ_TABLE = [
  [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
  [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621],
];
const MAX_PILOTS = 4;
const HOP_MS_PER_PILOT = 14; // firmware: 8 ms settle + 6 ms sampling per pilot

// firmware race states and modes
const STATE = { IDLE: 0, COUNTDOWN: 1, WAITING: 2, RUNNING: 3, FINISHED: 4 };
const MODE = { PRACTICE: 0, TIMED: 1, LAPS: 2 };
const MODE_NAMES = ["Practice", "Timed race", "Lap race"];

function bandChannel(freq) {
  for (let b = 0; b < FREQ_TABLE.length; b++) {
    const c = FREQ_TABLE[b].indexOf(freq);
    if (c >= 0) return { band: b, channel: c };
  }
  return null;
}

function channelName(freq) {
  const bc = bandChannel(freq);
  return bc ? BANDS[bc.band] + (bc.channel + 1) : "";
}

function pilotLabel(name, index) {
  return name && name.trim() ? name.trim() : "Pilot " + (index + 1);
}

function secs(ms) {
  return (ms / 1000).toFixed(2);
}

function formatClock(ms) {
  const totalCs = Math.floor(Math.max(0, ms) / 10);
  const cs = totalCs % 100;
  const s = Math.floor(totalCs / 100) % 60;
  const m = Math.floor(totalCs / 6000);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function formatMinSec(totalSec) {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

function el(tag, className, text) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  if (!response.ok) throw new Error(url + ": HTTP " + response.status);
  return response.json();
}

function postJson(url, body) {
  return fetchJson(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

// Temporarily replaces a button's label; holdMs 0 keeps it until the next call
function showButtonStatus(button, text, holdMs = 4000) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  clearTimeout(button.statusTimer);
  button.textContent = text;
  if (holdMs) button.statusTimer = setTimeout(() => (button.textContent = button.dataset.label), holdMs);
}

// Briefly show the save result on the button that was pressed.
function showSaveResult(button, ok) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  clearTimeout(button.saveTimer);
  button.textContent = ok ? "Saved ✓" : "Save failed ✗";
  button.classList.toggle("save-ok", ok);
  button.classList.toggle("save-failed", !ok);
  button.disabled = false;
  button.saveTimer = setTimeout(() => {
    button.textContent = button.dataset.label;
    button.classList.remove("save-ok", "save-failed");
  }, 2000);
}

function setupSegmented(container, onChange) {
  container.addEventListener("click", (e) => {
    const button = e.target.closest("button");
    if (!button) return;
    setSegmented(container, button.dataset.value);
    onChange(button.dataset.value);
  });
}

function setSegmented(container, value) {
  for (const b of container.querySelectorAll("button")) {
    b.classList.toggle("active", b.dataset.value == value);
  }
}

function bindRange(input, format, onInput) {
  const label = input.parentElement.querySelector(".val");
  const update = () => {
    if (label) label.textContent = format(parseFloat(input.value));
    if (onInput) onInput(parseFloat(input.value));
  };
  input.addEventListener("input", update);
  return update;
}

// ═══════════════════════════════════════════════════════════════════
//  Settings (Setup tab)
// ═══════════════════════════════════════════════════════════════════

let configLoaded = false;
let pilotCount = 1;
let pilots = []; // [{name, freq, enter, exit}] for all MAX_PILOTS slots
let raceMode = MODE.PRACTICE;
let announcerRate = 1.0;
let profiles = [];

const ui = {
  pilotList: $("pilotList"),
  pilotHint: $("pilotHint"),
  raceTime: $("raceTime"),
  raceLaps: $("raceLaps"),
  countdown: $("countdown"),
  minLap: $("minLap"),
  announcer: $("announcerSelect"),
  rate: $("rate"),
  anDelta: $("anDelta"),
  voiceToggle: $("voiceToggle"),
  buzzer: $("buzzerToggle"),
  alarm: $("alarmThreshold"),
  ssid: $("ssid"),
  pwd: $("pwd"),
};

const updateRaceTimeLabel = bindRange(ui.raceTime, (v) => formatMinSec(v));
const updateRaceLapsLabel = bindRange(ui.raceLaps, (v) => String(v));
const updateMinLapLabel = bindRange(ui.minLap, (v) => v.toFixed(1) + "s");
const updateRateLabel = bindRange(ui.rate, (v) => v.toFixed(1), (v) => (announcerRate = v));
const updateAlarmLabel = bindRange(ui.alarm, (v) => (v == 0 ? "Off" : v.toFixed(1) + "v"));

function buildPilotRows() {
  ui.pilotList.innerHTML = "";
  for (let i = 0; i < MAX_PILOTS; i++) {
    const row = el("div", "pilot-row pilot-" + (i + 1));
    row.dataset.index = i;
    row.innerHTML = `
      <div class="pilot-head">
        <span class="dot-p"></span>
        <input type="text" class="p-name" maxlength="20" placeholder="Pilot ${i + 1}" aria-label="Pilot ${i + 1} name" />
        <span class="freq-pill"><span class="p-freq">----</span><small>MHz</small></span>
      </div>
      <div class="pilot-freq">
        <select class="p-band" aria-label="Band">${BANDS.map((b, n) => `<option value="${n}">Band ${b}</option>`).join("")}</select>
        <select class="p-channel" aria-label="Channel">${[1, 2, 3, 4, 5, 6, 7, 8].map((c) => `<option value="${c - 1}">Channel ${c}</option>`).join("")}</select>
      </div>
      <div class="pilot-profile">
        <select class="p-profile" aria-label="Load pilot profile"></select>
        <button class="btn btn-ghost p-save-profile">Save profile</button>
      </div>`;
    const p = pilots[i];
    row.querySelector(".p-name").addEventListener("input", (e) => (p.name = e.target.value));
    const onFreq = () => {
      const b = +row.querySelector(".p-band").value;
      const c = +row.querySelector(".p-channel").value;
      p.freq = FREQ_TABLE[b][c];
      renderPilotRow(i);
      renderPilotHint();
    };
    row.querySelector(".p-band").addEventListener("change", onFreq);
    row.querySelector(".p-channel").addEventListener("change", onFreq);
    row.querySelector(".p-profile").addEventListener("change", (e) => {
      const profile = profiles[+e.target.value];
      e.target.value = "";
      if (!profile) return;
      Object.assign(p, { name: profile.name, freq: profile.freq, enter: profile.enter, exit: profile.exit });
      renderPilotRow(i);
      renderPilotHint();
      renderCalibration();
    });
    row.querySelector(".p-save-profile").addEventListener("click", (e) => saveProfile(i, e.target));
    ui.pilotList.appendChild(row);
  }
}

function renderPilotRow(i) {
  const row = ui.pilotList.children[i];
  const p = pilots[i];
  row.hidden = i >= pilotCount;
  row.querySelector(".p-name").value = p.name || "";
  const bc = bandChannel(p.freq) || { band: 4, channel: 0 };
  row.querySelector(".p-band").value = bc.band;
  row.querySelector(".p-channel").value = bc.channel;
  row.querySelector(".p-freq").textContent = p.freq;
  renderProfileSelect(row.querySelector(".p-profile"));
}

function renderProfileSelect(select) {
  select.innerHTML =
    `<option value="">${profiles.length ? "Load profile…" : "No saved profiles"}</option>` +
    profiles.map((pr, n) => `<option value="${n}">${escapeHtml(pr.name)} · ${channelName(pr.freq) || pr.freq}</option>`).join("");
}

function renderPilots() {
  for (let i = 0; i < MAX_PILOTS; i++) renderPilotRow(i);
  setSegmented($("pilotCount"), pilotCount);
  renderPilotHint();
}

// Precision note and warnings for frequencies that are equal or too close
function renderPilotHint() {
  let text;
  if (pilotCount === 1) {
    text = "One pilot: the receiver stays on one channel for full timing precision.";
  } else {
    text = `${pilotCount} pilots share the receiver, which switches between their channels: timing precision about ±${(HOP_MS_PER_PILOT / 2) * pilotCount} ms.`;
  }
  const active = pilots.slice(0, pilotCount);
  const warnings = [];
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      const gap = Math.abs(active[a].freq - active[b].freq);
      if (gap === 0) warnings.push(`Pilots ${a + 1} and ${b + 1} are on the same channel.`);
      else if (gap < 30) warnings.push(`Pilots ${a + 1} and ${b + 1} are only ${gap} MHz apart; laps may be mixed up.`);
    }
  }
  ui.pilotHint.innerHTML = escapeHtml(text) + warnings.map((w) => `<br><span class="warn">${escapeHtml(w)}</span>`).join("");
}

setupSegmented($("pilotCount"), (v) => {
  pilotCount = +v;
  renderPilots();
  renderCalibPilotButtons();
});

setupSegmented($("raceMode"), (v) => {
  raceMode = +v;
  renderRaceModeFields();
});

function renderRaceModeFields() {
  setSegmented($("raceMode"), raceMode);
  $("raceTimeField").hidden = raceMode !== MODE.TIMED;
  $("raceLapsField").hidden = raceMode !== MODE.LAPS;
  $("raceModeHint").textContent = [
    "Unlimited laps until you press Stop.",
    "Race for a set time; each pilot finishes on their first pass after the time is up.",
    "Each pilot finishes after the set number of laps.",
  ][raceMode];
}

async function loadConfig() {
  const config = await fetchJson("/config");
  pilots = (config.p || []).slice(0, MAX_PILOTS).map((p) => ({ name: p.name, freq: p.freq, enter: p.enter, exit: p.exit }));
  while (pilots.length < MAX_PILOTS) pilots.push({ name: "", freq: 5658, enter: 120, exit: 100 });
  pilotCount = Math.min(Math.max(config.pilots || 1, 1), MAX_PILOTS);
  raceMode = config.raceMode || 0;

  buildPilotRows();
  renderPilots();
  renderRaceModeFields();

  ui.raceTime.value = config.raceSec || 120;
  ui.raceLaps.value = config.raceLaps || 3;
  ui.countdown.checked = !!config.countdown;
  ui.minLap.value = (config.minLap / 10).toFixed(1);
  ui.announcer.selectedIndex = config.anType;
  ui.rate.value = (config.anRate / 10).toFixed(1);
  ui.anDelta.checked = !!config.anDelta;
  ui.buzzer.checked = !!config.buzzerOn;
  ui.alarm.value = (config.alarm / 10).toFixed(1);
  ui.ssid.value = config.ssid;
  ui.pwd.value = config.pwd;
  [updateRaceTimeLabel, updateRaceLapsLabel, updateMinLapLabel, updateRateLabel, updateAlarmLabel].forEach((f) => f());

  renderCalibPilotButtons();
  configLoaded = true;
}

function configBody() {
  const p0 = pilots[0];
  return {
    name: p0.name,
    freq: p0.freq,
    enterRssi: p0.enter,
    exitRssi: p0.exit,
    pilots: pilotCount,
    p: pilots.map((p) => ({ name: p.name, freq: p.freq, enter: p.enter, exit: p.exit })),
    raceMode: raceMode,
    raceSec: +ui.raceTime.value,
    raceLaps: +ui.raceLaps.value,
    countdown: ui.countdown.checked,
    minLap: Math.round(ui.minLap.value * 10),
    alarm: Math.round(ui.alarm.value * 10),
    anType: ui.announcer.selectedIndex,
    anRate: Math.round(announcerRate * 10),
    anDelta: ui.anDelta.checked,
    buzzerOn: ui.buzzer.checked,
    ssid: ui.ssid.value,
    pwd: ui.pwd.value,
  };
}

// Returns a promise resolving to true when the timer confirmed the save
function saveConfig(button) {
  if (!configLoaded) {
    showButtonStatus(button, "Settings not loaded yet");
    return Promise.resolve(false);
  }
  if (button) button.disabled = true;
  return postJson("/config", configBody())
    .then((response) => {
      const ok = response.status === "OK";
      showSaveResult(button, ok);
      return ok;
    })
    .catch((err) => {
      console.error("/config save failed:", err);
      showSaveResult(button, false);
      return false;
    });
}

$("saveButton").addEventListener("click", (e) => saveConfig(e.target));

// ── Pilot profiles (stored on the timer) ──
async function loadProfiles() {
  try {
    profiles = await fetchJson("/api/profiles");
    if (!Array.isArray(profiles)) profiles = [];
  } catch (e) {
    profiles = [];
  }
  profiles.sort((a, b) => a.name.localeCompare(b.name));
  if (pilots.length) renderPilots();
}

async function saveProfile(index, button) {
  const p = pilots[index];
  const name = (p.name || "").trim();
  if (!name) {
    showButtonStatus(button, "Enter a name first");
    return;
  }
  const updated = profiles.filter((pr) => pr.name.toLowerCase() !== name.toLowerCase());
  updated.push({ name, freq: p.freq, enter: p.enter, exit: p.exit });
  try {
    await postJson("/api/profiles", updated);
    profiles = updated.sort((a, b) => a.name.localeCompare(b.name));
    renderPilots();
    showButtonStatus(button, "Saved ✓", 2000);
  } catch (e) {
    showButtonStatus(button, "Failed");
  }
}

// ── Home WiFi ──
$("wifiScanButton").addEventListener("click", async (e) => {
  const button = e.target;
  const results = $("wifiScanResults");
  button.disabled = true;
  showButtonStatus(button, "Scanning…", 0);
  try {
    await fetchJson("/api/wifi/scan?start=1");
    let scan = { scanning: true };
    for (let tries = 0; tries < 20 && scan.scanning; tries++) {
      await new Promise((r) => setTimeout(r, 1000));
      scan = await fetchJson("/api/wifi/scan");
    }
    results.innerHTML = "";
    const networks = (scan.networks || []).sort((a, b) => b.rssi - a.rssi);
    if (!networks.length) {
      results.appendChild(el("button", "", "No networks found"));
    }
    for (const n of networks) {
      const item = el("button");
      item.type = "button";
      item.append(el("span", "", n.ssid + (n.open ? "" : " 🔒")), el("span", "signal", n.rssi + " dBm"));
      item.addEventListener("click", () => {
        ui.ssid.value = n.ssid;
        results.hidden = true;
        ui.pwd.focus();
      });
      results.appendChild(item);
    }
    results.hidden = false;
    showButtonStatus(button, "Scan", 1);
  } catch (err) {
    showButtonStatus(button, "Scan failed");
  }
  button.disabled = false;
});

$("restartEspButton").addEventListener("click", async (e) => {
  if (!confirm("Restart the timer?")) return;
  e.target.disabled = true;
  try {
    await postJson("/restart");
    showButtonStatus(e.target, "Restarting…");
  } catch (err) {
    showButtonStatus(e.target, "Failed");
  }
  e.target.disabled = false;
});

// Clears the home WiFi and restarts the timer into its own hotspot
$("forgetWifiButton").addEventListener("click", async (e) => {
  const button = e.target;
  if (!confirm("Forget the home WiFi and restart the timer into its own hotspot?")) return;
  ui.ssid.value = "";
  ui.pwd.value = "";
  button.disabled = true;
  const ok = await saveConfig(null);
  if (!ok) {
    button.disabled = false;
    showButtonStatus(button, "Failed, try again");
    return;
  }
  fetch("/restart", { method: "POST" }).catch(() => {});
  showButtonStatus(button, "Restarting…", 0);
  $("wifiForgotten").hidden = false;
});

// ── Device info (firmware updates are on update.html) ──
async function loadInfo() {
  try {
    const info = await fetchJson("/api/info");
    $("infoVersion").textContent = info.version;
    $("infoMode").textContent = info.mode === "hotspot" ? "Own hotspot · " + info.ssid : "Home WiFi · " + info.ssid;
    $("infoIp").textContent = info.ip + (info.mode === "wifi" ? " · " + info.host : "");
  } catch (e) {
    /* older firmware */
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Tabs
// ═══════════════════════════════════════════════════════════════════

let currentTab = "config";

document.querySelector(".tabs").addEventListener("click", (e) => {
  const button = e.target.closest(".tablinks");
  if (!button) return;
  openTab(button.dataset.tab);
});

function openTab(tab) {
  currentTab = tab;
  for (const b of document.querySelectorAll(".tablinks")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const s of document.querySelectorAll(".tabcontent")) s.hidden = s.id !== tab;
  if (tab === "history") loadHistory();
  if (tab === "calib") startCalibration();
  else stopCalibration();
}

// ═══════════════════════════════════════════════════════════════════
//  Race: status polling, rendering, stats
// ═══════════════════════════════════════════════════════════════════

let status = null; // latest /api/status
let statusAtMs = 0; // local time when it arrived
let raceData = null; // latest /api/race
let seenRaceId = null; // race whose laps have been announced
let seenLaps = []; // lap entries per pilot already announced
let seenTimeUp = false;
let seenFinished = [];
let seenRaceFinished = false;
let raceFetchPending = false;

const timerEl = $("timer");

function pollStatus() {
  const fast = currentTab === "race" || currentTab === "calib" || !$("raceScreen").hidden;
  fetchJson("/api/status")
    .then(handleStatus)
    .catch((err) => console.debug("/api/status failed:", err))
    .finally(() => setTimeout(pollStatus, fast ? 250 : 600));
}

function handleStatus(s) {
  const previous = status;
  status = s;
  statusAtMs = Date.now();

  $("bvolt").textContent = (s.vbat / 10).toFixed(1) + "V";
  if (currentTab === "calib" && s.pilots[calibIndex]) $("rssiNow").textContent = s.pilots[calibIndex].rssi;

  const lapCountsChanged =
    !previous ||
    previous.race !== s.race ||
    previous.state !== s.state ||
    s.pilots.some((p, i) => !previous.pilots[i] || previous.pilots[i].laps !== p.laps || previous.pilots[i].fin !== p.fin);
  if (lapCountsChanged && !raceFetchPending) {
    raceFetchPending = true;
    fetchJson("/api/race")
      .then(handleRace)
      .catch((err) => console.debug("/api/race failed:", err))
      .finally(() => (raceFetchPending = false));
  }

  if (s.timeUp && !seenTimeUp && seenRaceId === s.race) {
    queueSpeak("Time's up");
  }
  seenTimeUp = s.timeUp;
  renderRaceControls();
}

// Current race clock in ms (negative during the countdown)
function raceElapsed() {
  if (!status) return 0;
  if (status.state === STATE.RUNNING || status.state === STATE.COUNTDOWN) {
    return status.elapsed + (Date.now() - statusAtMs);
  }
  return status.elapsed;
}

function clockText() {
  if (!status) return formatClock(0);
  const elapsed = raceElapsed();
  if (status.state === STATE.COUNTDOWN) return String(Math.ceil(-elapsed / 1000) || "GO");
  if (status.state === STATE.RUNNING && status.mode === MODE.TIMED && !status.timeUp) {
    return formatClock(status.raceMs - elapsed); // time left
  }
  if (status.state === STATE.RUNNING) return formatClock(elapsed);
  return formatClock(raceData ? lastRaceDuration(raceData) : 0);
}

// Duration of a finished race: the longest total time of any pilot
function lastRaceDuration(r) {
  let longest = 0;
  for (const p of r.pilots) {
    const total = p.laps.reduce((a, b) => a + b, 0);
    longest = Math.max(longest, total);
  }
  return longest;
}

function statusText() {
  if (!status) return ["Connecting…", ""];
  switch (status.state) {
    case STATE.COUNTDOWN:
      return ["Get ready", "waiting"];
    case STATE.WAITING:
      return ["Waiting for first gate pass…", "waiting"];
    case STATE.RUNNING:
      if (status.mode === MODE.TIMED) return status.timeUp ? ["Time's up · finish your lap", "waiting"] : ["Time left", "running"];
      if (status.mode === MODE.LAPS) return [`Racing · ${status.raceLaps} laps`, "running"];
      return ["Racing", "running"];
    case STATE.FINISHED:
      return ["Finished", ""];
    default:
      return [raceData && raceData.pilots.some((p) => p.laps.length) ? "Last race" : "Ready", ""];
  }
}

setInterval(() => {
  const text = clockText();
  if (currentTab === "race") timerEl.textContent = text;
  if (!$("raceScreen").hidden) $("rsClock").textContent = text;
}, 50);

function renderRaceControls() {
  const state = status ? status.state : STATE.IDLE;
  const racing = state === STATE.COUNTDOWN || state === STATE.WAITING || state === STATE.RUNNING;
  $("startRaceButton").disabled = racing;
  $("stopRaceButton").disabled = !racing;
  $("clearLapsButton").disabled = racing;
  const [text, cls] = statusText();
  const statusEl = $("raceStatus");
  statusEl.textContent = text;
  statusEl.className = "race-status" + (cls ? " " + cls : "");
  $("rsStatus").textContent = text;
  const mode = status ? status.mode : raceMode;
  let info = MODE_NAMES[mode];
  if (status && mode === MODE.TIMED) info += " · " + formatMinSec(Math.round(status.raceMs / 1000));
  if (status && mode === MODE.LAPS) info += " · " + status.raceLaps + " laps";
  if (status && status.cd) info += " · countdown";
  $("raceInfo").textContent = info;
}

// Per-pilot statistics from lap times in ms (entry 0 = start pass)
function pilotStats(p) {
  const laps = p.laps.slice(1);
  const n = laps.length;
  const stats = { laps: n, last: null, best: null, avg: null, delta: null, best3: null, consistency: null, total: p.laps.reduce((a, b) => a + b, 0) };
  if (!n) return stats;
  stats.last = laps[n - 1];
  stats.best = Math.min(...laps);
  stats.avg = laps.reduce((a, b) => a + b, 0) / n;
  if (n >= 2) {
    const previousBest = Math.min(...laps.slice(0, -1));
    stats.delta = stats.last - previousBest;
    const variance = laps.reduce((a, b) => a + (b - stats.avg) ** 2, 0) / n;
    stats.consistency = Math.sqrt(variance);
  }
  for (let i = 0; i + 3 <= n; i++) {
    const sum = laps[i] + laps[i + 1] + laps[i + 2];
    if (stats.best3 === null || sum < stats.best3) stats.best3 = sum;
  }
  return stats;
}

// Positions: laps race = most laps then least total time; practice/timed = most laps then least total time
function positions(r) {
  const order = r.pilots
    .map((p, i) => ({ i, laps: Math.max(0, p.laps.length - 1), total: p.laps.reduce((a, b) => a + b, 0) }))
    .sort((a, b) => b.laps - a.laps || a.total - b.total);
  const pos = [];
  order.forEach((o, rank) => (pos[o.i] = rank + 1));
  return pos;
}

function handleRace(r) {
  // Before any race, show the configured pilots
  if (r.state === STATE.IDLE && !r.pilots.some((p) => p.laps.length)) {
    r.pilots = pilots.slice(0, pilotCount).map((p) => ({ name: p.name, freq: p.freq, laps: [], fin: false }));
  }
  raceData = r;
  if (seenRaceId !== r.race) {
    // First sight of this race. If it hasn't started yet, announce everything
    // from its first pass; otherwise just show it (don't replay old laps).
    seenRaceId = r.race;
    const fresh = r.state === STATE.COUNTDOWN || r.state === STATE.WAITING;
    seenLaps = r.pilots.map((p) => (fresh ? 0 : p.laps.length));
    seenFinished = r.pilots.map((p) => !fresh && p.fin);
    seenRaceFinished = !fresh && r.state === STATE.FINISHED;
  } else {
    announceNewLaps(r);
  }
  renderRacePilots(r);
  renderRaceScreen(r);
  renderRaceControls();
}

function announceNewLaps(r) {
  const multi = r.pilots.length > 1;
  r.pilots.forEach((p, i) => {
    const name = pilotLabel(p.name, i);
    for (let n = seenLaps[i] || 0; n < p.laps.length; n++) {
      if (n === 0) {
        if (!r.cd && r.pilots.every((q, j) => j === i || (seenLaps[j] || 0) === 0)) queueSpeak("Race start");
        else if (multi) queueSpeak(name + " started");
        continue;
      }
      announceLap(p, i, n, r);
    }
    seenLaps[i] = p.laps.length;
    if (p.fin && !seenFinished[i]) {
      if (multi) queueSpeak(name + " finished");
      seenFinished[i] = true;
    }
  });
  if (r.state === STATE.FINISHED && !seenRaceFinished) {
    seenRaceFinished = true;
    const pos = positions(r);
    if (multi) queueSpeak("Race over. Winner " + pilotLabel(r.pilots[pos.indexOf(1)].name, pos.indexOf(1)));
    else queueSpeak("Race over");
  }
}

function announceLap(p, i, n, r) {
  const lapMs = p.laps[n];
  const lapStr = secs(lapMs);
  const name = pilotLabel(p.name, i);
  const who = r.pilots.length > 1 || (p.name && p.name.trim()) ? name + " " : "";
  const previous = p.laps.slice(1, n);
  const type = ui.announcer.value;

  if (type === "beep") {
    beep(100, 330 + i * 110, "square");
    return;
  }
  if (type === "1lap") {
    queueSpeak(`${who}lap ${n}, ${lapStr}`);
  } else if (type === "2lap" && n >= 2) {
    queueSpeak(`${who}2 laps ${secs(lapMs + p.laps[n - 1])}`);
  } else if (type === "3lap" && n >= 3) {
    queueSpeak(`${who}3 laps ${secs(lapMs + p.laps[n - 1] + p.laps[n - 2])}`);
  }
  if (type === "none") return;
  if (previous.length) {
    const previousBest = Math.min(...previous);
    if (lapMs < previousBest) queueSpeak("Best lap");
    else if (ui.anDelta.checked) {
      const delta = (lapMs - previousBest) / 1000;
      queueSpeak("plus " + delta.toFixed(2));
    }
    if (ui.anDelta.checked && lapMs < previousBest) queueSpeak("minus " + ((previousBest - lapMs) / 1000).toFixed(2));
  }
}

function statBox(label, value, extraClass) {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${extraClass || ""}">${value}</div></div>`;
}

function deltaText(ms) {
  if (ms === null) return ["–", ""];
  if (Math.abs(ms) < 5) return ["±0.00", ""];
  const sign = ms < 0 ? "−" : "+";
  return [sign + (Math.abs(ms) / 1000).toFixed(2), ms < 0 ? "delta-faster" : "delta-slower"];
}

function renderRacePilots(r) {
  const container = $("racePilots");
  container.innerHTML = "";
  const pos = positions(r);
  const showPos = r.pilots.length > 1 && r.pilots.some((p) => p.laps.length > 1);
  r.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    const card = el("div", "card race-pilot pilot-" + (i + 1));
    const [dText, dClass] = deltaText(st.delta);
    const bestIndex = st.best === null ? -1 : p.laps.indexOf(st.best, 1);
    const rows = [];
    for (let n = p.laps.length - 1; n >= 1; n--) {
      const d = st.best === null ? "" : n === bestIndex ? "best" : "+" + secs(p.laps[n] - st.best);
      rows.push(`<tr${n === bestIndex ? ' class="best-lap"' : ""}><td>${n}</td><td>${secs(p.laps[n])}s</td><td>${d}</td></tr>`);
    }
    if (p.laps.length) rows.push(`<tr><td>0</td><td>${r.cd ? "Start " + secs(p.laps[0]) + "s" : "Start"}</td><td></td></tr>`);
    card.innerHTML = `
      <div class="race-pilot-head">
        <span class="dot-p"></span>
        <span>${showPos ? pos[i] + ". " : ""}${escapeHtml(pilotLabel(p.name, i))}</span>
        <span class="muted">${channelName(p.freq)} ${p.freq}</span>
        ${p.fin ? '<span class="finished">Finished</span>' : ""}
      </div>
      <div class="stats">
        ${statBox("Laps", st.laps)}
        ${statBox("Last", st.last === null ? "–" : secs(st.last))}
        ${statBox("Delta", dText, dClass)}
        ${statBox("Best", st.best === null ? "–" : secs(st.best))}
        ${statBox("Average", st.avg === null ? "–" : secs(st.avg))}
        ${statBox("Best 3 laps", st.best3 === null ? "–" : secs(st.best3))}
      </div>
      <p class="hint">Consistency: ${st.consistency === null ? "–" : "±" + secs(st.consistency) + "s"} · Total ${secs(st.total)}s</p>
      ${rows.length ? `<div class="lap-table-wrap"><table><tr><th>Lap</th><th>Time</th><th>vs best</th></tr>${rows.join("")}</table></div>` : ""}`;
    container.appendChild(card);
  });
}

// ── Race controls ──
function startRace() {
  const t = Math.floor(Date.now() / 1000);
  queueSpeak(ui.countdown.checked ? "Get ready" : "Start racing when ready");
  return fetch("/timer/start?t=" + t, { method: "POST" }).then((r) => {
    if (r.status === 409) showButtonStatus($("startRaceButton"), "Busy, try again");
    pollOnce();
  });
}

function stopRace() {
  queueSpeak("Race stopped");
  return fetch("/timer/stop", { method: "POST" }).then(pollOnce);
}

function clearRace() {
  return fetch("/timer/clear", { method: "POST" }).then(pollOnce);
}

function pollOnce() {
  fetchJson("/api/status").then(handleStatus).catch(() => {});
}

$("startRaceButton").addEventListener("click", startRace);
$("stopRaceButton").addEventListener("click", stopRace);
$("clearLapsButton").addEventListener("click", clearRace);

// ── Race screen ──
$("raceScreenButton").addEventListener("click", () => {
  $("raceScreen").hidden = false;
  if (raceData) renderRaceScreen(raceData);
  const fs = document.documentElement.requestFullscreen;
  if (fs) fs.call(document.documentElement).catch(() => {});
});

$("rsClose").addEventListener("click", () => {
  $("raceScreen").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});

function renderRaceScreen(r) {
  if ($("raceScreen").hidden) return;
  const container = $("rsPilots");
  container.innerHTML = "";
  const pos = positions(r);
  r.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    const tile = el("div", "rs-pilot pilot-" + (i + 1));
    let deltaHtml = "";
    if (st.delta !== null) {
      const [text, cls] = deltaText(st.delta);
      deltaHtml = `<span class="${cls.replace("delta-", "rs-delta-")}">${text}</span>`;
    }
    tile.innerHTML = `
      <div class="rs-name"><span>${r.pilots.length > 1 ? pos[i] + ". " : ""}${escapeHtml(pilotLabel(p.name, i))}</span><span class="rs-lapno">${p.fin ? "Finished" : "Lap " + st.laps}</span></div>
      <div class="rs-last">${st.last === null ? "–" : secs(st.last)}</div>
      <div class="rs-row">${deltaHtml || "<span></span>"}<span class="rs-best">Best ${st.best === null ? "–" : secs(st.best)}</span></div>`;
    container.appendChild(tile);
  });
}

// ═══════════════════════════════════════════════════════════════════
//  Calibration
// ═══════════════════════════════════════════════════════════════════

let calibIndex = 0;
let rssiChart = null;
let rssiSeries = new TimeSeries();
let rssiSeq = 0;
let lastPointMs = 0;
let calibTimer = null;
let autoCalSamples = []; // [value] of the selected pilot, 25 ms apart, last 60 s

const enterInput = $("enter");
const exitInput = $("exit");

function renderCalibPilotButtons() {
  const container = $("calibPilot");
  container.hidden = pilotCount < 2;
  container.innerHTML = "";
  for (let i = 0; i < pilotCount; i++) {
    const b = el("button", i === calibIndex ? "active" : "", pilotLabel(pilots[i] && pilots[i].name, i));
    b.dataset.value = i;
    container.appendChild(b);
  }
  if (calibIndex >= pilotCount) selectCalibPilot(0);
  renderCalibration();
}

setupSegmented($("calibPilot"), (v) => selectCalibPilot(+v));

function selectCalibPilot(i) {
  calibIndex = i;
  setSegmented($("calibPilot"), i);
  rssiSeries.clear();
  autoCalSamples = [];
  renderCalibration();
  renderAutoCal();
}

function renderCalibration() {
  const p = pilots[calibIndex];
  if (!p) return;
  enterInput.value = p.enter;
  exitInput.value = p.exit;
  $("enterSpan").textContent = p.enter;
  $("exitSpan").textContent = p.exit;
}

enterInput.addEventListener("input", () => {
  const p = pilots[calibIndex];
  p.enter = +enterInput.value;
  if (p.exit >= p.enter) p.exit = Math.max(0, p.enter - 1);
  renderCalibration();
});

exitInput.addEventListener("input", () => {
  const p = pilots[calibIndex];
  p.exit = +exitInput.value;
  if (p.exit >= p.enter) p.enter = Math.min(255, p.exit + 1);
  renderCalibration();
});

$("saveThresholdsButton").addEventListener("click", (e) => saveConfig(e.target));

function createRssiChart() {
  const css = getComputedStyle(document.documentElement);
  rssiChart = new SmoothieChart({
    responsive: true,
    millisPerPixel: 20,
    interpolation: "linear",
    grid: {
      fillStyle: "transparent",
      strokeStyle: css.getPropertyValue("--border").trim() || "rgba(128,128,128,0.25)",
      millisPerLine: 2000,
      sharpLines: true,
      verticalSections: 0,
      borderVisible: false,
    },
    labels: { precision: 0, fillStyle: css.getPropertyValue("--muted").trim() || "#888" },
    yRangeFunction: (range) => {
      const p = pilots[calibIndex] || { enter: 120, exit: 100 };
      return { min: Math.max(0, Math.min(range.min, p.exit) - 10), max: Math.max(range.max, p.enter) + 10 };
    },
  });
  rssiChart.addTimeSeries(rssiSeries, { lineWidth: 2, strokeStyle: "hsl(214, 70%, 60%)", fillStyle: "hsla(214, 70%, 60%, 0.2)" });
  rssiChart.streamTo($("rssiChart"), 100);
}

function updateChartLines() {
  const p = pilots[calibIndex];
  if (!rssiChart || !p) return;
  rssiChart.options.horizontalLines = [
    { color: "hsl(8.2, 86.5%, 53.7%)", lineWidth: 1.7, value: p.enter },
    { color: "hsl(25, 85%, 55%)", lineWidth: 1.7, value: p.exit },
  ];
}

function startCalibration() {
  if (!rssiChart) createRssiChart();
  rssiChart.start();
  if (!calibTimer) pollRssi();
}

function stopCalibration() {
  if (rssiChart) rssiChart.stop();
  clearTimeout(calibTimer);
  calibTimer = null;
}

// High-resolution RSSI history (one value per 25 ms) from the timer
function pollRssi() {
  fetchJson("/api/rssi?since=" + rssiSeq)
    .then((r) => {
      const values = r.pilots[calibIndex] || [];
      const now = Date.now();
      values.forEach((v, k) => {
        const t = Math.max(now - (values.length - 1 - k) * r.step, lastPointMs + 1);
        rssiSeries.append(t, v);
        lastPointMs = t;
      });
      if (values.length) $("rssiNow").textContent = values[values.length - 1];
      rssiSeq = r.seq;
      updateChartLines();
      if ($("autoCal").checked) {
        autoCalSamples.push(...values);
        if (autoCalSamples.length > 2400) autoCalSamples.splice(0, autoCalSamples.length - 2400);
        renderAutoCal();
      }
    })
    .catch(() => {})
    .finally(() => {
      if (currentTab === "calib") calibTimer = setTimeout(pollRssi, 250);
      else calibTimer = null;
    });
}

// Auto-calibration: background level from the quiet samples, peak level from passes
function analyseAutoCal(samples) {
  if (samples.length < 80) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.2)];
  const passLevel = floor + 20;
  const peaks = [];
  let peak = 0;
  let inPass = false;
  for (const v of samples) {
    if (v > passLevel) {
      inPass = true;
      peak = Math.max(peak, v);
    } else if (inPass) {
      peaks.push(peak);
      inPass = false;
      peak = 0;
    }
  }
  if (peaks.length < 3) return { floor, passes: peaks.length };
  peaks.sort((a, b) => a - b);
  const peakRef = peaks[Math.floor(peaks.length * 0.25)]; // a weaker pass, to be safe
  const span = peakRef - floor;
  const enter = Math.round(floor + span * 0.65);
  const exit = Math.min(enter - 3, Math.round(floor + span * 0.45));
  return { floor, passes: peaks.length, peak: peakRef, enter, exit };
}

function renderAutoCal() {
  const box = $("autoCalResult");
  if (!$("autoCal").checked) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const result = analyseAutoCal(autoCalSamples);
  if (!result) {
    box.textContent = "Listening… keep the quad powered and fly through the gate.";
    return;
  }
  if (!result.enter) {
    box.textContent = `Background about ${result.floor}. Passes seen: ${result.passes} of 3.`;
    return;
  }
  box.innerHTML = `Passes seen: <b>${result.passes}</b> · background ${result.floor} · peaks ${result.peak}<br>
    Suggested: <b>Enter ${result.enter}</b>, <b>Exit ${result.exit}</b>
    <button class="btn btn-ghost btn-block" id="applyAutoCal" style="margin-top:8px">Apply</button>`;
  $("applyAutoCal").addEventListener("click", () => {
    const p = pilots[calibIndex];
    p.enter = result.enter;
    p.exit = result.exit;
    renderCalibration();
    showButtonStatus($("saveThresholdsButton"), "Applied, now save", 3000);
  });
}

$("autoCal").addEventListener("change", () => {
  autoCalSamples = [];
  renderAutoCal();
});

// ═══════════════════════════════════════════════════════════════════
//  History
// ═══════════════════════════════════════════════════════════════════

let historyList = [];

async function loadHistory() {
  try {
    historyList = (await fetchJson("/api/races")).sort((a, b) => b.id - a.id);
  } catch (e) {
    historyList = [];
  }
  renderHistory();
}

function raceTitle(race) {
  if (race.date) {
    return new Date(race.date * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
  }
  return "Race #" + race.id;
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").hidden = historyList.length > 0;
  for (const race of historyList) {
    const card = el("div", "card history-item");
    const summary = el("button", "history-summary");
    summary.type = "button";
    summary.innerHTML = `
      <div class="history-top"><span class="history-title">${escapeHtml(raceTitle(race))}</span><span class="history-meta">${MODE_NAMES[race.mode] || ""}</span></div>
      <div class="history-pilots">${race.pilots
        .map((p, i) => `<span class="pilot-${i + 1}"><i class="dot-p"></i>${escapeHtml(pilotLabel(p.name, i))} · ${p.laps} laps · best ${p.best ? secs(p.best) : "–"}</span>`)
        .join("")}</div>`;
    const detail = el("div", "history-detail");
    detail.hidden = true;
    summary.addEventListener("click", async () => {
      if (!detail.hidden) {
        detail.hidden = true;
        return;
      }
      detail.hidden = false;
      detail.textContent = "Loading…";
      try {
        const full = await fetchJson("/api/races?id=" + race.id);
        renderHistoryDetail(detail, full);
      } catch (e) {
        detail.textContent = "Could not load this race.";
      }
    });
    card.append(summary, detail);
    list.appendChild(card);
  }
}

function renderHistoryDetail(container, race) {
  container.innerHTML = "";
  race.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    const rows = p.laps
      .slice(1)
      .map((t, n) => `<tr${t === st.best ? ' class="best-lap"' : ""}><td>${n + 1}</td><td>${secs(t)}s</td></tr>`)
      .join("");
    const block = el("div", "pilot-" + (i + 1));
    block.innerHTML = `
      <div class="race-pilot-head"><span class="dot-p"></span><span>${escapeHtml(pilotLabel(p.name, i))}</span><span class="muted">${channelName(p.freq)} ${p.freq}</span></div>
      <p class="hint">Best ${st.best === null ? "–" : secs(st.best)} · average ${st.avg === null ? "–" : secs(st.avg)} · best 3 laps ${st.best3 === null ? "–" : secs(st.best3)}</p>
      ${rows ? `<div class="lap-table-wrap"><table><tr><th>Lap</th><th>Time</th></tr>${rows}</table></div>` : ""}`;
    container.appendChild(block);
  });
  const exportButton = el("button", "btn btn-ghost btn-block", "Export this race (CSV)");
  exportButton.addEventListener("click", () => downloadCsv([race], "laptimer-race-" + race.id + ".csv"));
  container.appendChild(exportButton);
}

function csvRows(race) {
  const date = race.date ? new Date(race.date * 1000).toISOString() : "";
  const rows = [];
  race.pilots.forEach((p, i) => {
    p.laps.forEach((t, n) => {
      if (n === 0) return;
      rows.push([race.id, date, MODE_NAMES[race.mode] || "", pilotLabel(p.name, i), p.freq, n, secs(t)]);
    });
  });
  return rows;
}

function downloadCsv(races, filename) {
  const header = ["race", "date", "mode", "pilot", "frequency", "lap", "time_s"];
  const lines = [header, ...races.flatMap(csvRows)].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const a = el("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

$("exportAllButton").addEventListener("click", async (e) => {
  const button = e.target;
  showButtonStatus(button, "Preparing…", 0);
  try {
    const races = [];
    for (const r of historyList) races.push(await fetchJson("/api/races?id=" + r.id));
    downloadCsv(races, "laptimer-races.csv");
    showButtonStatus(button, "Exported ✓", 2000);
  } catch (err) {
    showButtonStatus(button, "Export failed");
  }
});

$("clearHistoryButton").addEventListener("click", async (e) => {
  if (!confirm("Delete all saved races?")) return;
  try {
    await postJson("/api/races/clear");
    loadHistory();
  } catch (err) {
    showButtonStatus(e.target, "Failed");
  }
});

// ═══════════════════════════════════════════════════════════════════
//  Speech (announcer) and beeps
// ═══════════════════════════════════════════════════════════════════

let audioEnabled = false;
let audioLoopRunning = false;
let speakQueue = [];
let lastSpeechMs = 0; // last time the announcer was speaking (for voice command echo filtering)
let speakStartMs = 0;
let speechTestButton = null; // set while "Test voice" is running, to report the result
const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
const isAndroid = /android/i.test(navigator.userAgent);

function queueSpeak(text) {
  if (audioEnabled) speakQueue.push(text);
}

async function enableAudioLoop() {
  audioEnabled = true;
  if (audioLoopRunning) return; // only one loop, or announcements get spoken twice
  audioLoopRunning = true;
  while (audioEnabled) {
    // Only "speaking" is checked: some Android browsers leave "pending" stuck
    const speaking = speechSupported && speechSynthesis.speaking;
    if (speaking) {
      lastSpeechMs = Date.now();
      // Watchdog: a stuck speech engine would block every later announcement
      if (Date.now() - speakStartMs > 15000) {
        console.warn("Speech stuck, resetting");
        speechSynthesis.cancel();
      }
    } else if (speakQueue.length > 0) {
      lastSpeechMs = Date.now();
      doSpeak(speakQueue.shift());
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  audioLoopRunning = false;
}

function disableAudioLoop() {
  audioEnabled = false;
}

ui.voiceToggle.addEventListener("change", () => (ui.voiceToggle.checked ? enableAudioLoop() : disableAudioLoop()));

// Always announce in English, regardless of the phone's system language.
// utterance.lang selects the language; forcing a voice object can make Android
// browsers silent, so only desktop browsers also get an explicit English voice.
// If the browser rejects English, retry once with its default voice.
function findEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => v.lang.replace("_", "-") === "en-US") || voices.find((v) => v.lang.toLowerCase().startsWith("en"));
}

function doSpeak(text, useEnglish = true) {
  if (!speechSupported || !text) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.rate = announcerRate;
  if (useEnglish) {
    utterance.lang = "en-US";
    if (!isAndroid) {
      const voice = findEnglishVoice();
      if (voice) utterance.voice = voice;
    }
  }
  utterance.onstart = () => {
    if (speechTestButton) showButtonStatus(speechTestButton, "Speaking… ✓", 0);
  };
  utterance.onend = () => {
    if (speechTestButton && speakQueue.length === 0) {
      showButtonStatus(speechTestButton, "Voice works ✓");
      speechTestButton = null;
    }
  };
  utterance.onerror = (e) => {
    console.warn("Speech error:", e.error);
    if (e.error === "interrupted" || e.error === "canceled") return;
    if (useEnglish) {
      doSpeak(text, false); // retry with the browser's default voice
    } else if (speechTestButton) {
      showButtonStatus(speechTestButton, "Voice error: " + e.error, 8000);
      speechTestButton = null;
    }
  };
  speakStartMs = Date.now();
  speechSynthesis.speak(utterance);
}

// Test voice: speaks the first phrase directly from the tap (strictest browsers
// only allow speech inside a user gesture) and shows the outcome on the button.
$("GenerateAudioButton").addEventListener("click", (e) => {
  const button = e.target;
  if (!speechSupported) {
    showButtonStatus(button, "This browser has no speech");
    return;
  }
  if (!audioEnabled) {
    showButtonStatus(button, "Turn on voice first");
    return;
  }
  speechTestButton = button;
  showButtonStatus(button, "Speaking…", 0);
  speakQueue = [];
  speechSynthesis.cancel();
  doSpeak("testing sound for " + pilotLabel(pilots[0] && pilots[0].name, 0));
  for (let i = 1; i <= 3; i++) queueSpeak(String(i));
  // Some browsers silently ignore speech without any error event
  setTimeout(() => {
    if (speechTestButton === button && button.textContent === "Speaking…") {
      showButtonStatus(button, "Browser gave no sound", 8000);
      speechTestButton = null;
    }
  }, 5000);
});

// Browsers cap the number of AudioContexts, so reuse a single one.
let audioContext = null;

function beep(duration, frequency, type) {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
  const oscillator = audioContext.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration / 1000);
}

// ═══════════════════════════════════════════════════════════════════
//  Voice commands
// ═══════════════════════════════════════════════════════════════════

// Colors the mic chip in the top bar: 'listening' (green), 'error' (red) or '' (grey)
function setMicState(state) {
  const mic = $("micIndicator");
  mic.classList.toggle("listening", state === "listening");
  mic.classList.toggle("error", state === "error");
}

function speakBestTimes() {
  if (!raceData || !raceData.pilots.some((p) => p.laps.length > 1)) {
    queueSpeak("No best lap recorded yet");
    return;
  }
  raceData.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    if (st.best !== null) queueSpeak(`${pilotLabel(p.name, i)}, best lap ${secs(st.best)} seconds`);
  });
}

function startVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech recognition not supported in this browser. Voice commands disabled.");
    return;
  }
  const recognition = new SpeechRecognition();
  recognition.lang = "en-US";
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = (event) => {
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (!event.results[i].isFinal) continue;
      const transcript = event.results[i][0].transcript.trim().toLowerCase();
      // Ignore what the mic hears while (or just after) the announcer speaks,
      // otherwise "Race stopped" / "Start racing" would trigger commands.
      if (Date.now() - lastSpeechMs < 1500) break;
      const has = (word) => new RegExp("\\b" + word + "\\b").test(transcript);
      const racing = status && (status.state === STATE.COUNTDOWN || status.state === STATE.WAITING || status.state === STATE.RUNNING);
      if (has("best time")) speakBestTimes();
      else if (has("clear time") || has("clear best")) {
        if (!racing) clearRace();
      } else if (has("start") || has("begin") || has("go")) {
        if (!racing) $("startRaceButton").click();
      } else if (has("stop")) {
        if (racing) stopRace();
      }
      break;
    }
  };
  recognition.onerror = () => setMicState("error");
  recognition.onend = () => {
    try {
      recognition.start(); // keep listening
    } catch (e) {
      console.warn("Failed to restart recognition", e);
    }
  };
  try {
    recognition.start();
    setMicState("listening");
  } catch (e) {
    console.warn("Speech recognition start failed", e);
  }
}

// ═══════════════════════════════════════════════════════════════════
//  Start
// ═══════════════════════════════════════════════════════════════════

window.addEventListener("load", async () => {
  try {
    await loadConfig();
  } catch (e) {
    console.error("Could not load settings", e);
  }
  loadProfiles();
  loadInfo();
  pollStatus();
  if (ui.voiceToggle.checked) enableAudioLoop();
  startVoiceRecognition();
});
