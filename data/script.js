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
const HOP_MS_PER_PILOT = 50; // firmware: RX_LOCK_MS 45 + HOP_DWELL_MS 5 per pilot

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

// Every request gives up after a few seconds, so a request lost on a network change
// can't stall the polling loop that waits for it
function fetchTimeout(url, options = {}, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(timer));
}

async function fetchJson(url, options) {
  const response = await fetchTimeout(url, options);
  if (!response.ok) {
    const err = new Error(url + ": HTTP " + response.status);
    err.status = response.status;
    throw err;
  }
  return response.json();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pilot names are stored in 20 bytes of UTF-8 on the timer
const NAME_MAX_BYTES = 20;
const utf8 = new TextEncoder();

function truncateUtf8(text, maxBytes) {
  let out = "";
  for (const ch of text) {
    if (utf8.encode(out + ch).length > maxBytes) break;
    out += ch;
  }
  return out;
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
let rankBy = 0; // 0 most laps, 1 fastest lap, 2 best 3 consecutive laps
let announcerRate = 1.0;
let profiles = [];

const ui = {
  pilotList: $("pilotList"),
  pilotHint: $("pilotHint"),
  raceTime: $("raceTime"),
  raceLaps: $("raceLaps"),
  countdown: $("countdown"),
  stagger: $("stagger"),
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
      <select class="p-profile" aria-label="Switch to a saved pilot"></select>`;
    // Handlers look up pilots[i] each time: a settings reload replaces the pilot objects
    row.querySelector(".p-name").addEventListener("input", (e) => {
      const name = truncateUtf8(e.target.value, NAME_MAX_BYTES);
      if (name !== e.target.value) e.target.value = name;
      pilots[i].name = name;
      renderCalibPilotButtons();
    });
    row.querySelector(".p-name").addEventListener("change", () => {
      touchedPilots.add(i);
      rememberPilots();
    });
    const onFreq = () => {
      const b = +row.querySelector(".p-band").value;
      const c = +row.querySelector(".p-channel").value;
      pilots[i].freq = FREQ_TABLE[b][c];
      touchedPilots.add(i);
      renderPilotRow(i);
      renderPilotHint();
    };
    row.querySelector(".p-band").addEventListener("change", onFreq);
    row.querySelector(".p-channel").addEventListener("change", onFreq);
    row.querySelector(".p-profile").addEventListener("change", (e) => {
      const profile = profiles[+e.target.value];
      e.target.value = "";
      if (!profile) return;
      Object.assign(pilots[i], { name: profile.name, freq: profile.freq, enter: profile.enter, exit: profile.exit });
      renderPilotRow(i);
      renderPilotHint();
      renderCalibration();
      renderCalibPilotButtons();
    });
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
  row.querySelector(".p-freq").textContent = bandChannel(p.freq) ? p.freq : "Off";
  renderProfileSelect(row.querySelector(".p-profile"));
}

function renderProfileSelect(select) {
  select.hidden = profiles.length === 0;
  select.innerHTML =
    `<option value="">Switch to a saved pilot…</option>` +
    profiles.map((pr, n) => `<option value="${n}">${escapeHtml(pr.name)} · ${channelName(pr.freq) || pr.freq}</option>`).join("");
}

// Saved pilots as chips; × forgets one
function renderSavedPilots() {
  const container = $("savedPilots");
  container.innerHTML = "";
  $("savedPilotsBlock").hidden = profiles.length === 0;
  profiles.forEach((pr) => {
    const chip = el("span", "chip-pilot");
    chip.append(el("span", "", `${pr.name} · ${channelName(pr.freq) || pr.freq}`));
    const remove = el("button", "chip-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Forget " + pr.name);
    remove.addEventListener("click", async () => {
      remove.disabled = true;
      try {
        await postJson("/api/profiles/remove", { name: pr.name });
      } catch (e) {
        /* the reload below shows what the timer has */
      }
      loadProfiles();
    });
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}

function renderPilots() {
  for (let i = 0; i < MAX_PILOTS; i++) renderPilotRow(i);
  renderSavedPilots();
  setSegmented($("pilotCount"), pilotCount);
  renderPilotHint();
}

// Precision note and warnings for frequencies that are equal or too close
function renderPilotHint() {
  let text;
  if (pilotCount === 1) {
    text = "One pilot: the receiver stays on one channel for full timing precision.";
  } else {
    text = `${pilotCount} pilots share the receiver, which switches between their channels: each pilot is read every ${HOP_MS_PER_PILOT * pilotCount} ms and the pass time is interpolated between readings.`;
  }
  const active = pilots.slice(0, pilotCount);
  const warnings = [];
  active.forEach((p, i) => {
    if (!bandChannel(p.freq)) warnings.push(`Pilot ${i + 1} has no channel yet: pick a band and channel.`);
  });
  for (let a = 0; a < active.length; a++) {
    for (let b = a + 1; b < active.length; b++) {
      if (!bandChannel(active[a].freq) || !bandChannel(active[b].freq)) continue;
      const gap = Math.abs(active[a].freq - active[b].freq);
      if (gap === 0) warnings.push(`Pilots ${a + 1} and ${b + 1} are on the same channel.`);
      else if (gap < 30) warnings.push(`Pilots ${a + 1} and ${b + 1} are only ${gap} MHz apart; laps may be mixed up.`);
    }
  }
  ui.pilotHint.innerHTML = escapeHtml(text) + warnings.map((w) => `<br><span class="warn">${escapeHtml(w)}</span>`).join("");
}

// Settings controls do nothing until the settings have loaded (they are dimmed until then)
setupSegmented($("pilotCount"), (v) => {
  if (!configLoaded) return;
  pilotCount = +v;
  renderPilots();
  renderCalibPilotButtons();
  scheduleSave();
});

setupSegmented($("raceMode"), (v) => {
  if (!configLoaded) return;
  raceMode = +v;
  renderRaceModeFields();
  scheduleSave();
});

setupSegmented($("rankBy"), (v) => {
  if (!configLoaded) return;
  rankBy = +v;
  scheduleSave();
  if (raceData) handleRace(raceData);
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

// Puts settings in the shape of GET /config into the page
function applyConfig(config) {
  pilots = (config.p || []).slice(0, MAX_PILOTS).map((p) => ({ name: p.name, freq: p.freq, enter: p.enter, exit: p.exit }));
  while (pilots.length < MAX_PILOTS) pilots.push({ name: "", freq: 5658, enter: 120, exit: 100 });
  pilotCount = Math.min(Math.max(config.pilots || 1, 1), MAX_PILOTS);
  raceMode = config.raceMode || 0;

  if (!ui.pilotList.children.length) buildPilotRows();
  renderPilots();
  renderRaceModeFields();

  ui.raceTime.value = config.raceSec || 120;
  ui.raceLaps.value = config.raceLaps || 3;
  ui.countdown.checked = !!config.countdown;
  ui.stagger.checked = !!config.stagger;
  rankBy = config.rankBy || 0;
  setSegmented($("rankBy"), rankBy);
  ui.minLap.value = (config.minLap / 10).toFixed(1);
  ui.announcer.selectedIndex = config.anType;
  ui.rate.value = (config.anRate / 10).toFixed(1);
  ui.anDelta.checked = !!config.anDelta;
  ui.buzzer.checked = !!config.buzzerOn;
  ui.alarm.value = (config.alarm / 10).toFixed(1);
  [updateRaceTimeLabel, updateRaceLapsLabel, updateMinLapLabel, updateRateLabel, updateAlarmLabel].forEach((f) => f());

  renderCalibPilotButtons();
  renderCalibration();
}

// Settings with this page's unsaved changes (a changedSettings() diff) on top
function withChanges(config, diff) {
  const merged = { ...config, ...diff };
  merged.p = (config.p || []).map((p, i) => ({ ...p, ...((diff.p && diff.p[i]) || {}) }));
  return merged;
}

let configLoading = false;

// Loads the timer's settings. Changes made on this page that the timer doesn't have yet
// (waiting to be saved, or a save that failed) stay on top and are saved again.
// minRev: a revision the timer is known to have reached (from a save reply).
async function loadConfig(minRev = null) {
  const revBefore = status ? status.cfg : null; // the loaded settings are at least this new
  configLoading = true;
  let config;
  try {
    config = await fetchJson("/config");
  } finally {
    configLoading = false;
  }
  const unsaved = configLoaded ? changedSettings().diff : {};
  const hasUnsaved = Object.keys(unsaved).length > 0;
  applyConfig(config);
  savedBody = configBody(); // what the timer has
  if (hasUnsaved) applyConfig(withChanges(config, unsaved));
  const revs = [revBefore, minRev].filter((r) => r !== null && r !== undefined);
  knownRev = config.rev !== undefined ? config.rev : revs.length ? Math.max(...revs) : null;
  configLoaded = true;
  document.body.classList.add("config-ready");
  if (hasUnsaved) scheduleSave();
  else if (!saveTimer && !savingNow) setSaveState("saved");
}

// At start-up the page needs the settings before anything can be edited: retry until they load
async function loadConfigAtStart() {
  setSaveState("loading");
  for (let attempt = 0; !configLoaded; attempt++) {
    try {
      await loadConfig();
    } catch (e) {
      console.error("Could not load settings", e);
      setSaveState("offline");
      await sleep(Math.min(8000, 1000 * 2 ** attempt));
    }
  }
  loadProfiles();
  fetchRace(); // before a race the Race tab lists the configured pilots
}

function configBody() {
  return {
    pilots: pilotCount,
    p: pilots.map((p) => ({ name: p.name, freq: p.freq, enter: p.enter, exit: p.exit })),
    raceMode: raceMode,
    raceSec: +ui.raceTime.value,
    raceLaps: +ui.raceLaps.value,
    countdown: ui.countdown.checked,
    stagger: ui.stagger.checked,
    rankBy: rankBy,
    minLap: Math.round(ui.minLap.value * 10),
    alarm: Math.round(ui.alarm.value * 10),
    anType: ui.announcer.selectedIndex,
    anRate: Math.round(announcerRate * 10),
    anDelta: ui.anDelta.checked,
    buzzerOn: ui.buzzer.checked,
  };
}

let savedBody = null; // settings the timer has, as far as this page knows
let knownRev = null; // the timer's settings revision that savedBody belongs to
let savingNow = false;

// Only the settings that changed since the last load/save. Pilots are positional,
// so unchanged pilots before a changed one are sent as {} (the timer skips them).
function changedSettings() {
  const now = configBody();
  const diff = {};
  for (const key of Object.keys(now)) {
    if (key === "p") continue;
    if (JSON.stringify(now[key]) !== JSON.stringify(savedBody[key])) diff[key] = now[key];
  }
  const p = [];
  now.p.forEach((pilot, i) => {
    const before = savedBody.p[i] || {};
    const changed = {};
    for (const k of Object.keys(pilot)) if (pilot[k] !== before[k]) changed[k] = pilot[k];
    p.push(changed);
  });
  while (p.length && !Object.keys(p[p.length - 1]).length) p.pop();
  if (p.length) diff.p = p;
  return { diff, now };
}

// Returns a promise resolving to true when the timer confirmed the save.
// The reply says which revision the change was applied to (base): if that is not the one
// this page has, another screen changed settings meanwhile, so load them (ours stay on top).
async function saveConfig() {
  if (!configLoaded) return false;
  const { diff, now } = changedSettings();
  if (!Object.keys(diff).length) return true;
  savingNow = true;
  let response;
  try {
    response = await postJson("/config", diff);
  } catch (err) {
    console.error("/config save failed:", err);
    return false;
  } finally {
    savingNow = false;
  }
  if (response.status !== "OK") return false;
  savedBody = now;
  if (knownRev === null || response.base === undefined || response.base === knownRev) {
    if (response.rev !== undefined) knownRev = response.rev;
  } else {
    await loadConfig(response.rev).catch(() => {}); // on failure the next status poll retries
  }
  return true;
}

// Text being typed is not replaced by a reload: it waits until the field is left
function isTypingSettings() {
  const el = document.activeElement;
  return !!el && !!el.closest("#config, #calib") && (el.tagName === "TEXTAREA" || (el.tagName === "INPUT" && el.type === "text"));
}

// Another screen changed the settings: load them
function checkSettingsRevision(rev) {
  if (!configLoaded || rev === undefined) return;
  if (knownRev === null) {
    knownRev = rev;
    return;
  }
  if (rev === knownRev || saveTimer || savingNow || configLoading || isTypingSettings()) return;
  loadConfig().catch(() => {});
}

// ── Automatic saving ──
// Every settings change is sent to the timer shortly afterwards, so all screens
// (and the timer) always use the same settings. Fields marked data-local are not settings.
// A failed save is retried until the timer has the settings.
let saveTimer = null;
let saveRetryTimer = null;

function scheduleSave() {
  if (!configLoaded) return;
  setSaveState("saving");
  clearTimeout(saveTimer);
  clearTimeout(saveRetryTimer);
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    const ok = await saveConfig();
    if (saveTimer) return; // edited again meanwhile: that save reports
    setSaveState(ok ? "saved" : "error");
    if (ok) {
      rememberPilots();
      fetchRace(); // pilot names and channels on the Race tab come from the timer
    } else {
      saveRetryTimer = setTimeout(scheduleSave, 5000);
    }
  }, 600);
}

function setSaveState(state) {
  const text = {
    loading: "Loading settings…",
    offline: "Can't reach the timer · retrying…",
    saving: "Saving…",
    saved: "Saved to timer ✓",
    error: "Not saved · retrying (tap to retry now)",
  }[state];
  for (const el of document.querySelectorAll("[data-save-state]")) {
    el.dataset.saveState = state;
    el.textContent = text;
  }
}

for (const el of document.querySelectorAll("[data-save-state]")) {
  el.addEventListener("click", () => {
    if (el.dataset.saveState === "error") scheduleSave();
  });
}

// A change made just before leaving the page is sent right away
window.addEventListener("pagehide", () => {
  if (!saveTimer || !configLoaded) return;
  clearTimeout(saveTimer);
  navigator.sendBeacon("/config", new Blob([JSON.stringify(changedSettings().diff)], { type: "application/json" }));
});

function onSettingsEdit(e) {
  if (e.target.closest("[data-local]")) return;
  scheduleSave();
}
$("config").addEventListener("input", onSettingsEdit);
$("config").addEventListener("change", onSettingsEdit);

// ── Pilot profiles (stored on the timer) ──
// The timer keeps the list: the page only saves or removes one pilot at a time, so a stale
// copy here (another phone, a failed load) can never overwrite the others.
async function loadProfiles() {
  let list;
  try {
    list = await fetchJson("/api/profiles");
  } catch (e) {
    return; // keep showing the last list
  }
  if (!Array.isArray(list)) return;
  profiles = list.sort((a, b) => a.name.localeCompare(b.name));
  if (configLoaded) renderPilots();
}

// Pilots are remembered automatically: every named pilot (name, channel, thresholds)
// is kept in the saved pilots list. Names still being typed are skipped.
const touchedPilots = new Set(); // pilot slots edited since the last save

async function rememberPilots() {
  if (!configLoaded) return;
  const touched = [...touchedPilots];
  touchedPilots.clear();
  let changed = false;
  for (const i of touched) {
    if (i >= pilotCount) continue;
    const p = pilots[i];
    const name = (p.name || "").trim();
    const nameInput = ui.pilotList.children[i].querySelector(".p-name");
    if (!name || !bandChannel(p.freq)) continue;
    if (document.activeElement === nameInput) {
      touchedPilots.add(i); // still typing: remember it after the next change
      continue;
    }
    const known = profiles.find((pr) => pr.name.toLowerCase() === name.toLowerCase());
    if (known && known.name === name && known.freq === p.freq && known.enter === p.enter && known.exit === p.exit) continue;
    try {
      await postJson("/api/profiles/save", { name, freq: p.freq, enter: p.enter, exit: p.exit });
      changed = true;
      $("profilesFull").hidden = true;
    } catch (e) {
      if (e.status === 507) $("profilesFull").hidden = false;
      else touchedPilots.add(i); // try again after the next change
    }
  }
  if (changed) loadProfiles();
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

// ── Saved WiFi networks ──
async function loadSavedNetworks() {
  const container = $("savedNetworks");
  let saved;
  try {
    saved = await fetchJson("/api/wifi/saved");
  } catch (e) {
    container.textContent = "";
    return;
  }
  container.innerHTML = "";
  if (!saved.networks.length) {
    container.appendChild(el("p", "hint", "No saved networks: the timer uses its own hotspot."));
  }
  for (const name of saved.networks) {
    const row = el("div", "saved-row");
    const label = el("span", "saved-name", name);
    row.appendChild(label);
    if (name === saved.connected) row.appendChild(el("span", "badge", "Connected"));
    const remove = el("button", "btn btn-ghost btn-small", "Remove");
    remove.addEventListener("click", async () => {
      if (!confirm(`Forget "${name}"?`)) return;
      await postJson("/api/wifi/saved/remove", { ssid: name }).catch(() => {});
      loadSavedNetworks();
    });
    row.appendChild(remove);
    container.appendChild(row);
  }
}

$("addWifiButton").addEventListener("click", async (e) => {
  const button = e.target;
  const ssid = ui.ssid.value.trim();
  if (!ssid) {
    showButtonStatus(button, "Enter a network name");
    return;
  }
  try {
    await postJson("/api/wifi/saved/add", { ssid, pwd: ui.pwd.value });
    ui.ssid.value = "";
    ui.pwd.value = "";
    $("wifiScanResults").hidden = true;
    showButtonStatus(button, "Saved ✓ · used after a restart", 4000);
    loadSavedNetworks();
  } catch (err) {
    showButtonStatus(button, "Could not save");
  }
});

// Forgets every saved network and restarts the timer into its own hotspot
$("forgetWifiButton").addEventListener("click", async (e) => {
  const button = e.target;
  if (!confirm("Forget all saved WiFi networks and restart the timer into its own hotspot?")) return;
  button.disabled = true;
  try {
    await postJson("/api/wifi/saved/clear");
  } catch (err) {
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
let lastLapCalled = [];
let seenEdits = 0; // lap corrections already taken over // staggered timed race: "last lap" announced per pilot
let raceFetchPending = false;
let raceFetchAgain = false; // laps changed while a fetch was running

function fetchRace() {
  if (raceFetchPending) {
    raceFetchAgain = true;
    return;
  }
  raceFetchPending = true;
  fetchJson("/api/race")
    .then(handleRace)
    .catch((err) => console.debug("/api/race failed:", err))
    .finally(() => {
      raceFetchPending = false;
      if (raceFetchAgain) {
        raceFetchAgain = false;
        fetchRace();
      }
    });
}

const timerEl = $("timer");

function pollStatus() {
  const fast = currentTab === "race" || currentTab === "calib" || !$("raceScreen").hidden;
  fetchJson("/api/status")
    .then(handleStatus)
    .catch((err) => console.debug("/api/status failed:", err))
    .finally(() => setTimeout(pollStatus, fast ? 250 : 600));
}

let bootId = null; // changes when the timer restarts
let profilesRev = null; // saved pilots revision

function handleStatus(s) {
  const previous = status;
  status = s;
  statusAtMs = Date.now();

  $("bvolt").textContent = (s.vbat / 10).toFixed(1) + "V";
  if (currentTab === "calib" && !rssiPaused && !s.spectrum && s.pilots[calibIndex]) $("rssiNow").textContent = s.pilots[calibIndex].rssi;

  if (s.boot !== undefined && s.boot !== bootId) {
    const restarted = bootId !== null;
    bootId = s.boot;
    if (restarted) {
      // Race ids and revisions start again after a restart: forget what was seen before
      seenRaceId = null;
      knownRev = null;
      profilesRev = null;
      if (configLoaded && !configLoading) loadConfig().catch(() => {});
      loadProfiles();
      fetchRace();
    }
  }
  if (s.prof !== undefined && s.prof !== profilesRev) {
    if (profilesRev !== null) loadProfiles();
    profilesRev = s.prof;
  }
  checkSettingsRevision(s.cfg);
  const lapCountsChanged =
    !previous ||
    previous.race !== s.race ||
    previous.state !== s.state ||
    previous.edits !== s.edits ||
    s.pilots.some((p, i) => !previous.pilots[i] || previous.pilots[i].laps !== p.laps || previous.pilots[i].fin !== p.fin);
  if (lapCountsChanged) fetchRace();

  if (s.timeUp && !seenTimeUp && seenRaceId === s.race) {
    queueSpeak("Time's up");
  }
  if (s.state === STATE.RUNNING && s.mode === MODE.TIMED && s.stag && raceData && seenRaceId === s.race) {
    const elapsed = raceElapsed();
    raceData.pilots.forEach((p, i) => {
      if (!p.laps.length || p.fin || lastLapCalled[i]) return;
      if (pilotTimeLeft(p, elapsed) <= 0) {
        lastLapCalled[i] = true;
        queueSpeak(pilotLabel(p.name, i) + ", last lap");
      }
    });
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
  if (status.state === STATE.RUNNING && status.mode === MODE.TIMED && !status.timeUp && !status.stag) {
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
      if (status.mode === MODE.TIMED && status.stag) return ["Racing · own time each", "running"];
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
  if (!$("raceScreen").hidden) {
    $("rsClock").textContent = text;
    updateCurrentLaps();
  }
}, 50);

function renderRaceControls() {
  const state = status ? status.state : STATE.IDLE;
  const racing = state === STATE.COUNTDOWN || state === STATE.WAITING || state === STATE.RUNNING;
  $("startRaceButton").disabled = racing;
  $("stopRaceButton").disabled = !racing;
  $("clearLapsButton").disabled = racing;
  if (!spectrumScanning) $("spectrumButton").disabled = racing;
  // the finished race can be corrected once it has been saved
  const saved = status && status.savedId > 0 && raceData && status.savedRace === raceData.race && raceData.pilots.some((p) => p.laps.length);
  $("editLapsButton").disabled = racing || !saved;
  let [text, cls] = statusText();
  if (status && status.saveErr) {
    text += " · last race not saved";
    cls = "waiting";
  }
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
  const stats = { laps: n, last: null, best: null, avg: null, delta: null, best3: null, consistency: null };
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

// A pilot's total time: from the race start, or with a staggered start from their own first pass
function pilotTotal(p, stag) {
  return p.laps.slice(stag ? 1 : 0).reduce((a, b) => a + b, 0);
}

// Race positions by the chosen ranking. "Most laps" is also "first to finish" in lap races
// (most laps, then least total time).
function positions(r) {
  const order = r.pilots
    .map((p, i) => {
      const st = pilotStats(p);
      return { i, laps: st.laps, total: pilotTotal(p, r.stag), best: st.best, best3: st.best3 };
    })
    .sort((a, b) => {
      if (rankBy === 1) return (a.best ?? Infinity) - (b.best ?? Infinity) || b.laps - a.laps;
      if (rankBy === 2) return (a.best3 ?? Infinity) - (b.best3 ?? Infinity) || b.laps - a.laps;
      return b.laps - a.laps || a.total - b.total;
    });
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
  if (seenRaceId === r.race && r.edits !== seenEdits) {
    // laps were corrected (merge/split): take the new lap list without announcing it
    seenEdits = r.edits;
    seenLaps = r.pilots.map((p) => p.laps.length);
  }
  if (seenRaceId !== r.race) {
    seenEdits = r.edits;
    // First sight of this race. If it hasn't started yet, announce everything
    // from its first pass; otherwise just show it (don't replay old laps).
    seenRaceId = r.race;
    const fresh = r.state === STATE.COUNTDOWN || r.state === STATE.WAITING;
    seenLaps = r.pilots.map((p) => (fresh ? 0 : p.laps.length));
    seenFinished = r.pilots.map((p) => !fresh && p.fin);
    seenRaceFinished = !fresh && r.state === STATE.FINISHED;
    lastLapCalled = r.pilots.map(() => !fresh);
  } else {
    announceNewLaps(r, configLoaded); // the announcer settings come with the settings
  }
  renderRacePilots(r);
  renderRaceScreen(r);
  renderRaceControls();
}

// speak false: only mark the laps as seen
function announceNewLaps(r, speak = true) {
  const multi = r.pilots.length > 1;
  const say = (text) => speak && queueSpeak(text);
  r.pilots.forEach((p, i) => {
    const name = pilotLabel(p.name, i);
    for (let n = seenLaps[i] || 0; n < p.laps.length; n++) {
      if (n === 0) {
        if (!r.cd && r.pilots.every((q, j) => j === i || (seenLaps[j] || 0) === 0)) say("Race start");
        else if (multi) say(name + " started");
        continue;
      }
      if (speak) announceLap(p, i, n, r);
    }
    seenLaps[i] = p.laps.length;
    if (p.fin && !seenFinished[i]) {
      if (p.full) say(multi ? name + ", lap memory full" : "Lap memory full");
      else if (multi) say(name + " finished");
      seenFinished[i] = true;
    }
  });
  if (r.state === STATE.FINISHED && !seenRaceFinished) {
    seenRaceFinished = true;
    const pos = positions(r);
    if (multi) say("Race over. Winner " + pilotLabel(r.pilots[pos.indexOf(1)].name, pos.indexOf(1)));
    else say("Race over");
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
        ${p.full ? '<span class="finished lap-memory-full">Lap memory full</span>' : p.fin ? '<span class="finished">Finished</span>' : ""}
      </div>
      <div class="stats">
        ${statBox("Laps", st.laps)}
        ${statBox("Last", st.last === null ? "–" : secs(st.last))}
        ${statBox("Delta", dText, dClass)}
        ${statBox("Best", st.best === null ? "–" : secs(st.best))}
        ${statBox("Average", st.avg === null ? "–" : secs(st.avg))}
        ${statBox("Best 3 laps", st.best3 === null ? "–" : secs(st.best3))}
      </div>
      <p class="hint">Consistency: ${st.consistency === null ? "–" : "±" + secs(st.consistency) + "s"} · Total ${secs(pilotTotal(p, r.stag))}s</p>
      ${rows.length ? `<div class="lap-table-wrap"><table><tr><th>Lap</th><th>Time</th><th>vs best</th></tr>${rows.join("")}</table></div>` : ""}`;
    container.appendChild(card);
  });
}

