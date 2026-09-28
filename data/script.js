const bcf = document.getElementById("bandChannelFreq");
const bandSelect = document.getElementById("bandSelect");
const channelSelect = document.getElementById("channelSelect");
const freqOutput = document.getElementById("freqOutput");
const announcerSelect = document.getElementById("announcerSelect");
const announcerRateInput = document.getElementById("rate");
const enterRssiInput = document.getElementById("enter");
const exitRssiInput = document.getElementById("exit");
const enterRssiSpan = document.getElementById("enterSpan");
const exitRssiSpan = document.getElementById("exitSpan");
const pilotNameInput = document.getElementById("pname");
const ssidInput = document.getElementById("ssid");
const pwdInput = document.getElementById("pwd");
const minLapInput = document.getElementById("minLap");
const alarmThreshold = document.getElementById("alarmThreshold");

const freqLookup = [
  [5865, 5845, 5825, 5805, 5785, 5765, 5745, 5725],
  [5733, 5752, 5771, 5790, 5809, 5828, 5847, 5866],
  [5705, 5685, 5665, 5645, 5885, 5905, 5925, 5945],
  [5740, 5760, 5780, 5800, 5820, 5840, 5860, 5880],
  [5658, 5695, 5732, 5769, 5806, 5843, 5880, 5917],
  [5362, 5399, 5436, 5473, 5510, 5547, 5584, 5621],
];

const config = document.getElementById("config");
const race = document.getElementById("race");
const calib = document.getElementById("calib");

var enterRssi = 120,
  exitRssi = 100;
var frequency = 0;
var announcerRate = 1.0;

var lapNo = -1;
var lapTimes = []; // completed lap times (s), excluding the race start pass
var lastLapNumber = null; // last lap number reported by the timer (null = not synced yet)
var raceActive = false;
var raceStartMs = 0;
// Track the top 3 best lap times (lower is better)
var bestLapTime = Infinity;
var secondBestLapTime = Infinity;
var thirdBestLapTime = Infinity;
var waitingToStart = false;

var timerInterval;
const timer = document.getElementById("timer");
const startRaceButton = document.getElementById("startRaceButton");
const stopRaceButton = document.getElementById("stopRaceButton");
const batteryVoltageDisplay = document.getElementById("bvolt");
const rssiNowDisplay = document.getElementById("rssiNow");

const rssiBuffer = [];
var rssiValue = 0;
var rssiSending = false;
var rssiChart;
var crossing = false;
var rssiSeries = new TimeSeries();
var rssiCrossingSeries = new TimeSeries();
var maxRssiValue = enterRssi + 10;
var minRssiValue = exitRssi - 10;

var audioEnabled = false;
var speakObjsQueue = [];
var configLoaded = false;

// Voice command support (Web Speech API)
// NOTE: This starts automatically on page load and has no UI toggle. Microphone permission will be requested by the browser.
var recognition = null;

// Colors the mic chip in the top bar: 'listening' (green), 'error' (red) or '' (grey)
function setMicState(state) {
  const mic = document.getElementById('micIndicator');
  if (!mic) return;
  mic.classList.toggle('listening', state === 'listening');
  mic.classList.toggle('error', state === 'error');
}

