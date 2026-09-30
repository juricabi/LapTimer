"use strict";

// ═══════════════════════════════════════════════════════════════════
//  Helpers and constants
// ═══════════════════════════════════════════════════════════════════

const $ = (id) => document.getElementById(id);

// L band (5362-5621 MHz) is below the RX5808's specified range (5645-5945): it can be tuned,
// but reception there is not guaranteed
const BANDS = ["A", "B", "E", "F", "R", "L"];
const FREQ_TABLE = [
  [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
  [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621],
];

// firmware race states and modes
const STATE = { IDLE: 0, COUNTDOWN: 1, WAITING: 2, RUNNING: 3, FINISHED: 4 };
const MODE = { PRACTICE: 0, TIMED: 1, LAPS: 2 };
const MODE_NAMES = ["Practice", "Timed race", "Lap race"];

// Some frequencies are in two bands (5880 = F8 = R7): the preferred band wins when it has
// the frequency, so the picker doesn't jump to the other band
function bandChannel(freq, preferBand = -1) {
  if (preferBand >= 0 && preferBand < FREQ_TABLE.length) {
    const c = FREQ_TABLE[preferBand].indexOf(freq);
    if (c >= 0) return { band: preferBand, channel: c };
  }
  for (let b = 0; b < FREQ_TABLE.length; b++) {
    const c = FREQ_TABLE[b].indexOf(freq);
    if (c >= 0) return { band: b, channel: c };
  }
  return null;
}

function channelName(freq) {
  const picker = document.getElementById("pilotBand"); // same band as the pilot's picker shows
  const bc = bandChannel(freq, picker ? +picker.value : -1);
  return bc ? BANDS[bc.band] + (bc.channel + 1) : "";
}

// count > 1 only for races saved by the multi-pilot firmware
function pilotLabel(name, index = 0, count = 1) {
  if (name && name.trim()) return name.trim();
  return count > 1 ? "Pilot " + (index + 1) : "Pilot";
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
let pilot = { name: "", freq: 5800, enter: 120, exit: 100 }; // who is flying
let raceMode = MODE.PRACTICE;
let announcerRate = 1.0;
let profiles = [];

const ui = {
  pilotName: $("pilotName"),
  pilotBand: $("pilotBand"),
  pilotChannel: $("pilotChannel"),
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

ui.pilotBand.innerHTML = BANDS.map((b, n) => `<option value="${n}">Band ${b}</option>`).join("");
ui.pilotChannel.innerHTML = [1, 2, 3, 4, 5, 6, 7, 8].map((c) => `<option value="${c - 1}">Channel ${c}</option>`).join("");

ui.pilotName.addEventListener("input", () => {
  const name = truncateUtf8(ui.pilotName.value, NAME_MAX_BYTES);
  if (name !== ui.pilotName.value) ui.pilotName.value = name;
  pilot.name = name;
  pilotTouched = true;
  renderCalibPilot();
  renderSavedPilots();
});
ui.pilotName.addEventListener("change", rememberPilot);
ui.pilotName.addEventListener("blur", rememberPilot); // Enter/"Done" keeps the focus in the field

function onFreqChange() {
  pilot.freq = FREQ_TABLE[+ui.pilotBand.value][+ui.pilotChannel.value];
  pilotTouched = true;
  renderPilot();
}
ui.pilotBand.addEventListener("change", onFreqChange);
ui.pilotChannel.addEventListener("change", onFreqChange);

// Who is flying: name, channel, the saved pilot it matches, and the calibration
function renderPilot() {
  ui.pilotName.value = pilot.name || "";
  const bc = bandChannel(pilot.freq, +ui.pilotBand.value);
  ui.pilotBand.value = bc ? bc.band : 4;
  ui.pilotChannel.value = bc ? bc.channel : 0;
  $("pilotFreq").textContent = bc ? pilot.freq : "Off";
  $("pilotHint").hidden = !!bc;
  renderSavedPilots();
  renderCalibPilot();
  renderCalibration();
}

// Saved pilots as chips: tap one to fly as them, × forgets one
function renderSavedPilots() {
  const container = $("savedPilots");
  container.innerHTML = "";
  $("savedPilotsBlock").hidden = profiles.length === 0;
  const current = (pilot.name || "").trim().toLowerCase();
  profiles.forEach((pr) => {
    const chip = el("span", "chip-pilot" + (pr.name.toLowerCase() === current ? " active" : ""));
    const use = el("button", "chip-name", `${pr.name} · ${channelName(pr.freq) || pr.freq}`);
    use.type = "button";
    use.setAttribute("aria-label", "Fly as " + pr.name);
    use.addEventListener("click", () => {
      if (!configLoaded) return;
      Object.assign(pilot, { name: pr.name, freq: pr.freq, enter: pr.enter, exit: pr.exit });
      renderPilot();
      scheduleSave();
    });
    chip.appendChild(use);
    const remove = el("button", "chip-remove", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", "Forget " + pr.name);
    remove.addEventListener("click", () => queueProfileChange("/api/profiles/remove", { name: pr.name }));
    chip.appendChild(remove);
    container.appendChild(chip);
  });
}

// Settings controls do nothing until the settings have loaded (they are dimmed until then)
setupSegmented($("raceMode"), (v) => {
  if (!configLoaded) return;
  raceMode = +v;
  renderRaceModeFields();
  scheduleSave();
});

function renderRaceModeFields() {
  setSegmented($("raceMode"), raceMode);
  $("raceTimeField").hidden = raceMode !== MODE.TIMED;
  $("raceLapsField").hidden = raceMode !== MODE.LAPS;
  $("raceModeHint").textContent = [
    "Unlimited laps until you press Stop.",
    "Race for a set time; you finish on your first pass after the time is up.",
    "You finish after the set number of laps.",
  ][raceMode];
}

// Puts settings in the shape of GET /config into the page
function applyConfig(config) {
  pilot = { name: config.name || "", freq: config.freq, enter: config.enterRssi, exit: config.exitRssi };
  raceMode = config.raceMode || 0;
  renderPilot();
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
  [updateRaceTimeLabel, updateRaceLapsLabel, updateMinLapLabel, updateRateLabel, updateAlarmLabel].forEach((f) => f());
}

// Settings with this page's unsaved changes (a changedSettings() diff) on top
function withChanges(config, diff) {
  return { ...config, ...diff };
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
  fetchRace(); // before a race the Race tab shows the pilot
}

// The settings as this page shows them, in the keys of GET /config
function configBody() {
  return {
    name: pilot.name,
    freq: pilot.freq,
    enterRssi: pilot.enter,
    exitRssi: pilot.exit,
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
  };
}

let savedBody = null; // settings the timer has, as far as this page knows
let knownRev = null; // the timer's settings revision that savedBody belongs to
let savingNow = false;

// Only the settings that changed since the last load/save
function changedSettings() {
  const now = configBody();
  const diff = {};
  for (const key of Object.keys(now)) {
    if (now[key] !== savedBody[key]) diff[key] = now[key];
  }
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

// Text being typed or a slider being dragged is not replaced by a reload: it waits until
// the field is left or the slider let go
let draggingSlider = false;
document.addEventListener("pointerdown", (e) => {
  if (e.target.matches && e.target.matches('input[type="range"]')) draggingSlider = true;
});
for (const type of ["pointerup", "pointercancel"]) document.addEventListener(type, () => (draggingSlider = false));

function isTypingSettings() {
  if (draggingSlider) return true;
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
      rememberPilot();
      fetchRace(); // the pilot's name and channel on the Race tab come from the timer
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
  saveTimer = null; // the page may come back from the back/forward cache
  navigator.sendBeacon("/config", new Blob([JSON.stringify(changedSettings().diff)], { type: "application/json" }));
});

function onSettingsEdit(e) {
  if (e.target.closest("[data-local]")) return;
  if (e.type === "input" && e.target.type === "range") return; // saved when let go ("change")
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
  profiles = withQueuedProfileChanges(list).sort((a, b) => a.name.localeCompare(b.name));
  renderSavedPilots();
}

// The pilot is remembered automatically: a named pilot (name, channel, thresholds) is kept
// in the saved pilots list. A name still being typed is remembered once it is done.
let pilotTouched = false; // changed on this page since it was last remembered

function rememberPilot() {
  if (!configLoaded || !pilotTouched) return;
  const name = (pilot.name || "").trim();
  if (!name || !bandChannel(pilot.freq) || document.activeElement === ui.pilotName) return;
  pilotTouched = false;
  const known = profiles.find((pr) => pr.name.toLowerCase() === name.toLowerCase());
  if (known && known.name === name && known.freq === pilot.freq && known.enter === pilot.enter && known.exit === pilot.exit) return;
  queueProfileChange("/api/profiles/save", { name, freq: pilot.freq, enter: pilot.enter, exit: pilot.exit });
}

// Saved-pilot changes go out one at a time, and never during a race: writing them to the
// timer's flash would stall its RSSI sampling. They wait here (and already show in the list)
// until the race has ended or the timer can be reached again.
const profileQueue = []; // [{url, body}]
let profileSending = false;

function isRacing() {
  return !!status && status.state >= STATE.COUNTDOWN && status.state <= STATE.RUNNING;
}

function queueProfileChange(url, body) {
  const key = body.name.toLowerCase();
  const i = profileQueue.findIndex((c) => c.body.name.toLowerCase() === key);
  if (i >= 0) profileQueue.splice(i, 1); // only the latest change to a pilot counts
  profileQueue.push({ url, body });
  profiles = withQueuedProfileChanges(profiles).sort((a, b) => a.name.localeCompare(b.name));
  renderSavedPilots();
  sendProfileChanges();
}

// The timer's list with this page's waiting changes on top
function withQueuedProfileChanges(list) {
  let out = [...list];
  for (const { url, body } of profileQueue) {
    out = out.filter((pr) => pr.name.toLowerCase() !== body.name.toLowerCase());
    if (url.endsWith("/save")) out.push({ ...body });
  }
  return out;
}

async function sendProfileChanges() {
  if (profileSending) return;
  profileSending = true;
  let sent = false;
  while (profileQueue.length && !isRacing()) {
    const { url, body } = profileQueue[0];
    try {
      await postJson(url, body);
      if (url.endsWith("/save")) $("profilesFull").hidden = true;
    } catch (e) {
      if (e.status === 409 || !e.status) break; // a race started, or no answer: try again later
      if (e.status === 507) $("profilesFull").hidden = false; // full: this pilot is not saved
    }
    profileQueue.shift();
    sent = true;
  }
  profileSending = false;
  if (sent) loadProfiles();
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
    for (let tries = 0; tries < 30 && scan.scanning; tries++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        scan = await fetchJson("/api/wifi/scan");
      } catch (e) {
        // the radio is briefly away while it scans: just ask again
      }
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
      try {
        await postJson("/api/wifi/saved/remove", { ssid: name });
      } catch (e) {
        if (e.status === 409) showButtonStatus(remove, "After the race");
        return;
      }
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
    showButtonStatus(button, err.status === 409 ? "Not during a race" : "Could not save");
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
    showButtonStatus(button, err.status === 409 ? "Not during a race" : "Failed, try again");
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
let seenLaps = 0; // lap entries already announced
let seenTimeUp = false;
let seenFinished = false;
let seenRaceFinished = false;
let seenEdits = 0; // lap corrections already taken over
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
  if (currentTab === "calib" && !rssiPaused && !s.spectrum) $("rssiNow").textContent = s.rssi;

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
  if (profileQueue.length && !isRacing()) sendProfileChanges(); // waited for the race to end
  checkSettingsRevision(s.cfg);
  const lapsChanged =
    !previous ||
    previous.race !== s.race ||
    previous.state !== s.state ||
    previous.edits !== s.edits ||
    previous.laps !== s.laps ||
    previous.fin !== s.fin;
  if (lapsChanged) fetchRace();

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
  // a timed race counts down: before the start the clock shows the time it will start from
  if (status.state === STATE.WAITING) return formatClock(status.mode === MODE.TIMED ? status.raceMs : 0);
  if (status.state === STATE.IDLE && raceMode === MODE.TIMED) return formatClock((+ui.raceTime.value || 0) * 1000);
  return formatClock(raceData ? pilotTotal(racePilot(raceData)) : 0); // last race (its total is in the stats too)
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
      return [raceData && racePilot(raceData).laps.length ? "Last race" : "Ready", ""];
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

function raceIsRunning() {
  const state = status ? status.state : STATE.IDLE;
  return state === STATE.COUNTDOWN || state === STATE.WAITING || state === STATE.RUNNING;
}

function renderRaceControls() {
  const state = status ? status.state : STATE.IDLE;
  const racing = state === STATE.COUNTDOWN || state === STATE.WAITING || state === STATE.RUNNING;
  $("startRaceButton").disabled = racing;
  $("stopRaceButton").disabled = !racing;
  $("clearLapsButton").disabled = racing;
  if (!spectrumScanning) $("spectrumButton").disabled = racing;
  // the finished race can be corrected once it has been saved
  const saved = status && status.savedId > 0 && raceData && status.savedRace === raceData.race && racePilot(raceData).laps.length > 0;
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
  // the running (or finished) race's mode; while idle the mode the next race will use
  const live = status && state !== STATE.IDLE;
  const mode = live ? status.mode : raceMode;
  let info = MODE_NAMES[mode];
  if (mode === MODE.TIMED) info += " · " + formatMinSec(live ? Math.round(status.raceMs / 1000) : +ui.raceTime.value || 0);
  if (mode === MODE.LAPS) info += " · " + (live ? status.raceLaps : +ui.raceLaps.value || 0) + " laps";
  if (live ? status.cd : ui.countdown.checked) info += " · countdown";
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

// Total time from the race start (entry 0 is the start pass)
function pilotTotal(p) {
  return p.laps.reduce((a, b) => a + b, 0);
}

// The race's one pilot (a race from the firmware always has exactly one)
function racePilot(r) {
  return r.pilots[0] || { name: pilot.name, freq: pilot.freq, laps: [], fin: false };
}

function handleRace(r) {
  // Before any race, show the pilot from the settings
  if (r.state === STATE.IDLE && !racePilot(r).laps.length) {
    r.pilots = [{ name: pilot.name, freq: pilot.freq, laps: [], fin: false }];
  }
  raceData = r;
  const p = racePilot(r);
  if (seenRaceId === r.race && r.edits !== seenEdits) {
    // laps were corrected (merge/split): take the new lap list without announcing it
    seenEdits = r.edits;
    seenLaps = p.laps.length;
  }
  if (seenRaceId !== r.race) {
    seenEdits = r.edits;
    // First sight of this race. If it hasn't started yet, announce everything
    // from its first pass; otherwise just show it (don't replay old laps).
    seenRaceId = r.race;
    const fresh = r.state === STATE.COUNTDOWN || r.state === STATE.WAITING;
    seenLaps = fresh ? 0 : p.laps.length;
    seenFinished = !fresh && p.fin;
    seenRaceFinished = !fresh && r.state === STATE.FINISHED;
  } else {
    announceNewLaps(r, configLoaded); // the announcer settings come with the settings
  }
  renderRacePilot(r);
  renderRaceScreen(r);
  renderRaceControls();
}

// speak false: only mark the laps as seen
function announceNewLaps(r, speak = true) {
  const say = (text) => speak && queueSpeak(text);
  const p = racePilot(r);
  for (let n = seenLaps; n < p.laps.length; n++) {
    if (n === 0) {
      if (!r.cd) say("Race start");
      continue;
    }
    if (speak) announceLap(p, n);
  }
  seenLaps = p.laps.length;
  if (p.fin && !seenFinished) {
    if (p.full) say("Lap memory full");
    seenFinished = true;
  }
  if (r.state === STATE.FINISHED && !seenRaceFinished) {
    seenRaceFinished = true;
    say("Race over");
  }
}

function announceLap(p, n) {
  const lapMs = p.laps[n];
  const lapStr = secs(lapMs);
  const who = p.name && p.name.trim() ? p.name.trim() + " " : "";
  const previous = p.laps.slice(1, n);
  const type = ui.announcer.value;

  if (type === "beep") {
    if (audioEnabled) beep(100, 330, "square");
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

function renderRacePilot(r) {
  const p = racePilot(r);
  const st = pilotStats(p);
  const [dText, dClass] = deltaText(st.delta);
  const bestIndex = st.best === null ? -1 : p.laps.indexOf(st.best, 1);
  const rows = [];
  for (let n = p.laps.length - 1; n >= 1; n--) {
    const d = st.best === null ? "" : n === bestIndex ? "best" : "+" + secs(p.laps[n] - st.best);
    rows.push(`<tr${n === bestIndex ? ' class="best-lap"' : ""}><td>${n}</td><td>${secs(p.laps[n])}s</td><td>${d}</td></tr>`);
  }
  if (p.laps.length) rows.push(`<tr><td>0</td><td>${r.cd ? "Start " + secs(p.laps[0]) + "s" : "Start"}</td><td></td></tr>`);
  const card = $("racePilot");
  card.className = "card race-pilot";
  card.innerHTML = `
    <div class="race-pilot-head">
      <span class="dot-p"></span>
      <span>${escapeHtml(pilotLabel(p.name))}</span>
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
    <p class="hint">Consistency: ${st.consistency === null ? "–" : "±" + secs(st.consistency) + "s"} · Total ${secs(pilotTotal(p))}s</p>
    ${rows.length ? `<div class="lap-table-wrap"><table><tr><th>Lap</th><th>Time</th><th>vs best</th></tr>${rows.join("")}</table></div>` : ""}`;
}

// ── Race controls ──
// The timer refuses a start while it is still saving the previous race, so retry briefly.
// A refused or unanswered start may still have started the race (the reply got lost, or
// another phone started it): the timer's state decides.
async function startRace() {
  const button = $("startRaceButton");
  if (button.disabled) return;
  button.disabled = true; // until the next status render (a second tap said "Get ready" again)
  for (let attempt = 0; attempt < 8; attempt++) {
    const t = Math.floor(Date.now() / 1000);
    const r = await fetchTimeout("/timer/start?t=" + t, { method: "POST" }).catch(() => null);
    if ((r && r.ok) || (await raceIsOn())) {
      queueSpeak(ui.countdown.checked ? "Get ready" : "Start racing when ready");
      pollOnce();
      return;
    }
    await sleep(250);
  }
  showButtonStatus(button, "Timer busy, try again");
  pollOnce();
}

async function raceIsOn() {
  try {
    handleStatus(await fetchJson("/api/status"));
  } catch (e) {
    return false;
  }
  return isRacing();
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
  const p = racePilot(r);
  const st = pilotStats(p);
  let deltaHtml = "";
  if (st.delta !== null) {
    const [text, cls] = deltaText(st.delta);
    deltaHtml = `<span class="${cls.replace("delta-", "rs-delta-")}">${text}</span>`;
  }
  const lapGoal = r.mode === MODE.LAPS ? "/" + r.raceLaps : "";
  const lapText = p.full ? "Lap memory full" : p.fin ? "Finished ✓" : p.laps.length ? `Lap ${st.laps}${lapGoal}` : "Not started";
  $("rsPilot").innerHTML = `
    <div class="rs-name"><span>${escapeHtml(pilotLabel(p.name))}</span><span class="rs-lapno${p.fin ? " rs-finished" : ""}">${lapText}</span></div>
    <div class="rs-last${st.last === null ? " rs-empty" : ""}">${st.last === null ? "--.--" : secs(st.last)}</div>
    <div class="rs-row">${deltaHtml || "<span></span>"}<span class="rs-best">Best ${st.best === null ? "--.--" : secs(st.best)}</span></div>
    <div class="rs-row rs-current-row"><span>This lap</span><span class="rs-current">--.--</span></div>`;
  updateCurrentLaps();
}

// Live "this lap" timer on the race screen: time since the last gate pass
function updateCurrentLaps() {
  if ($("raceScreen").hidden || !raceData) return;
  const current = document.querySelector(".rs-current");
  if (!current) return;
  const p = racePilot(raceData);
  const running = status && status.state === STATE.RUNNING;
  if (!running || !p.laps.length || p.fin) {
    current.textContent = "--.--";
    return;
  }
  current.textContent = secs(Math.max(0, raceElapsed() - pilotTotal(p))); // last pass: ms after the race start
}

// ═══════════════════════════════════════════════════════════════════
//  Calibration
// ═══════════════════════════════════════════════════════════════════

let rssiChart = null;
let rssiSeries = new TimeSeries();
let rssiSeq = 0;
let lastPointMs = 0;
let calibTimer = null;
let autoCalSamples = []; // one value per 25 ms, last 60 s
let calibFreq = null; // channel the auto-calibration samples come from

const enterInput = $("enter");
const exitInput = $("exit");

// The calibration belongs to the pilot flying: their name and channel head the graph
function renderCalibPilot() {
  $("calibPilotName").textContent = pilotLabel(pilot.name);
  $("calibPilotFreq").textContent = bandChannel(pilot.freq) ? `${channelName(pilot.freq)} ${pilot.freq}` : "no channel";
  if (pilot.freq !== calibFreq) {
    calibFreq = pilot.freq; // another channel: start the auto-calibration afresh
    autoCalSamples = [];
    renderAutoCal();
  }
}

function renderCalibration() {
  enterInput.value = pilot.enter;
  exitInput.value = pilot.exit;
  $("enterSpan").textContent = pilot.enter;
  $("exitSpan").textContent = pilot.exit;
}

// While dragging, the values and the graph lines follow the finger; the timer gets the
// result once, when the slider is let go
enterInput.addEventListener("input", () => {
  pilot.enter = +enterInput.value;
  pilotTouched = true;
  if (pilot.exit >= pilot.enter) pilot.exit = Math.max(0, pilot.enter - 1);
  renderCalibration();
});

exitInput.addEventListener("input", () => {
  pilot.exit = +exitInput.value;
  pilotTouched = true;
  if (pilot.exit >= pilot.enter) pilot.enter = Math.min(255, pilot.exit + 1);
  renderCalibration();
});

enterInput.addEventListener("change", scheduleSave);
exitInput.addEventListener("change", scheduleSave);

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
    yRangeFunction: (range) => ({
      min: Math.max(0, Math.min(range.min, pilot.exit) - 10),
      max: Math.max(range.max, pilot.enter) + 10,
    }),
  });
  rssiChart.addTimeSeries(rssiSeries, { lineWidth: 2, strokeStyle: "hsl(214, 70%, 60%)", fillStyle: "hsla(214, 70%, 60%, 0.2)" });
  rssiChart.streamTo($("rssiChart"), CHART_DELAY_MS + pausedMs);
}

function updateChartLines() {
  if (!rssiChart) return;
  rssiChart.options.horizontalLines = [
    { color: "hsl(8.2, 86.5%, 53.7%)", lineWidth: 1.7, value: pilot.enter },
    { color: "hsl(25, 85%, 55%)", lineWidth: 1.7, value: pilot.exit },
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
      const values = r.rssi || [];
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

// Auto-calibration from the recorded readings (one per 25 ms). Passes are the peaks that
// stand out from the rest; Enter goes halfway between the highest level between passes
// and the weakest pass. Checked on a real recording: 5 of 5 and 8 of 8 passes found.
const AUTOCAL_STEP_MS = 25;

function analyseAutoCal(samples, minLapMs) {
  if (samples.length < 80) return null;
  // Candidates: the highest reading within ±w, at most one per w (the first of a plateau)
  const w = Math.round(Math.max(1000, minLapMs / 2) / AUTOCAL_STEP_MS);
  const candidates = [];
  for (let i = 0; i < samples.length; i++) {
    if (candidates.length && i - candidates[candidates.length - 1] <= w) continue;
    let highest = true;
    for (let j = Math.max(0, i - w); j <= Math.min(samples.length - 1, i + w) && highest; j++) {
      highest = samples[j] <= samples[i];
    }
    if (highest) candidates.push(i);
  }
  // Passes: the candidates above the biggest gap between neighbouring heights
  const heights = candidates.map((i) => samples[i]).sort((a, b) => a - b);
  let gap = 0;
  let cut = Infinity;
  for (let k = 1; k < heights.length; k++) {
    if (heights[k] - heights[k - 1] > gap) {
      gap = heights[k] - heights[k - 1];
      cut = heights[k - 1];
    }
  }
  const passes = candidates.filter((i) => samples[i] > cut);
  if (passes.length < 3 || gap < 6) return { passes: gap < 6 ? 0 : passes.length };
  // The highest normal level between passes, and the weakest pass
  const clear = 1500 / AUTOCAL_STEP_MS;
  const between = samples.filter((v, i) => passes.every((p) => Math.abs(i - p) > clear)).sort((a, b) => a - b);
  if (!between.length) return { passes: passes.length };
  const high = between[Math.floor((between.length - 1) * 0.98)];
  const ref = Math.min(...passes.map((i) => samples[i]));
  if (ref - high < 10) return { passes: passes.length, high, ref };
  const enter = Math.round(high + (ref - high) / 2);
  return { passes: passes.length, high, ref, enter, exit: Math.min(high + 2, enter - 3) };
}

function renderAutoCal() {
  const box = $("autoCalResult");
  if (!$("autoCal").checked) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  const result = analyseAutoCal(autoCalSamples, +ui.minLap.value * 1000);
  if (!result) {
    box.textContent = "Listening… keep the quad powered and fly through the gate.";
    return;
  }
  if (result.high === undefined) {
    box.textContent = `Passes don't stand out yet (${result.passes} found). Fly 3 or more passes through the gate.`;
    return;
  }
  if (result.enter === undefined) {
    box.textContent =
      `Found ${result.passes} passes, but they are only ${result.ref - result.high} above the level between passes. ` +
      "Fly closer to the gate, lower the VTX power, or keep the drone farther away between passes.";
    return;
  }
  const html = `Passes found: <b>${result.passes}</b> · between passes ${result.high} · weakest pass ${result.ref}<br>
    Suggested: <b>Enter ${result.enter}</b>, <b>Exit ${result.exit}</b>
    <button class="btn btn-ghost btn-block" id="applyAutoCal" style="margin-top:8px">Apply</button>`;
  if (box.innerHTML === html) return; // rewritten only on a change: the Apply button is in it (tap lost otherwise)
  box.innerHTML = html;
  $("applyAutoCal").addEventListener("click", () => {
    pilot.enter = result.enter;
    pilot.exit = result.exit;
    pilotTouched = true;
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
    if (spec.data && spec.data.running) spec.data.running = false; // scan cut short: stop the frame loop
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

// Builds the chart elements for this scan: plot, the pilot's channel, labels
function spectrumBuild(data, firstMin) {
  const box = $("spectrum");
  const count = data.rssi.length;
  const width = count * SPEC_W;
  const freqX = (f) => ((f - data.start) / data.step) * SPEC_W + SPEC_W / 2;
  const pct = (f) => ((freqX(f) / width) * 100).toFixed(2) + "%";

  let marker = "";
  let names = "";
  if (bandChannel(pilot.freq)) {
    const x = freqX(pilot.freq);
    marker = `<line x1="${x}" x2="${x}" y1="0" y2="${SPEC_H}" stroke="var(--pilot)" stroke-width="2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />`;
    names = `<span style="left:${pct(pilot.freq)}">${escapeHtml(channelName(pilot.freq))}</span>`;
  }
  let labels = "";
  for (let f = 5650; f <= data.start + (count - 1) * data.step; f += 25) labels += `<span style="left:${pct(f)}">${f}</span>`;

  box.innerHTML = `
    <div class="spectrum-pilots">${names}</div>
    <div class="spectrum-plot">
      <svg viewBox="0 0 ${width} ${SPEC_H}" preserveAspectRatio="none" role="img" aria-label="Signal strength per frequency">
        <path class="spec-area" fill="hsla(214, 70%, 60%, 0.2)" />
        <path class="spec-line" fill="none" stroke="hsl(214, 70%, 60%)" stroke-width="2" vector-effect="non-scaling-stroke" />
        ${marker}
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

// pilots: [{name, laps (count), best}]; races saved by the multi-pilot firmware have several
function historySummaryHtml(race, pilotsSummary) {
  const count = pilotsSummary.length;
  return `
    <div class="history-top"><span class="history-title">${escapeHtml(raceTitle(race))}</span><span class="history-meta">${MODE_NAMES[race.mode] || ""}</span></div>
    <div class="history-pilots">${pilotsSummary
      .map((p, i) => `<span><i class="dot-p"></i>${escapeHtml(pilotLabel(p.name, i, count))} · ${p.laps} laps · best ${p.best ? secs(p.best) : "–"}</span>`)
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
    const block = el("div");
    block.innerHTML = `
      <div class="race-pilot-head"><span class="dot-p"></span><span>${escapeHtml(pilotLabel(p.name, i, race.pilots.length))}</span><span class="muted">${channelName(p.freq)} ${p.freq}</span>${p.full ? '<span class="finished lap-memory-full">Lap memory full</span>' : ""}</div>
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
  editButton.addEventListener("click", () => {
    if (!editing && raceIsRunning()) showButtonStatus(editButton, "After the race");
    else renderHistoryDetail(container, race, !editing, summary);
  });
  const exportButton = el("button", "btn btn-ghost", "Export CSV");
  exportButton.addEventListener("click", () => downloadCsv([race], "laptimer-race-" + race.id + ".csv"));
  buttons.append(editButton, exportButton);
  container.appendChild(buttons);
}

// One fix at a time: the buttons stay off until the new laps are shown (a double tap would
// otherwise merge or split a second, different lap). The timer also refuses a fix made on
// laps that changed meanwhile (expect = the lap time this page shows).
async function editLap(race, pilotIndex, op, lap, container, summary) {
  if (container.dataset.busy) return;
  container.dataset.busy = "1";
  for (const b of container.querySelectorAll(".lap-actions button")) b.disabled = true;
  let note = null;
  try {
    await postJson("/api/races/edit", { id: race.id, pilot: pilotIndex, op, lap, expect: race.pilots[pilotIndex].laps[lap] });
  } catch (e) {
    note = e.status === 409 && raceIsRunning() ? "Not during a race: try again after it."
      : e.status === 409 ? "The laps changed meanwhile. Here they are now; check and try again."
      : "Could not change this lap.";
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
      rows.push([race.id, date, MODE_NAMES[race.mode] || "", pilotLabel(p.name, i, race.pilots.length), p.freq, n, secs(t)]);
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
  if (raceIsRunning()) {
    showButtonStatus(e.target, "After the race");
    return;
  }
  if (!confirm("Delete all saved races?")) return;
  try {
    await postJson("/api/races/clear");
    loadHistory();
  } catch (err) {
    showButtonStatus(e.target, err.status === 409 ? "After the race" : "Failed");
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
  doSpeak(pilot.name.trim() ? "testing sound for " + pilot.name.trim() : "testing sound");
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
let micState = "";
let micError = null; // the last SpeechRecognition error, for the help text
let recognition = null;
function setMicState(state) {
  micState = state;
  const mic = $("micIndicator");
  mic.classList.toggle("listening", state === "listening");
  mic.classList.toggle("error", state === "error");
  if (!$("micHelp").hidden) renderMicHelp();
}

// Voice commands can be switched off per phone (Setup); remembered in this browser
function voiceCommandsWanted() {
  try {
    return localStorage.getItem("voiceCommands") !== "0";
  } catch (e) {
    return true;
  }
}
$("voiceCommands").checked = voiceCommandsWanted();
$("voiceCommands").addEventListener("change", () => {
  try {
    localStorage.setItem("voiceCommands", $("voiceCommands").checked ? "1" : "0");
  } catch (e) {
    /* private mode */
  }
  if ($("voiceCommands").checked) startVoiceRecognition();
  else stopVoiceRecognition();
});

function stopVoiceRecognition() {
  const r = recognition;
  recognition = null;
  micError = null;
  if (r) {
    r.onend = null;
    try {
      r.abort();
    } catch (e) {
      /* already stopped */
    }
  }
  setMicState("");
}

// The mic icon explains its colour and, on Chrome over plain http, how to allow the
// microphone (a page can't open chrome:// links, so the address is there to copy)
function renderMicHelp() {
  const box = $("micHelpText");
  const supported = !!(window.SpeechRecognition || window.webkitSpeechRecognition);
  const brave = !!navigator.brave;
  const copy = (text) => `<code>${escapeHtml(text)}</code><button type="button" class="btn btn-ghost btn-small" data-copy="${escapeHtml(text)}">Copy</button>`;
  let html;
  if (!voiceCommandsWanted()) {
    html = "<p>Voice commands are off on this phone. Switch them on in Setup → Announcer.</p>";
  } else if (!supported) {
    html = "<p>This browser has no speech recognition. Voice commands work in Chrome.</p>";
  } else if (micState === "listening") {
    html = "<p>Listening. Say <b>start</b> (or go), <b>stop</b>, <b>best time</b> or <b>clear time</b>. The announcer's own voice is ignored.</p>";
  } else if (brave) {
    html = "<p>Brave blocks the speech service that Chrome uses, so voice commands can't work here. Announcements do. For voice commands open this page in Chrome.</p>";
  } else if (micError === "not-allowed" || micError === "service-not-allowed") {
    html = location.protocol === "http:"
      ? `<p>Chrome allows the microphone only on <i>https</i> sites, and the timer's page is plain <i>http</i>. Allow it once:</p>
        <ol>
          <li>Open ${copy("chrome://flags/#unsafely-treat-insecure-origin-as-secure")} in Chrome's address bar.</li>
          <li>Enter ${copy(location.origin)} in its text box and set it to <b>Enabled</b>.</li>
          <li>Relaunch Chrome, open the timer's page again and allow the microphone when asked.</li>
        </ol>
        <p class="hint">If the microphone was refused before: tap the icon left of the address → Permissions → Microphone → Allow, then reload.</p>`
      : "<p>The microphone was refused. Tap the icon left of the address → Permissions → Microphone → Allow, then reload the page.</p>";
  } else if (micError === "network") {
    html = `<p>No connection to the speech service: Chrome sends speech to Google, and on the timer's hotspot the phone has no internet (mobile data doesn't help: Android then stops reaching the timer).</p>
      <p>Voice commands work when the phone has internet on the same network: at home with the timer on your WiFi, or at the field with the timer joined to <b>your phone's hotspot</b> (Setup → WiFi networks, then open the timer's address). Retrying every few seconds.</p>`;
  } else if (micError === "audio-capture") {
    html = "<p>No microphone found on this device.</p>";
  } else {
    html = "<p>Starting voice recognition… If it stays grey, tap the page once (browsers start the microphone only after a tap) or reload.</p>";
  }
  box.innerHTML = html;
  for (const b of box.querySelectorAll("[data-copy]")) {
    b.addEventListener("click", () => {
      // navigator.clipboard needs https: select the text and copy it the old way
      const ta = document.createElement("textarea");
      ta.value = b.dataset.copy;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch (e) {
        ok = false;
      }
      document.body.removeChild(ta);
      showButtonStatus(b, ok ? "Copied ✓" : "Select and copy", 2000);
    });
  }
}

$("micIndicator").addEventListener("click", () => {
  const help = $("micHelp");
  help.hidden = !help.hidden;
  if (!help.hidden) {
    renderMicHelp();
    help.scrollIntoView({ block: "start" });
  }
});
$("micHelpClose").addEventListener("click", () => ($("micHelp").hidden = true));

function speakBestTime() {
  const best = raceData ? pilotStats(racePilot(raceData)).best : null;
  queueSpeak(best === null ? "No best lap recorded yet" : `Best lap ${secs(best)} seconds`);
}

function startVoiceRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    console.warn("Speech recognition not supported in this browser. Voice commands disabled.");
    return;
  }
  if (!voiceCommandsWanted() || recognition) return; // off on this phone, or already running
  micError = null;
  recognition = new SpeechRecognition();
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
      if (has("best time")) speakBestTime();
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
  // Chrome ends the recognition after every error: a refused microphone would otherwise
  // restart it in a tight loop (with Android's listening chime each time), so it stops there
  // and waits a little after the other errors (no network, no audio)
  let lastError = null;
  recognition.onerror = (e) => {
    lastError = e.error;
    micError = e.error;
    setMicState("error");
  };
  recognition.onend = () => {
    if (lastError === "not-allowed" || lastError === "service-not-allowed") return;
    const restart = () => {
      try {
        recognition.start(); // keep listening
        if (!lastError) {
          micError = null;
          setMicState("listening");
        }
      } catch (e) {
        console.warn("Failed to restart recognition", e);
      }
    };
    if (lastError) setTimeout(restart, 3000);
    else restart();
    lastError = null;
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