// ── Race controls ──
// The timer refuses a start while it is still saving the previous race, so retry briefly
async function startRace() {
  const button = $("startRaceButton");
  for (let attempt = 0; attempt < 8; attempt++) {
    const t = Math.floor(Date.now() / 1000);
    const r = await fetchTimeout("/timer/start?t=" + t, { method: "POST" }).catch(() => null);
    if (r && r.ok) {
      queueSpeak(ui.countdown.checked ? "Get ready" : "Start racing when ready");
      pollOnce();
      return;
    }
    await sleep(250);
  }
  showButtonStatus(button, "Timer busy, try again");
  pollOnce();
}

function stopRace() {
  queueSpeak("Race stopped");
  return fetchTimeout("/timer/stop", { method: "POST" })
    .catch(() => showButtonStatus($("stopRaceButton"), "No answer, try again"))
    .then(pollOnce);
}

function clearRace() {
  return fetchTimeout("/timer/clear", { method: "POST" })
    .then((r) => {
      if (r.status === 409) showButtonStatus($("clearLapsButton"), "Busy, try again");
    })
    .catch(() => showButtonStatus($("clearLapsButton"), "No answer, try again"))
    .then(pollOnce);
}

function pollOnce() {
  fetchJson("/api/status").then(handleStatus).catch(() => {});
}