function startVoiceRecognition() {
  if (!('webkitSpeechRecognition' in window) && !('SpeechRecognition' in window)) {
    console.warn('Web Speech API not supported in this browser. Voice commands disabled.');
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = false;

  recognition.onresult = function(event) {
    for (let i = event.resultIndex; i < event.results.length; ++i) {
      if (event.results[i].isFinal) {
        const transcript = event.results[i][0].transcript.trim().toLowerCase();
        console.log('Voice recognized:', transcript);
        // New voice commands:
        // - "best time" -> announce current best lap time
        // - "clear time" / "clear best time" -> reset best/second/third lap times
        // Ignore what the mic hears while (or just after) the announcer speaks,
        // otherwise "Race stopped" / "Start racing" would trigger commands.
        if (Date.now() - lastSpeechMs < 1500) {
          console.log('Ignoring voice command heard during announcement');
          break;
        }
        const has = (word) => new RegExp('\\b' + word + '\\b').test(transcript);
        if (has('best time')) {
          speakBestTime();
          break;
        } else if (has('clear time') || has('clear best')) {
          clearBestTimes();
          break;
        } else if (has('start') || has('begin') || has('go')) {
          if (!raceActive) startRace();
          break;
        } else if (has('stop')) {
          if (raceActive) stopRace();
          break;
        }
      }
    }
  };

  recognition.onerror = function(event) {
    console.warn('Speech recognition error', event);
    setMicState('error');
  };

  recognition.onend = function() {
    // automatically restart recognition
    try {
      recognition.start();
    } catch (e) {
      console.warn('Failed to restart recognition', e);
    }
  };

  try {
    recognition.start();
    setMicState('listening');
  } catch (e) {
    console.warn('Speech recognition start failed', e);
  }
}

onload = function (e) {
  config.style.display = "block";
  race.style.display = "none";
  calib.style.display = "none";
  fetch("/config")
    .then((response) => response.json())
    .then((config) => {
      console.log(config);
      setBandChannelIndex(config.freq);
      minLapInput.value = (parseFloat(config.minLap) / 10).toFixed(1);
      updateMinLap(minLapInput, minLapInput.value);
      alarmThreshold.value = (parseFloat(config.alarm) / 10).toFixed(1);
      updateAlarmThreshold(alarmThreshold, alarmThreshold.value);
      announcerSelect.selectedIndex = config.anType;
      announcerRateInput.value = (parseFloat(config.anRate) / 10).toFixed(1);
      updateAnnouncerRate(announcerRateInput, announcerRateInput.value);
      enterRssiInput.value = config.enterRssi;
      updateEnterRssi(enterRssiInput, enterRssiInput.value);
      exitRssiInput.value = config.exitRssi;
      updateExitRssi(exitRssiInput, exitRssiInput.value);
      pilotNameInput.value = config.name;
      ssidInput.value = config.ssid;
      document.getElementById("buzzerToggle").checked = !!config.buzzerOn;
      pwdInput.value = config.pwd;
      populateFreqOutput();
      // Status polling may already have detected a running race; keep that state
      setRaceButtons(raceActive);
      if (!raceActive) timer.innerHTML = formatClock(0);
      clearLaps();
      createRssiChart();
      enableAudioLoop();
      configLoaded = true; // <-- Set flag here
      // start voice recognition automatically (no UI toggle)
      startVoiceRecognition();
    });
};


function addRssiPoint() {
  if (calib.style.display != "none" && rssiChart) {
    rssiChart.start();
    if (rssiBuffer.length > 0) {
      rssiValue = parseInt(rssiBuffer.shift());
      if (crossing && rssiValue < exitRssi) {
        crossing = false;
      } else if (!crossing && rssiValue > enterRssi) {
        crossing = true;
      }
      maxRssiValue = Math.max(maxRssiValue, rssiValue);
      minRssiValue = Math.min(minRssiValue, rssiValue);
    }

    // update horizontal lines and min max values
    rssiChart.options.horizontalLines = [
      { color: "hsl(8.2, 86.5%, 53.7%)", lineWidth: 1.7, value: enterRssi }, // red
      { color: "hsl(25, 85%, 55%)", lineWidth: 1.7, value: exitRssi }, // orange
    ];

    rssiChart.options.maxValue = Math.max(maxRssiValue, enterRssi + 10);

    rssiChart.options.minValue = Math.max(0, Math.min(minRssiValue, exitRssi - 10));

    var now = Date.now();
    rssiSeries.append(now, rssiValue);
    if (crossing) {
      rssiCrossingSeries.append(now, 256);
    } else {
      rssiCrossingSeries.append(now, -10);
    }
  } else if (rssiChart) {
    rssiChart.stop();
    maxRssiValue = enterRssi + 10;
    minRssiValue = exitRssi - 10;
  }
}

setInterval(addRssiPoint, 200);

function createRssiChart() {
  // Match the page theme (light/dark); the canvas background comes from CSS
  const css = getComputedStyle(document.documentElement);
  rssiChart = new SmoothieChart({
    responsive: true,
    millisPerPixel: 50,
    grid: {
      fillStyle: "transparent",
      strokeStyle: css.getPropertyValue("--border").trim() || "rgba(128,128,128,0.25)",
      millisPerLine: 5000,
      sharpLines: true,
      verticalSections: 0,
      borderVisible: false,
    },
    labels: {
      precision: 0,
      fillStyle: css.getPropertyValue("--muted").trim() || "#888",
    },
    maxValue: 1,
    minValue: 0,
  });
  rssiChart.addTimeSeries(rssiSeries, {
    lineWidth: 1.7,
    strokeStyle: "hsl(214, 53%, 60%)",
    fillStyle: "hsla(214, 53%, 60%, 0.4)",
  });
  rssiChart.addTimeSeries(rssiCrossingSeries, {
    lineWidth: 1.7,
    strokeStyle: "none",
    fillStyle: "hsla(136, 71%, 70%, 0.3)",
  });
  rssiChart.streamTo(document.getElementById("rssiChart"), 200);
}

function openTab(evt, tabName) {
  // Declare all variables
  var i, tabcontent, tablinks;

  // Get all elements with class="tabcontent" and hide them
  tabcontent = document.getElementsByClassName("tabcontent");
  for (i = 0; i < tabcontent.length; i++) {
    tabcontent[i].style.display = "none";
  }

  // Get all elements with class="tablinks" and remove the class "active"
  tablinks = document.getElementsByClassName("tablinks");
  for (i = 0; i < tablinks.length; i++) {
    tablinks[i].className = tablinks[i].className.replace(" active", "");
  }

  // Show the current tab, and add an "active" class to the button that opened the tab
  document.getElementById(tabName).style.display = "block";
  evt.currentTarget.className += " active";

  // if event comes from calibration tab, signal to start sending RSSI events
  if (tabName === "calib" && !rssiSending) {
    fetch("/timer/rssiStart", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    })
      .then((response) => {
        if (response.ok) rssiSending = true;
        return response.json();
      })
      .then((response) => console.log("/timer/rssiStart:" + JSON.stringify(response)));
  } else if (rssiSending) {
    fetch("/timer/rssiStop", {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
    })
      .then((response) => {
        if (response.ok) rssiSending = false;
        return response.json();
      })
      .then((response) => console.log("/timer/rssiStop:" + JSON.stringify(response)));
  }
}