$("startRaceButton").addEventListener("click", startRace);
$("stopRaceButton").addEventListener("click", stopRace);
$("clearLapsButton").addEventListener("click", clearRace);
$("editLapsButton").addEventListener("click", () => {
  editRaceId = status.savedId;
  openTab("history");
});

// ── Race screen ──
$("raceScreenButton").addEventListener("click", () => {
  $("raceScreen").hidden = false;
  document.documentElement.classList.add("race-screen-open");
  if (raceData) renderRaceScreen(raceData);
  const fs = document.documentElement.requestFullscreen;
  if (fs) fs.call(document.documentElement).catch(() => {});
});

$("rsClose").addEventListener("click", () => {
  $("raceScreen").hidden = true;
  document.documentElement.classList.remove("race-screen-open");
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
});

function renderRaceScreen(r) {
  if ($("raceScreen").hidden) return;
  const container = $("rsPilots");
  container.innerHTML = "";
  container.className = "rs-pilots rs-count-" + r.pilots.length; // 3-4 pilots get compact tiles
  const pos = positions(r);
  r.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    const tile = el("div", "rs-pilot pilot-" + (i + 1));
    let deltaHtml = "";
    if (st.delta !== null) {
      const [text, cls] = deltaText(st.delta);
      deltaHtml = `<span class="${cls.replace("delta-", "rs-delta-")}">${text}</span>`;
    }
    const lapGoal = r.mode === MODE.LAPS ? "/" + r.raceLaps : "";
    const lapText = p.full ? "Lap memory full" : p.fin ? "Finished ✓" : p.laps.length ? `Lap ${st.laps}${lapGoal}` : "Not started";
    tile.innerHTML = `
      <div class="rs-name"><span>${r.pilots.length > 1 ? pos[i] + ". " : ""}${escapeHtml(pilotLabel(p.name, i))}</span><span class="rs-lapno${p.fin ? " rs-finished" : ""}">${lapText}</span></div>
      <div class="rs-last${st.last === null ? " rs-empty" : ""}">${st.last === null ? "--.--" : secs(st.last)}</div>
      <div class="rs-row">${deltaHtml || "<span></span>"}<span class="rs-best">Best ${st.best === null ? "--.--" : secs(st.best)}</span></div>
      <div class="rs-row rs-current-row"><span>This lap</span><span class="rs-current" data-pilot="${i}">--.--</span></div>
      ${r.mode === MODE.TIMED && r.stag ? `<div class="rs-row rs-current-row"><span>Time left</span><span class="rs-left" data-pilot="${i}">--:--</span></div>` : ""}`;
    container.appendChild(tile);
  });
  updateCurrentLaps();
}

// Live "this lap" timer on the race screen: time since the pilot's last gate pass
function updateCurrentLaps() {
  if ($("raceScreen").hidden || !raceData) return;
  const running = status && status.state === STATE.RUNNING;
  const elapsed = raceElapsed();
  for (const el of document.querySelectorAll(".rs-current")) {
    const p = raceData.pilots[+el.dataset.pilot];
    if (!p || !running || !p.laps.length || p.fin) {
      el.textContent = "--.--";
      continue;
    }
    const lastPassAt = p.laps.reduce((a, b) => a + b, 0); // ms after the race start
    el.textContent = secs(Math.max(0, elapsed - lastPassAt));
  }
  for (const el of document.querySelectorAll(".rs-left")) {
    el.textContent = pilotTimeLeftText(raceData.pilots[+el.dataset.pilot], elapsed, running);
  }
}

// Staggered timed race: a pilot's time runs from their own first pass
function pilotTimeLeft(p, elapsed) {
  return raceData.raceMs - (elapsed - p.laps[0]);
}

function pilotTimeLeftText(p, elapsed, running) {
  if (!p || p.fin) return p && p.fin ? "Finished" : "--:--";
  if (!running || !p.laps.length) return formatClock(raceData.raceMs).slice(0, 5);
  const left = pilotTimeLeft(p, elapsed);
  return left > 0 ? formatClock(left) : "Last lap";
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
  container.hidden = false; // shows the pilot name even with one pilot
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
  if (!p) return;
  p.enter = +enterInput.value;
  touchedPilots.add(calibIndex);
  if (p.exit >= p.enter) p.exit = Math.max(0, p.enter - 1);
  renderCalibration();
  scheduleSave();
});