function updateEnterRssi(obj, value) {
  enterRssi = parseInt(value);
  enterRssiSpan.textContent = enterRssi;
  if (enterRssi <= exitRssi) {
    exitRssi = Math.max(0, enterRssi - 1);
    exitRssiInput.value = exitRssi;
    exitRssiSpan.textContent = exitRssi;
  }
}

function updateExitRssi(obj, value) {
  exitRssi = parseInt(value);
  exitRssiSpan.textContent = exitRssi;
  if (exitRssi >= enterRssi) {
    enterRssi = Math.min(255, exitRssi + 1);
    enterRssiInput.value = enterRssi;
    enterRssiSpan.textContent = enterRssi;
  }
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

// Returns a promise resolving to true when the timer confirmed the save
function saveConfig(button) {
  if (!configLoaded) {
    alert("Configuration not loaded yet. Please wait until all fields are loaded.");
    return Promise.resolve(false);
  }
  if (button) button.disabled = true;
  return fetch("/config", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      freq: frequency,
      minLap: Math.round(minLapInput.value * 10),
      alarm: Math.round(alarmThreshold.value * 10),
      anType: announcerSelect.selectedIndex,
      anRate: Math.round(announcerRate * 10),
      enterRssi: enterRssi,
      exitRssi: exitRssi,
      name: pilotNameInput.value,
      ssid: ssidInput.value,
      pwd: pwdInput.value,
      buzzerOn: document.getElementById("buzzerToggle").checked
    }),
  })
    .then((response) => {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then((response) => {
      console.log("/config:" + JSON.stringify(response));
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

// Clears the home WiFi and restarts the timer into its own hotspot
function forgetHomeWifi(button) {
  if (!confirm("Forget the home WiFi and restart the timer into its own hotspot?")) return;
  ssidInput.value = "";
  pwdInput.value = "";
  button.disabled = true;
  saveConfig(null).then((ok) => {
    if (!ok) {
      button.disabled = false;
      showButtonStatus(button, "Failed, try again");
      return;
    }
    fetch("/restart", { method: "POST" }).catch(() => {});
    showButtonStatus(button, "Restarting…", 0);
    document.getElementById("wifiForgotten").hidden = false;
  });
}

function populateFreqOutput() {
  let band = bandSelect.options[bandSelect.selectedIndex].value;
  let chan = channelSelect.options[channelSelect.selectedIndex].value;
  frequency = freqLookup[bandSelect.selectedIndex][channelSelect.selectedIndex];
  freqOutput.textContent = band + chan;
  document.getElementById("freqMhz").textContent = frequency;
  document.getElementById("raceFreq").textContent = band + chan + " · " + frequency + " MHz";
}

// Restart the ESP device via POST /restart
function restartEsp() {
  const btn = document.getElementById('restartEspButton');
  if (!confirm('Are you sure?')) return;
  if (btn) btn.disabled = true;
  fetch('/restart', {
    method: 'POST',
    headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' }
  })
    .then(response => {
      if (!response.ok) throw new Error('Network response was not ok');
      return response.json();
    })
    .then(json => {
      console.log('/restart:', json);
    })
    .catch(err => {
      console.error('Failed to restart ESP:', err);
    })
    .finally(() => {
      if (btn) btn.disabled = false;
    });
}

bcf.addEventListener("change", function handleChange(event) {
  populateFreqOutput();
});

function updateAnnouncerRate(obj, value) {
  announcerRate = parseFloat(value);
  $(obj).parent().find("span").text(announcerRate.toFixed(1));
}

function updateMinLap(obj, value) {
  $(obj)
    .parent()
    .find("span")
    .text(parseFloat(value).toFixed(1) + "s");
}

function updateAlarmThreshold(obj, value) {
  $(obj)
    .parent()
    .find("span")
    .text(parseFloat(value) == 0 ? "Off" : parseFloat(value).toFixed(1) + "v");
}

// Browsers cap the number of AudioContexts, so reuse a single one.
var audioContext = null;

function beep(duration, frequency, type) {
  if (!audioContext) audioContext = new AudioContext();
  if (audioContext.state === "suspended") audioContext.resume();
  var oscillator = audioContext.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = frequency;
  oscillator.connect(audioContext.destination);
  oscillator.start();
  oscillator.stop(audioContext.currentTime + duration / 1000);
}

// lapNumber comes from the timer: 0 = race start pass, 1.. = completed laps
function addLap(lapNumber, lapStr) {
  const pilotName = pilotNameInput.value;
  var last2lapStr = "";
  var last3lapStr = "";
  const newLap = parseFloat(lapStr);
  lapNo = lapNumber;
  const table = document.getElementById("lapTable");
  const row = table.insertRow();
  const cell1 = row.insertCell(0);
  const cell2 = row.insertCell(1);
  const cell3 = row.insertCell(2);
  const cell4 = row.insertCell(3);
  cell1.innerHTML = lapNo;
  if (lapNo == 0) {
    cell2.innerHTML = "Start";
  } else {
    cell2.innerHTML = lapStr + "s";
    row.dataset.lapTime = newLap;
    // Update top-3 best lap times (lower is better)
    // Shift down when a new top time is achieved.
    if (newLap < bestLapTime) {
      // new best: push previous bests down
      thirdBestLapTime = secondBestLapTime;
      secondBestLapTime = bestLapTime;
      bestLapTime = newLap;
    } else if (newLap < secondBestLapTime) {
      // new second best (but not best)
      thirdBestLapTime = secondBestLapTime;
      secondBestLapTime = newLap;
    } else if (newLap < thirdBestLapTime) {
      // new third best
      thirdBestLapTime = newLap;
    }
  }
  if (lapTimes.length >= 1 && lapNo != 0) {
    last2lapStr = (newLap + lapTimes[lapTimes.length - 1]).toFixed(2);
    cell3.innerHTML = last2lapStr + "s";
  }
  if (lapTimes.length >= 2 && lapNo != 0) {
    last3lapStr = (newLap + lapTimes[lapTimes.length - 2] + lapTimes[lapTimes.length - 1]).toFixed(2);
    cell4.innerHTML = last3lapStr + "s";
  }
  window.scrollTo(0, document.body.scrollHeight); // Scroll to the bottom of the page

  switch (announcerSelect.options[announcerSelect.selectedIndex].value) {
    case "beep":
      beep(100, 330, "square");
      break;
    case "1lap":
      if (lapNo == 0) {
        queueSpeak(`<p>Race start</p>`);
      } else {
        const lapNoStr = pilotName + " Lap " + lapNo + ", ";
        const text = "<p>" + lapNoStr + lapStr + "</p>";
        queueSpeak(text);
        // Add best/2nd/3rd lap announcement if this was a top-3 lap
        // Compare rounded values to avoid floating point comparison issues
        const roundedLap = parseFloat(newLap).toFixed(2);
        if (roundedLap === parseFloat(bestLapTime).toFixed(2)) {
          queueSpeak(`<p>Best lap</p>`);
        } else if (roundedLap === parseFloat(secondBestLapTime).toFixed(2)) {
          queueSpeak(`<p>Second best lap</p>`);
        } else if (roundedLap === parseFloat(thirdBestLapTime).toFixed(2)) {
          queueSpeak(`<p>Third best lap</p>`);
        }
      }
      break;
    case "2lap":
      if (lapNo == 0) {
        queueSpeak(`<p>Race start</p>`);
      } else if (last2lapStr != "") {
        const text2 = "<p>" + pilotName + " 2 laps " + last2lapStr + "</p>";
        queueSpeak(text2);
      }
      break;
    case "3lap":
      if (lapNo == 0) {
        queueSpeak(`<p>Race start</p>`);
      } else if (last3lapStr != "") {
        const text3 = "<p>" + pilotName + " 3 laps " + last3lapStr + "</p>";
        queueSpeak(text3);
      }
      break;
    default:
      break;
  }
  if (lapNo != 0) lapTimes.push(newLap);
  highlightBestLap();
}

// Mark the fastest lap row in the table
function highlightBestLap() {
  const rows = document.querySelectorAll("#lapTable tr[data-lap-time]");
  let best = null;
  rows.forEach((r) => {
    r.classList.remove("best-lap");
    if (best === null || parseFloat(r.dataset.lapTime) < parseFloat(best.dataset.lapTime)) best = r;
  });
  if (best) best.classList.add("best-lap");
}

function setRaceStatus(text, state) {
  const el = document.getElementById("raceStatus");
  el.textContent = text;
  el.className = "race-status" + (state ? " " + state : "");
}

function formatClock(ms) {
  const totalCs = Math.floor(ms / 10);
  const cs = totalCs % 100;
  const s = Math.floor(totalCs / 100) % 60;
  const m = Math.floor(totalCs / 6000);
  const pad = (n) => (n < 10 ? "0" + n : "" + n);
  return `${pad(m)}:${pad(s)}.${pad(cs)}`;
}

// Race clock based on elapsed wall time, so it stays correct even if the
// browser throttles timers (e.g. screen off).
function startTimer() {
  raceStartMs = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(function () {
    timer.innerHTML = formatClock(Date.now() - raceStartMs);
  }, 50);
}

function queueSpeak(obj) {
  if (!audioEnabled) {
    return;
  }
  speakObjsQueue.push(obj);
}

var audioLoopRunning = false;
var lastSpeechMs = 0; // last time the announcer was speaking (for voice command echo filtering)

async function enableAudioLoop() {
  audioEnabled = true;
  if (audioLoopRunning) return; // only one loop, or announcements get spoken twice
  audioLoopRunning = true;
  while (audioEnabled) {
    // Only "speaking" is checked: some Android browsers leave "pending" stuck
    const isSpeakingFlag = speechSupported && speechSynthesis.speaking;
    if (isSpeakingFlag) {
      lastSpeechMs = Date.now();
      // Watchdog: a stuck speech engine would block every later announcement
      if (Date.now() - speakStartMs > 15000) {
        console.warn("Speech stuck, resetting");
        speechSynthesis.cancel();
      }
    } else if (speakObjsQueue.length > 0) {
      let obj = speakObjsQueue.shift();
      lastSpeechMs = Date.now();
      doSpeak(obj);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  audioLoopRunning = false;
}

function disableAudioLoop() {
  audioEnabled = false;
}

// Test voice: speaks the first phrase directly from the tap (strictest browsers
// only allow speech inside a user gesture) and shows the outcome on the button.
function generateAudio() {
  const button = document.getElementById("GenerateAudioButton");
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
  const pilotName = pilotNameInput.value;
  speakObjsQueue = [];
  speechSynthesis.cancel();
  doSpeak("<div>testing sound for pilot " + pilotName + "</div>");
  for (let i = 1; i <= 3; i++) {
    queueSpeak("<div>" + i + "</div>");
  }
  // Some browsers silently ignore speech without any error event
  setTimeout(() => {
    if (speechTestButton === button && button.textContent === "Speaking…") {
      showButtonStatus(button, "Browser gave no sound", 8000);
      speechTestButton = null;
    }
  }, 5000);
}

// Temporarily replaces a button's label; holdMs 0 keeps it until the next call
function showButtonStatus(button, text, holdMs = 4000) {
  if (!button) return;
  if (!button.dataset.label) button.dataset.label = button.textContent;
  clearTimeout(button.statusTimer);
  button.textContent = text;
  if (holdMs) button.statusTimer = setTimeout(() => (button.textContent = button.dataset.label), holdMs);
}

// Always announce in English, regardless of the phone's system language.
// utterance.lang selects the language; forcing a voice object can make Android
// browsers silent, so only desktop browsers also get an explicit English voice.
// If the browser rejects English, retry once with its default voice.
const speechSupported = "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
const isAndroid = /android/i.test(navigator.userAgent);
var speakStartMs = 0;
var speechTestButton = null; // set while "Test voice" is running, to report the result

function findEnglishVoice() {
  const voices = speechSynthesis.getVoices();
  return (
    voices.find((v) => v.lang.replace("_", "-") === "en-US") ||
    voices.find((v) => v.lang.toLowerCase().startsWith("en"))
  );
}

function doSpeak(obj, useEnglish = true) {
  if (!speechSupported) return;
  const text = $("<div>").html(obj).text().trim();
  if (!text) return;
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
    if (speechTestButton && speakObjsQueue.length === 0) {
      showButtonStatus(speechTestButton, "Voice works ✓");
      speechTestButton = null;
    }
  };
  utterance.onerror = (e) => {
    console.warn("Speech error:", e.error);
    if (e.error === "interrupted" || e.error === "canceled") return;
    if (useEnglish) {
      doSpeak(obj, false); // retry with the browser's default voice
    } else if (speechTestButton) {
      showButtonStatus(speechTestButton, "Voice error: " + e.error, 8000);
      speechTestButton = null;
    }
  };
  speakStartMs = Date.now();
  speechSynthesis.speak(utterance);
}

// Announce the current best lap time via the existing audio queue.
function speakBestTime() {
  if (bestLapTime === Infinity) {
    queueSpeak('<p>No best lap recorded yet</p>');
  } else {
    const bestStr = parseFloat(bestLapTime).toFixed(2);
    const pilotName = pilotNameInput.value || '';
    const pre = pilotName ? pilotName + ', ' : '';
    queueSpeak(`<p>${pre}Best lap ${bestStr} seconds</p>`);
  }
}

// Clear stored best/second/third lap times and announce the action.
function clearBestTimes() {
  bestLapTime = Infinity;
  secondBestLapTime = Infinity;
  thirdBestLapTime = Infinity;
  if (audioEnabled) {
    queueSpeak('<p>Best times cleared</p>');
  }
}

function setRaceButtons(active) {
  raceActive = active;
  startRaceButton.disabled = active;
  stopRaceButton.disabled = !active;
}

// Arms the timer; the race clock starts when the timer reports the first gate pass.
async function startRace() {
  setRaceButtons(true);
  waitingToStart = true;
  lastLapNumber = -1;
  clearLaps();
  clearInterval(timerInterval);
  timer.innerHTML = formatClock(0);
  setRaceStatus("Waiting for first gate pass…", "waiting");
  queueSpeak("<p>Start racing when ready</p>");
  fetch("/timer/start", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  })
    .then((response) => response.json())
    .then((response) => console.log("/timer/start:" + JSON.stringify(response)));
}

function stopRace() {
  queueSpeak('<p>Race stopped</p>');
  clearInterval(timerInterval);
  timer.innerHTML = formatClock(0);
  setRaceStatus("Ready");
  waitingToStart = false;
  setRaceButtons(false);
  fetch("/timer/stop", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
  })
    .then((response) => response.json())
    .then((response) => console.log("/timer/stop:" + JSON.stringify(response)));

  lapNo = -1;
  lapTimes = [];
  // reset best lap tracking
  bestLapTime = Infinity;
  secondBestLapTime = Infinity;
  thirdBestLapTime = Infinity;
}

function clearLaps() {
  var tableHeaderRowCount = 1;
  var rowCount = lapTable.rows.length;
  for (var i = tableHeaderRowCount; i < rowCount; i++) {
    lapTable.deleteRow(tableHeaderRowCount);
  }
  lapNo = -1;
  lapTimes = [];
  // reset best lap tracking
  bestLapTime = Infinity;
  secondBestLapTime = Infinity;
  thirdBestLapTime = Infinity;
}


function handleStatus(status) {
  rssiBuffer.push(status.rssi);
  if (rssiBuffer.length > 10) {
    rssiBuffer.shift();
  }

  rssiNowDisplay.textContent = status.rssi;
  if (typeof status.vbat !== "undefined") {
    batteryVoltageDisplay.textContent = (status.vbat / 10).toFixed(1) + "V";
  }

  const n = status.lapnumber;
  if (typeof n === "undefined") return;

  // First status after page load: just sync, don't replay old laps
  if (lastLapNumber === null) {
    lastLapNumber = n;
    if (n >= 0) {
      // a race is already running (page reloaded or started from another device)
      setRaceButtons(true);
      setRaceStatus("Racing", "running");
    }
    return;
  }
  if (n === lastLapNumber) return;

  // After pressing Start, only the race start pass (lap 0) matters; a stale
  // lap number from the previous race may still arrive in an in-flight poll.
  if (waitingToStart && n !== 0) {
    lastLapNumber = n;
    return;
  }

  if (n < lastLapNumber) {
    // Timer was stopped/restarted (from another device or voice command)
    lastLapNumber = n;
    return;
  }
  lastLapNumber = n;

  if (n === 0) {
    // First gate pass: race starts now
    waitingToStart = false;
    setRaceButtons(true);
    setRaceStatus("Racing", "running");
    startTimer();
    addLap(0, "0");
  } else {
    const lap = (parseFloat(status.laptime) / 1000).toFixed(2);
    addLap(n, lap);
    console.log("lap", n, "raw:", status.laptime, "formatted:", lap);
  }
}

// Poll faster on the calibration tab for a smoother RSSI graph.
// Chained timeouts avoid piling up requests on a slow connection.
function pollStatus() {
  const intervalMs = calib.style.display != "none" ? 200 : 500;
  fetch("/api/status")
    .then((response) => response.json())
    .then(handleStatus)
    .catch((err) => console.debug("/api/status failed:", err))
    .finally(() => setTimeout(pollStatus, intervalMs));
}
pollStatus();

function setBandChannelIndex(freq) {
  for (var i = 0; i < freqLookup.length; i++) {
    for (var j = 0; j < freqLookup[i].length; j++) {
      if (freqLookup[i][j] == freq) {
        bandSelect.selectedIndex = i;
        channelSelect.selectedIndex = j;
      }
    }
  }
}