exitInput.addEventListener("input", () => {
  const p = pilots[calibIndex];
  if (!p) return;
  p.exit = +exitInput.value;
  touchedPilots.add(calibIndex);
  if (p.exit >= p.enter) p.enter = Math.min(255, p.exit + 1);
  renderCalibration();
  scheduleSave();
});

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
  rssiChart.streamTo($("rssiChart"), CHART_DELAY_MS + pausedMs);
}

function updateChartLines() {
  const p = pilots[calibIndex];
  if (!rssiChart || !p) return;
  rssiChart.options.horizontalLines = [
    { color: "hsl(8.2, 86.5%, 53.7%)", lineWidth: 1.7, value: p.enter },
    { color: "hsl(25, 85%, 55%)", lineWidth: 1.7, value: p.exit },
  ];
}

// One RSSI poll loop at a time: each start or stop begins a new generation, and a loop
// whose generation is old (e.g. its request was still running) ends by itself
let rssiLoop = 0;

function startCalibration() {
  if (!rssiChart) createRssiChart();
  rssiChart.start();
  clearTimeout(calibTimer);
  const loop = ++rssiLoop;
  pollRssi(loop);
}

function stopCalibration() {
  if (rssiChart) rssiChart.stop();
  rssiLoop++;
  clearTimeout(calibTimer);
  calibTimer = null;
}

// High-resolution RSSI history (one value per 25 ms) from the timer
// While a channel scan runs the receiver is busy sweeping: freeze the live graph, then
// continue where it stopped. The chart is drawn on a clock that leaves out paused time:
// its delay and the new points' timestamps are both shifted by the total pause.
const CHART_DELAY_MS = 100;
let rssiPaused = false;
let pausedMs = 0; // total time the graph has been paused
let pauseStartMs = 0;
let resumedAtMs = 0; // readings from before this moment belong to the paused period

function setRssiPaused(paused) {
  if (paused === rssiPaused) return;
  rssiPaused = paused;
  $("rssiPaused").hidden = !paused;
  if (paused) {
    pauseStartMs = Date.now();
    if (rssiChart) rssiChart.stop();
    $("rssiNow").textContent = "--";
  } else {
    pausedMs += Date.now() - pauseStartMs;
    resumedAtMs = Date.now();
    if (rssiChart) rssiChart.delay = CHART_DELAY_MS + pausedMs;
    if (rssiChart && currentTab === "calib") rssiChart.start();
  }
}

function pollRssi(loop) {
  if (loop !== rssiLoop) return;
  const scanning = spectrumScanning || (status && status.spectrum);
  setRssiPaused(!!scanning);
  if (scanning) {
    calibTimer = setTimeout(() => pollRssi(loop), 250);
    return;
  }
  fetchJson("/api/rssi?since=" + rssiSeq)
    .then((r) => {
      if (loop !== rssiLoop) return;
      const values = r.pilots[calibIndex] || [];
      const now = Date.now();
      values.forEach((v, k) => {
        const measuredAt = now - (values.length - 1 - k) * r.step;
        if (measuredAt < resumedAtMs) return; // taken during the pause: skip, the line continues after it
        const t = Math.max(measuredAt - pausedMs, lastPointMs + 1);
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
      if (loop === rssiLoop) calibTimer = setTimeout(() => pollRssi(loop), 250);
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
    touchedPilots.add(calibIndex);
    renderCalibration();
    scheduleSave();
  });
}

$("autoCal").addEventListener("change", () => {
  autoCalSamples = [];
  renderAutoCal();
});

// ── Channel scan (spectrum) ──
// A scan and a race never run together: the timer refuses a scan during a race,
// and starting a race cancels a running scan.
let spectrumScanning = false;

$("spectrumButton").addEventListener("click", async (e) => {
  const button = e.target;
  button.disabled = true;
  spectrumScanning = true;
  showButtonStatus(button, "Scanning… (about 7 s)", 0);
  try {
    const start = await fetchTimeout("/api/spectrum?start=1");
    if (start.status === 409) {
      showButtonStatus(button, "Not possible during a race");
      return;
    }
    // follow the scan as it runs (~6.5 s); the chart eases towards each new reading
    let data = { running: true };
    spectrumReset();
    const giveUpAt = Date.now() + 30000;
    while (data.running && Date.now() < giveUpAt) {
      await sleep(150);
      data = await fetchJson("/api/spectrum");
      if (data.running && data.total) {
        showButtonStatus(button, `Scanning… ${Math.round((100 * data.done) / data.total)}%`, 0);
        spectrumUpdate(data);
      }
    }
    const raceStarted = status && status.state >= STATE.COUNTDOWN && status.state <= STATE.RUNNING;
    if (raceStarted) {
      showButtonStatus(button, "Stopped: a race started", 4000);
      return;
    }
    spectrumUpdate(data);
    button.dataset.label = "Scan again";
    showButtonStatus(button, "Scan again", 1);
  } catch (err) {
    showButtonStatus(button, "Scan failed");
  } finally {
    spectrumScanning = false;
    renderRaceControls();
    if (!(status && status.state >= STATE.COUNTDOWN && status.state <= STATE.RUNNING)) button.disabled = false;
  }
});

// The chart is drawn like the live RSSI graph: an area line with a scale that fits the data
// (at least 90 RSSI units, so noise stays small). It is built once per scan; afterwards only
// the line moves. Shown values ease towards the latest readings for a smooth update.
const SPEC_W = 10; // SVG units per frequency step
const SPEC_H = 170;
const spec = { data: null, shown: [], min: 0, max: 90, frame: 0, els: null };

function spectrumReset() {
  cancelAnimationFrame(spec.frame); // a frame left over from an earlier scan (e.g. page was hidden)
  spec.frame = 0;
  spec.data = null;
  spec.shown = [];
  spec.els = null;
}

function spectrumUpdate(data) {
  const measured = (data.rssi || []).filter((v) => v > 0); // 0 = not measured yet
  if (!measured.length) return;
  if (!spec.els) spectrumBuild(data, Math.min(...measured));
  spec.data = data;
  const complete = !data.running;
  const floor = Math.max(0, Math.min(...measured) - 5);
  spec.els.note.hidden = !complete || Math.max(...measured) - floor >= 15;
  if (!spec.frame) spec.frame = requestAnimationFrame(spectrumFrame);
}

// Builds the chart elements for this scan: plot, pilot markers, labels
function spectrumBuild(data, firstMin) {
  const box = $("spectrum");
  const count = data.rssi.length;
  const width = count * SPEC_W;
  const freqX = (f) => ((f - data.start) / data.step) * SPEC_W + SPEC_W / 2;
  const pct = (f) => ((freqX(f) / width) * 100).toFixed(2) + "%";
  const active = pilots.slice(0, pilotCount).map((p, i) => ({ p, i })).filter(({ p }) => bandChannel(p.freq));

  let markers = "";
  active.forEach(({ p, i }) => {
    const x = freqX(p.freq);
    markers += `<line x1="${x}" x2="${x}" y1="0" y2="${SPEC_H}" stroke="var(--p${i + 1})" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />`;
  });
  let labels = "";
  for (let f = 5650; f <= data.start + (count - 1) * data.step; f += 25) labels += `<span style="left:${pct(f)}">${f}</span>`;
  let names = "";
  active.forEach(({ p, i }) => {
    names += `<span style="left:${pct(p.freq)};color:var(--p${i + 1}-text)">${escapeHtml(channelName(p.freq))}</span>`;
  });

  box.innerHTML = `
    <div class="spectrum-pilots">${names}</div>
    <div class="spectrum-plot">
      <svg viewBox="0 0 ${width} ${SPEC_H}" preserveAspectRatio="none" role="img" aria-label="Signal strength per frequency">
        <path class="spec-area" fill="hsla(214, 70%, 60%, 0.2)" />
        <path class="spec-line" fill="none" stroke="hsl(214, 70%, 60%)" stroke-width="2" vector-effect="non-scaling-stroke" />
        ${markers}
      </svg>
      <span class="spectrum-scale spectrum-scale-max"></span><span class="spectrum-scale spectrum-scale-min"></span>
    </div>
    <div class="spectrum-labels">${labels}</div>
    <p class="hint spectrum-quiet" hidden>No busy channels found: everything is at the background level.</p>`;
  box.hidden = false;
  spec.els = {
    area: box.querySelector(".spec-area"),
    line: box.querySelector(".spec-line"),
    max: box.querySelector(".spectrum-scale-max"),
    min: box.querySelector(".spectrum-scale-min"),
    note: box.querySelector(".spectrum-quiet"),
  };
  spec.shown = new Array(count).fill(null);
  spec.min = Math.max(0, firstMin - 5);
  spec.max = spec.min + 90;
}

// One animation frame: move shown values and the scale part of the way to their targets
function spectrumFrame() {
  spec.frame = 0;
  const { data, els } = spec;
  if (!data || !els) return;
  const target = data.rssi;
  const measured = target.filter((v) => v > 0);
  const targetMin = Math.max(0, Math.min(...measured) - 5);
  const targetMax = Math.max(targetMin + 90, ...measured);
  const ease = 0.25;
  let moving = false;
  const step = (from, to) => {
    const next = from + (to - from) * ease;
    if (Math.abs(to - next) > 0.3) {
      moving = true;
      return next;
    }
    return to;
  };
  spec.min = step(spec.min, targetMin);
  spec.max = step(spec.max, targetMax);
  target.forEach((v, i) => {
    if (!v) return;
    spec.shown[i] = step(spec.shown[i] === null ? spec.min : spec.shown[i], v); // new points rise from the baseline
  });

  const y = (v) => SPEC_H - ((v - spec.min) / (spec.max - spec.min)) * SPEC_H;
  const points = [];
  spec.shown.forEach((v, i) => {
    if (v !== null) points.push(`${(i * SPEC_W + SPEC_W / 2).toFixed(1)},${y(v).toFixed(1)}`);
  });
  if (points.length) {
    const line = "M" + points.join(" L");
    const firstX = points[0].split(",")[0];
    const lastX = points[points.length - 1].split(",")[0];
    els.line.setAttribute("d", line);
    els.area.setAttribute("d", `${line} L${lastX},${SPEC_H} L${firstX},${SPEC_H} Z`);
  }
  els.max.textContent = Math.round(spec.max);
  els.min.textContent = Math.round(spec.min);

  if (moving || data.running) spec.frame = requestAnimationFrame(spectrumFrame);
}

// ═══════════════════════════════════════════════════════════════════
//  History
// ═══════════════════════════════════════════════════════════════════

let historyList = [];
let editRaceId = null; // set by "Fix laps" on the Race tab: open this race for editing

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

// pilots: [{name, laps (count), best}]
function historySummaryHtml(race, pilotsSummary) {
  return `
    <div class="history-top"><span class="history-title">${escapeHtml(raceTitle(race))}</span><span class="history-meta">${MODE_NAMES[race.mode] || ""}</span></div>
    <div class="history-pilots">${pilotsSummary
      .map((p, i) => `<span class="pilot-${i + 1}"><i class="dot-p"></i>${escapeHtml(pilotLabel(p.name, i))} · ${p.laps} laps · best ${p.best ? secs(p.best) : "–"}</span>`)
      .join("")}</div>`;
}

function renderHistory() {
  const list = $("historyList");
  list.innerHTML = "";
  $("historyEmpty").hidden = historyList.length > 0;
  for (const race of historyList) {
    const card = el("div", "card history-item");
    const summary = el("button", "history-summary");
    summary.type = "button";
    summary.innerHTML = historySummaryHtml(race, race.pilots);
    const detail = el("div", "history-detail");
    detail.hidden = true;
    summary.addEventListener("click", () => {
      if (!detail.hidden) detail.hidden = true;
      else openHistoryDetail(race.id, summary, detail, false);
    });
    card.append(summary, detail);
    list.appendChild(card);
    if (race.id === editRaceId) {
      editRaceId = null;
      openHistoryDetail(race.id, summary, detail, true);
      setTimeout(() => card.scrollIntoView({ block: "start" }), 50);
    }
  }
}

async function openHistoryDetail(id, summary, detail, editing) {
  detail.hidden = false;
  detail.textContent = "Loading…";
  try {
    const full = await fetchJson("/api/races?id=" + id);
    renderHistoryDetail(detail, full, editing, summary);
  } catch (e) {
    detail.textContent = "Could not load this race.";
  }
}

// Laps of a saved race. In editing mode each lap can be merged with the next one
// (a false pass split it) or split in two (a pass was missed).
function renderHistoryDetail(container, race, editing, summary) {
  container.innerHTML = "";
  if (editing) {
    container.appendChild(
      el("p", "note", "Two short laps from a false pass? Merge the first with the next. A double-length lap from a missed pass? Split it.")
    );
  }
  race.pilots.forEach((p, i) => {
    const st = pilotStats(p);
    const block = el("div", "pilot-" + (i + 1));
    block.innerHTML = `
      <div class="race-pilot-head"><span class="dot-p"></span><span>${escapeHtml(pilotLabel(p.name, i))}</span><span class="muted">${channelName(p.freq)} ${p.freq}</span>${p.full ? '<span class="finished lap-memory-full">Lap memory full</span>' : ""}</div>
      <p class="hint">Best ${st.best === null ? "–" : secs(st.best)} · average ${st.avg === null ? "–" : secs(st.avg)} · best 3 laps ${st.best3 === null ? "–" : secs(st.best3)}</p>`;
    if (p.laps.length) {
      const table = el("table");
      table.innerHTML = `<tr><th>Lap</th><th>Time</th>${editing ? "<th>Fix</th>" : ""}</tr>`;
      p.laps.forEach((t, n) => {
        if (n === 0 && !editing) return; // start pass shown only when fixing
        const row = el("tr");
        if (n > 0 && t === st.best) row.className = "best-lap";
        row.innerHTML = `<td>${n === 0 ? "Start" : n}</td><td>${secs(t)}s</td>`;
        if (editing) {
          const actions = el("td", "lap-actions");
          const last = n === p.laps.length - 1;
          if (p.laps.length > 1 || n > 0) {
            const merge = el("button", "btn btn-ghost btn-small", last ? "Delete" : n === 0 ? "False start" : "Merge ↓");
            merge.title = last ? "False last pass: remove it" : "False pass at the end of this lap: join with the next lap";
            merge.addEventListener("click", () => editLap(race, i, 0, n, container, summary));
            actions.appendChild(merge);
          }
          if (n > 0) {
            const split = el("button", "btn btn-ghost btn-small", "Split");
            split.title = "Missed pass: split into two laps";
            split.addEventListener("click", () => editLap(race, i, 1, n, container, summary));
            actions.appendChild(split);
          }
          row.appendChild(actions);
        }
        table.appendChild(row);
      });
      const wrap = el("div", "lap-table-wrap");
      wrap.appendChild(table);
      block.appendChild(wrap);
    }
    container.appendChild(block);
  });
  const buttons = el("div", "button-row");
  const editButton = el("button", "btn btn-ghost", editing ? "Done" : "Fix laps");
  editButton.addEventListener("click", () => renderHistoryDetail(container, race, !editing, summary));
  const exportButton = el("button", "btn btn-ghost", "Export CSV");
  exportButton.addEventListener("click", () => downloadCsv([race], "laptimer-race-" + race.id + ".csv"));
  buttons.append(editButton, exportButton);
  container.appendChild(buttons);
}

// One fix at a time: the buttons stay off until the new laps are shown (a double tap would
// otherwise merge or split a second, different lap). The timer also refuses a fix made on
// laps that changed meanwhile (expect = the lap time this page shows).
async function editLap(race, pilot, op, lap, container, summary) {
  if (container.dataset.busy) return;
  container.dataset.busy = "1";
  for (const b of container.querySelectorAll(".lap-actions button")) b.disabled = true;
  let note = null;
  try {
    await postJson("/api/races/edit", { id: race.id, pilot, op, lap, expect: race.pilots[pilot].laps[lap] });
  } catch (e) {
    note = e.status === 409 ? "The laps changed meanwhile. Here they are now; check and try again." : "Could not change this lap. Is a race running?";
  }
  try {
    const full = await fetchJson("/api/races?id=" + race.id);
    renderHistoryDetail(container, full, true, summary);
    if (summary) {
      summary.innerHTML = historySummaryHtml(full, full.pilots.map((p) => {
        const st = pilotStats(p);
        return { name: p.name, laps: st.laps, best: st.best };
      }));
    }
  } catch (e) {
    note = note || "Could not load this race.";
    for (const b of container.querySelectorAll(".lap-actions button")) b.disabled = false;
  }
  delete container.dataset.busy;
  if (note) container.prepend(el("p", "note warn", note));
  fetchRace(); // the Race tab shows the same race if it was the last one
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

// A text cell starting with = + - @ (or tab/CR) would run as a formula in a spreadsheet:
// prefix it with ' so it stays text. Numbers (lap times, ids) are left as they are.
function csvCell(v) {
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

function downloadCsv(races, filename) {
  const header = ["race", "date", "mode", "pilot", "frequency", "lap", "time_s"];
  const lines = [header, ...races.flatMap(csvRows)].map((r) => r.map(csvCell).join(","));
  // the byte order mark makes Excel read the names as UTF-8
  const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
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

window.addEventListener("load", () => {
  loadConfigAtStart(); // retries until the settings are in; the settings cards wait for them
  loadSavedNetworks();
  loadInfo();
  pollStatus();
  if (ui.voiceToggle.checked) enableAudioLoop();
  startVoiceRecognition();
});
