// Page test suite: the whole web page against the mock, section by section.
//
//   1. python tools/mock_server.py
//   2. open http://127.0.0.1:8765/mock/log in Chrome and keep the tab in front (background tabs
//      run timers once a second); in the console load this file:
//        document.head.append(Object.assign(document.createElement("script"), { src: "/mock/page_test.js" }))
//      (or from a command line, headless and not slowed down: node tools/run_page_test.js [sections])
//   3. await pageTest()                     every section (several minutes)
//      await pageTest(["setup", "race"])    some of them (pageTest.sections lists them)
//      → {passed, failed: [{name, detail}]}; every check is logged as PASS/FAIL
//
// The page runs in a 390 × 844 iframe (a phone), so it can be reloaded during a test. Each
// section starts from /mock/reset. Nothing reaches the PC: confirm() answers OK and is recorded,
// downloads, copied text and speech are caught, voice commands are off (no microphone request).

const PAGE_TEST_SECTIONS = ["layout", "setup", "race", "raceSettings", "raceEdges", "calibrate", "history", "historyEdges", "connection", "voice",
  "update"];

async function pageTest(only) {
  const T = pageTestHarness();
  for (const name of PAGE_TEST_SECTIONS) {
    if (only && !only.includes(name)) continue;
    console.log(`── ${name} ──`);
    T.sectionName = name;
    await T.reset();
    try {
      await PAGE_TEST[name](T);
    } catch (e) {
      T.check(`${name}: ran to the end`, false, String((e && e.stack) || e));
    }
  }
  await T.reset();
  const failed = T.results.filter((r) => !r.ok);
  return { passed: T.results.length - failed.length, failed: failed.map((r) => ({ name: r.name, detail: r.detail })) };
}
pageTest.sections = PAGE_TEST_SECTIONS;

function pageTestHarness() {
  const T = {
    results: [],
    sectionName: "",
    errors: [],
    spoken: [],
    dialogs: [],
    downloads: [],
    copied: [],
    w: null,
    d: null,
  };
  T.check = (name, ok, detail) => {
    T.results.push({ name: `${T.sectionName}: ${name}`, ok: !!ok, detail });
    let shown = "";
    try {
      shown = detail === undefined ? "" : "  " + JSON.stringify(detail);
    } catch (e) {
      shown = "  " + String(detail);
    }
    console.log((ok ? "PASS " : "FAIL ") + `${T.sectionName}: ${name}` + shown); // one line (also for tools/run_page_test.js)
    return !!ok;
  };
  T.sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  T.until = async (cond, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await T.sleep(100)) {
      try {
        if (cond()) return true;
      } catch (e) {
        // not there yet
      }
    }
    try {
      return !!cond();
    } catch (e) {
      return false;
    }
  };
  T.get = (url) => fetch(url).then((r) => r.json());
  T.post = (url, body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) =>
      r.json().catch(() => ({})).then((j) => ({ status: r.status, ...j, code: r.status }))); // code: the HTTP status
  T.mock = (path) => fetch("/mock/" + path).then((r) => r.json());
  T.otherPhone = (settings) => T.post("/config", settings); // a second phone saving settings
  T.config = () => T.get("/config");
  T.reset = async () => {
    await T.mock("reset");
    try {
      localStorage.setItem("voiceCommands", "0"); // no microphone request from the page under test
      localStorage.setItem("voiceOn", "1");
    } catch (e) {
      // private mode
    }
  };

  // the page in a phone-sized frame
  T.frame = () => {
    let f = document.getElementById("pt");
    if (!f) {
      document.documentElement.innerHTML = '<body style="margin:0;background:#888"><iframe id="pt" style="width:390px;height:844px;border:0"></iframe></body>';
      f = document.getElementById("pt");
    }
    return f;
  };
  // Loads a page (default: the timer's page) and waits for its settings; hooks dialogs,
  // downloads, copying and speech
  T.open = async (path = "/", wait = true) => {
    const f = T.frame();
    await new Promise((r) => {
      f.onload = r;
      f.src = path + (path.includes("?") ? "&" : "?") + "t=" + Date.now();
    });
    const w = (T.w = f.contentWindow);
    T.d = w.document;
    w.addEventListener("error", (e) => T.errors.push(`${T.sectionName}: ${e.message}`));
    w.addEventListener("unhandledrejection", (e) => T.errors.push(`${T.sectionName}: rejection ${(e.reason && e.reason.message) || e.reason}`));
    w.confirm = (text) => {
      T.dialogs.push(text);
      return T.confirmAnswer !== false;
    };
    w.alert = (text) => T.dialogs.push(text);
    T.realQueueSpeak = w.queueSpeak;
    w.queueSpeak = (text) => T.spoken.push(text);
    w.downloadBlob = (blob, name) => T.downloads.push({ blob, name });
    w.copyText = (text) => {
      T.copied.push(text);
      return true;
    };
    if (wait && path.startsWith("/") && !path.startsWith("/update")) {
      await T.until(() => T.v("configLoaded") && T.v("status") !== null, 15000);
    }
    return w;
  };
  T.v = (expr) => T.w.eval(expr); // the page's own variables (let/const aren't on window)
  T.$ = (sel) => T.d.querySelector(sel);
  T.$$ = (sel) => [...T.d.querySelectorAll(sel)];
  T.text = (sel) => {
    const e = typeof sel === "string" ? T.$(sel) : sel;
    return e ? e.textContent.replace(/\s+/g, " ").trim() : null;
  };
  T.shown = (sel) => {
    const e = typeof sel === "string" ? T.$(sel) : sel;
    return !!e && !e.closest("[hidden]") && e.getClientRects().length > 0;
  };
  T.tab = async (name) => {
    T.w.openTab(name);
    await T.sleep(150);
  };
  T.button = (text, root) => [...(root || T.d).querySelectorAll("button")].find((b) => b.textContent.trim() === text);
  T.setValue = (sel, value) => {
    const e = typeof sel === "string" ? T.$(sel) : sel;
    e.value = value;
    e.dispatchEvent(new T.w.Event("input", { bubbles: true }));
    e.dispatchEvent(new T.w.Event("change", { bubbles: true }));
  };
  T.toggle = (sel, on) => {
    const e = T.$(sel);
    if (e.checked !== on) e.click();
  };
  T.saveState = () => T.$("#config [data-save-state]").dataset.saveState;
  T.saved = () => T.until(() => T.v("saveTimer === null && !savingNow") && T.saveState() === "saved");
  T.lastSaveBody = async () => {
    const log = await T.mock("log");
    return log.length ? log[log.length - 1].body : null;
  };
  // the Race tab's pieces
  T.line = () => T.text("#raceInfo");
  T.card = () => T.$("#racePilot .race-pilot-head").innerText.replace(/\s+/g, " ").trim();
  T.stat = (label) => {
    const box = T.$$("#racePilot .stat").find((s) => s.querySelector(".stat-label").textContent === label);
    return box ? box.querySelector(".stat-value").textContent : null;
  };
  T.raceShown = () => T.v("raceData && status && raceData.race === status.race");
  T.laps = () => T.v("racePilot(raceData).laps.length");
  T.idle = () => T.until(() => T.v("status.state") === 0 && !T.$("#startRaceButton").disabled);
  T.raceScreen = () => {
    T.$("#raceScreenButton").click();
    const extra = {};
    for (const item of T.$$(".rs-extra > div")) extra[item.querySelector("span").textContent] = item.querySelector("b").textContent;
    const out = { name: T.text(".rs-name span"), lap: T.text(".rs-lapno"), last: T.text(".rs-last"), best: T.text(".rs-best"), extra };
    T.$("#rsClose").click();
    return out;
  };
  // the light theme on a dark system: the dark rule taken out of the page's stylesheet
  T.lightTheme = () => {
    const sheet = [...T.d.styleSheets].find((s) => s.href && s.href.includes("style.css"));
    const i = [...sheet.cssRules].findIndex((r) => r.media && r.media.mediaText.includes("prefers-color-scheme"));
    if (i >= 0) sheet.deleteRule(i);
  };
  // Layout at 390 px: nothing wider than the screen, touch targets at least 44 px
  T.layout = (where) => {
    const width = T.w.innerWidth;
    const wide = T.$$("body *")
      .filter((e) => e.getClientRects().length && !e.closest("[hidden]"))
      .filter((e) => e.getBoundingClientRect().right > width + 0.5 && getComputedStyle(e).position !== "fixed")
      .map((e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}.${[...e.classList].join(".")} ${Math.round(e.getBoundingClientRect().right)}`);
    T.check(`${where}: nothing wider than the screen`, T.d.documentElement.scrollWidth <= width && wide.length === 0, wide.slice(0, 5));
    const small = T.$$("button, select, input, summary, a[href]")
      .filter((e) => T.shown(e) && getComputedStyle(e).visibility !== "hidden")
      .map((e) => {
        // a switch's whole row is its target; the mic chip has an invisible 44 px target around it
        const target = e.type === "checkbox" ? e.closest(".switch-row") || e : e;
        if (e.matches("button.chip-icon")) return null;
        const r = target.getBoundingClientRect();
        return r.height < 43.5 ? `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""} "${(e.textContent || e.value || "").trim().slice(0, 20)}" ${Math.round(r.height)}px` : null;
      })
      .filter(Boolean);
    T.check(`${where}: touch targets at least 44 px`, small.length === 0, small.slice(0, 6));
  };
  // the page's own statistics, worked out here independently from the laps
  T.expectStats = (allLaps) => {
    const laps = allLaps.slice(1);
    const n = laps.length;
    const s2 = (ms) => (ms / 1000).toFixed(2);
    const best = Math.min(...laps);
    const avg = laps.reduce((a, b) => a + b, 0) / n;
    const consecutive = (k) => {
      let m = null;
      for (let i = 0; i + k <= n; i++) {
        const sum = laps.slice(i, i + k).reduce((a, b) => a + b, 0);
        if (m === null || sum < m) m = sum;
      }
      return m === null ? "–" : s2(m);
    };
    const total = allLaps.reduce((a, b) => a + b, 0);
    const cs = Math.round(total / 10);
    const totalText = cs < 6000 ? s2(total) : `${Math.floor(cs / 6000)}:${(cs % 6000 < 1000 ? "0" : "") + ((cs % 6000) / 100).toFixed(2)}`;
    const consistency = n >= 2 ? "±" + s2(Math.sqrt(laps.reduce((a, b) => a + (b - avg) ** 2, 0) / n)) : "–";
    return { Laps: String(n), Last: s2(laps[n - 1]), Best: s2(best), Average: s2(avg), Consistency: consistency,
      "Best 2 laps": consecutive(2), "Best 3 laps": consecutive(3), Total: totalText };
  };
  T.callout = (lapMs, target) => {
    const diff = lapMs - target;
    return Math.abs(diff) <= 50 ? "On target" : (diff > 0 ? "plus " : "minus ") + (Math.abs(diff) / 1000).toFixed(2);
  };
  return T;
}

const PAGE_TEST = {};

// ── Layout: every tab and view at 390 px, dark and light ──
PAGE_TEST.layout = async (T) => {
  await T.mock("lap?s=1.5");
  for (const theme of ["dark", "light"]) {
    await T.open();
    if (theme === "light") T.lightTheme();
    for (const tab of ["config", "race", "calib", "history"]) {
      await T.tab(tab);
      T.layout(`${theme}, ${tab} tab`);
    }
    // a race with laps: the stats, chart and table
    await T.tab("race");
    await T.w.startRace();
    await T.until(() => T.raceShown() && T.laps() >= 4, 15000);
    T.layout(`${theme}, Race tab racing`);
    T.$("#raceScreenButton").click();
    T.layout(`${theme}, race screen`);
    T.$("#rsClose").click();
    await T.w.stopRace();
    await T.idle();
    // history detail, rename form, the race picture, the mic help card
    await T.tab("history");
    await T.until(() => T.$$(".history-item").length > 0);
    const item = T.$$(".history-item")[0];
    item.querySelector(".history-summary").click();
    await T.until(() => item.querySelector(".history-detail .button-row"));
    T.button("Rename", item).click();
    T.layout(`${theme}, history detail with rename`);
    T.button("Fix laps", item).click();
    T.layout(`${theme}, fixing laps`);
    T.button("Done", item).click();
    T.button(T.v("shareMenu") ? "Share image" : "Save image", item).click();
    await T.until(() => T.$(".image-preview img"), 15000);
    T.layout(`${theme}, race picture`);
    T.$(".image-preview .rs-close").click();
    T.$("#micIndicator").click();
    T.layout(`${theme}, mic help`);
    T.$("#micHelpClose").click();
  }
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Setup: pilot, saved pilots, race settings, announcer, alerts, this phone, WiFi, timer ──
PAGE_TEST.setup = async (T) => {
  await T.open();
  await T.tab("config");
  T.check("settings loaded: saved state", T.saveState() === "saved", T.text("#config [data-save-state]"));
  await T.until(() => T.text("#infoVersion") !== "–");
  T.check("timer info: version, connection, address",
    T.text("#infoVersion") === "1.2.0-dev" && T.text("#infoMode") === "Home WiFi · Home WiFi" && T.text("#infoIp") === "192.168.1.50 · laptimer.local",
    [T.text("#infoVersion"), T.text("#infoMode"), T.text("#infoIp")]);
  T.check("on home WiFi: the note about the network going away shows", T.shown("#wifiLostNote"));

  // pilot name: UTF-8 cut at 20 bytes, saved, remembered as a saved pilot when left
  const name = T.$("#pilotName");
  name.focus();
  T.setValue(name, "ŠĐČĆŽšđčćžŠĐČĆŽ");
  T.check("pilot name cut at 20 bytes on a whole character", name.value === "ŠĐČĆŽšđčćž", name.value);
  T.setValue(name, "Goose");
  name.blur();
  await T.saved();
  T.check("pilot name saved on the timer", (await T.config()).name === "Goose");
  await T.until(() => T.$$("#savedPilots .chip-name").some((b) => b.textContent.startsWith("Goose")));
  const goose = (await T.get("/api/profiles")).find((p) => p.name === "Goose");
  T.check("a named pilot is remembered as a saved pilot", goose && goose.freq === 5800, goose);
  T.check("its chip is the active one", T.$$("#savedPilots .chip-pilot.active").map((c) => c.textContent).join().startsWith("Goose"));

  // band and channel: 5880 is F8 and R7; the band shown stays
  T.setValue("#pilotBand", "4");
  T.setValue("#pilotChannel", "6");
  await T.saved();
  T.check("R7 picked: 5880 MHz saved", (await T.config()).freq === 5880 && T.text("#pilotFreq") === "5880", T.text("#pilotFreq"));
  await T.otherPhone({ minLap: 55 }); // a reload of the settings from another phone
  await T.until(() => T.$("#minLap").value === "5.5");
  T.check("after a reload 5880 still shows as R7 (not F8)", T.$("#pilotBand").value === "4" && T.$("#pilotChannel").value === "6",
    [T.$("#pilotBand").value, T.$("#pilotChannel").value]);
  await T.otherPhone({ freq: 1111 }); // receiver off: no channel
  await T.until(() => T.text("#pilotFreq") === "Off");
  T.check("no channel: 'Off' and the hint", T.text("#pilotFreq") === "Off" && T.shown("#pilotHint"));
  // (a new timer starts like this.) A picker fires no change for the option it already shows:
  // showing R1 there, R1 couldn't be picked. It shows no channel, so any pick is a change.
  T.check("no channel: the channel picker shows none", T.$("#pilotChannel").selectedIndex === -1, T.$("#pilotChannel").selectedIndex);
  T.check("no channel: the Race tab says so (not '1111')", T.text("#racePilot .race-pilot-head .muted") === "no channel",
    T.text("#racePilot .race-pilot-head .muted"));
  await T.w.startRace();
  await T.sleep(300);
  T.check("Start with no channel: refused, says why", !T.v("isRacing()") && T.text("#startRaceButton") === "No channel: pick one in Setup" &&
    T.spoken.at(-1) === "No channel. Pick one in Setup", [T.v("isRacing()"), T.text("#startRaceButton"), T.spoken.at(-1)]);
  if (T.v("isRacing()")) {
    await T.w.stopRace();
    await T.idle();
  }
  T.setValue("#pilotChannel", "0");
  await T.saved();
  T.check("then picking Channel 1: R1 5658", (await T.config()).freq === 5658 && T.text("#pilotFreq") === "5658" && !T.shown("#pilotHint"),
    T.text("#pilotFreq"));

  // saved pilots: tap one to fly as them, × to forget
  T.$$("#savedPilots .chip-name").find((b) => b.textContent.startsWith("Iceman")).click();
  await T.saved();
  let cfg = await T.config();
  T.check("tapping a saved pilot takes name, channel, thresholds and target",
    cfg.name === "Iceman" && cfg.freq === 5658 && cfg.enterRssi === 125 && cfg.exitRssi === 104 && cfg.target === 4300 && T.$("#targetLap").value === "4.3",
    cfg);
  T.$$("#savedPilots .chip-pilot").find((c) => c.textContent.startsWith("Rooster")).querySelector(".chip-remove").click();
  await T.until(() => !T.$$("#savedPilots .chip-name").some((b) => b.textContent.startsWith("Rooster")));
  await T.sleep(500);
  T.check("× forgets a saved pilot on the timer", !(await T.get("/api/profiles")).some((p) => p.name === "Rooster"));
  T.check("× asks first", T.dialogs.at(-1) === 'Forget "Rooster"?', T.dialogs.at(-1));

  // a saved pilot tapped while a new name is being typed: that pilot, the typed name dropped
  // (a real tap blurs the field before its click, unless the press keeps the focus there)
  const chipOf = (n) => T.$$("#savedPilots .chip-pilot").find((c) => c.querySelector(".chip-name").textContent.startsWith(n + " ·"));
  name.focus();
  T.setValue(name, "Goo");
  const press = new T.w.MouseEvent("mousedown", { bubbles: true, cancelable: true });
  chipOf("Iceman").querySelector(".chip-name").dispatchEvent(press);
  if (!press.defaultPrevented) name.blur(); // what the tap does then
  chipOf("Iceman").querySelector(".chip-name").click();
  await T.saved();
  await T.sleep(800);
  cfg = await T.config();
  let names = (await T.get("/api/profiles")).map((p) => p.name);
  T.check("a saved pilot tapped while typing a name: that pilot, the typed name not remembered",
    cfg.name === "Iceman" && !names.includes("Goo") && T.d.activeElement !== name, [cfg.name, names]);

  // forgetting the pilot you fly as: the settings stay, the next change doesn't save it again
  chipOf("Iceman").querySelector(".chip-remove").click();
  await T.until(() => !chipOf("Iceman"));
  T.setValue("#enter", "130");
  await T.saved();
  await T.sleep(800);
  names = (await T.get("/api/profiles")).map((p) => p.name);
  T.check("the pilot forgotten while flying as it isn't saved again by the next change",
    (await T.config()).enterRssi === 130 && !names.includes("Iceman"), names);
  name.focus();
  T.setValue(name, "Iceman");
  name.blur();
  await T.saved();
  await T.until(() => !!chipOf("Iceman"));
  await T.sleep(500);
  T.check("typing its name again remembers it", (await T.get("/api/profiles")).some((p) => p.name === "Iceman" && p.enter === 130));

  // a saved-pilot change during a race waits for the end of the race
  await T.w.startRace();
  await T.until(() => T.v("isRacing()"));
  await T.tab("config");
  T.setValue(name, "Viper");
  name.blur();
  await T.saved();
  await T.until(() => T.$$("#savedPilots .chip-name").some((b) => b.textContent.startsWith("Viper")));
  T.check("during a race the new pilot shows at once but waits to be sent",
    T.v("profileQueue.length") === 1 && !(await T.get("/api/profiles")).some((p) => p.name === "Viper"), T.v("profileQueue.length"));
  await T.w.stopRace();
  await T.idle();
  await T.sleep(1500);
  T.check("after the race it is saved", (await T.get("/api/profiles")).some((p) => p.name === "Viper") && T.v("profileQueue.length") === 0);

  // saved pilots full: the timer refuses, the page says so
  for (let i = 0; i < 80; i++) {
    const r = await T.post("/api/profiles/save", { name: "Filler pilot " + i, freq: 5800, enter: 120, exit: 100 });
    if (r.code === 507) break;
  }
  await T.until(() => T.$$("#savedPilots .chip-name").length > 20, 4000);
  T.setValue(name, "One too many");
  name.blur();
  await T.saved();
  T.check("saved pilots full: the message shows", await T.until(() => T.shown("#profilesFull"), 6000));
  T.check("the refused pilot isn't listed", await T.until(() => !T.$$("#savedPilots .chip-name").some((b) => b.textContent.startsWith("One too many")), 4000));

  // × answered Cancel keeps the pilot; forgetting one makes room for the pilot that didn't fit
  T.confirmAnswer = false;
  chipOf("Filler pilot 0").querySelector(".chip-remove").click();
  T.confirmAnswer = true;
  await T.sleep(500);
  T.check("× answered Cancel: the pilot stays", !!chipOf("Filler pilot 0") && (await T.get("/api/profiles")).some((p) => p.name === "Filler pilot 0"));
  chipOf("Filler pilot 0").querySelector(".chip-remove").click();
  T.check("forgetting a pilot when full: the message goes", await T.until(() => !T.shown("#profilesFull"), 4000));
  let kept = false;
  for (let i = 0; i < 40 && !kept; i++) {
    kept = (await T.get("/api/profiles")).some((p) => p.name === "One too many");
    if (!kept) await T.sleep(100);
  }
  T.check("... and the pilot that didn't fit is remembered now", kept);
  await T.until(() => !T.v("profileSending") && T.v("profileQueue.length") === 0);
  // a forget the timer couldn't write (507 from a failed flash write) isn't "full"
  const post = T.w.postJson;
  T.w.postJson = (url, body) => (url.endsWith("/remove") ? Promise.reject(Object.assign(new Error("full"), { status: 507 })) : post(url, body));
  chipOf("Filler pilot 1").querySelector(".chip-remove").click();
  await T.until(() => !T.v("profileSending") && T.v("profileQueue.length") === 0);
  await T.until(() => !!chipOf("Filler pilot 1"), 3000);
  T.w.postJson = post;
  T.check("a forget the timer couldn't write: the pilot shows again, no 'full' message",
    !!chipOf("Filler pilot 1") && !T.shown("#profilesFull"));

  // race settings: only the changed setting is sent
  T.$('#raceMode [data-value="1"]').click();
  T.check("Timed: race time shown, its hint", T.shown("#raceTimeField") && !T.shown("#raceLapsField") &&
    T.text("#raceModeHint") === "Race for a set time; you finish on your first pass after the time is up.");
  T.setValue("#raceTime", "90");
  T.check("race time label 1:30", T.text("#raceTimeField .val") === "1:30", T.text("#raceTimeField .val"));
  await T.saved();
  cfg = await T.config();
  const body = await T.lastSaveBody();
  T.check("Timed 1:30 saved, only the changed keys sent", cfg.raceMode === 1 && cfg.raceSec === 90 &&
    Object.keys(body).every((k) => ["raceMode", "raceSec"].includes(k)), body);
  T.$('#raceMode [data-value="2"]').click();
  T.check("Laps: laps shown, its hint", T.shown("#raceLapsField") && !T.shown("#raceTimeField") && T.text("#raceModeHint") === "You finish after the set number of laps.");
  T.setValue("#raceLaps", "7");
  T.toggle("#countdown", true);
  T.setValue("#minLap", "7.5");
  T.check("min lap label 7.5s", T.$("#minLap").parentElement.querySelector(".val").textContent === "7.5s");
  await T.saved();
  cfg = await T.config();
  T.check("laps, countdown and min lap saved", cfg.raceMode === 2 && cfg.raceLaps === 7 && cfg.countdown === true && cfg.minLap === 75, cfg);
  T.$('#raceMode [data-value="0"]').click();
  T.check("Practice: neither field, its hint", !T.shown("#raceLapsField") && !T.shown("#raceTimeField") && T.text("#raceModeHint") === "Unlimited laps until you press Stop.");

  // announcer and alerts
  T.setValue("#announcerSelect", "2lap");
  T.setValue("#rate", "1.5");
  for (const [value, hint] of [["none", "Nothing more after each lap."], ["best", "best lap"], ["target", "target lap"]]) {
    T.$(`#lapCompare [data-value="${value}"]`).click();
    T.check(`compare with ${value}: one choice, its hint`, T.$$("#lapCompare button.active").length === 1 && T.text("#lapCompareHint").includes(hint),
      T.text("#lapCompareHint"));
  }
  T.toggle("#buzzerToggle", false);
  T.setValue("#alarmThreshold", "3.3");
  T.check("alarm label 3.3v", T.$("#alarmThreshold").parentElement.querySelector(".val").textContent === "3.3v");
  await T.saved();
  cfg = await T.config();
  T.check("announcer and alerts saved", cfg.anType === 3 && cfg.anRate === 15 && cfg.anTarget === true && cfg.anDelta === false &&
    cfg.buzzerOn === false && cfg.alarm === 33, cfg);
  T.setValue("#alarmThreshold", "0");
  T.check("alarm 0 shows Off", T.$("#alarmThreshold").parentElement.querySelector(".val").textContent === "Off");

  // this phone (not on the timer)
  await T.saved();
  const before = (await T.mock("log")).length;
  T.toggle("#voiceToggle", false);
  T.check("Voice off: kept on this phone, the announcer card says so",
    localStorage.getItem("voiceOn") === "0" && T.text("#announcerNote").startsWith("Voice is off on this phone"), T.text("#announcerNote"));
  T.toggle("#voiceToggle", true);
  T.check("Voice on again", localStorage.getItem("voiceOn") === "1" && T.text("#announcerNote").startsWith("Spoken by every phone"));
  // Voice off silences at once: what was still waiting isn't said when it's switched on again
  let cancelled = 0;
  T.w.speechSynthesis.cancel = () => cancelled++;
  T.v("speakQueue.push('Lap 5', 'minus 0.20')");
  const waiting = T.v("speakQueue.length");
  T.toggle("#voiceToggle", false);
  T.check("Voice off: speech stops, announcements still waiting are dropped", T.v("speakQueue.length") === 0 && cancelled === 1,
    [waiting, T.v("speakQueue.length"), cancelled]);
  delete T.w.speechSynthesis.cancel;
  T.toggle("#voiceToggle", true);
  T.toggle("#voiceCommands", true);
  T.check("Voice commands kept on this phone", localStorage.getItem("voiceCommands") === "1");
  T.toggle("#voiceCommands", false);
  await T.sleep(900);
  T.check("this phone's switches aren't sent to the timer", (await T.mock("log")).length === before, (await T.mock("log")).length - before);

  // two phones: a remote change doesn't overwrite a name being typed
  name.focus();
  name.value = "Typing";
  name.dispatchEvent(new T.w.Event("input", { bubbles: true }));
  await T.otherPhone({ name: "Remote" });
  await T.sleep(1200);
  T.check("while typing, another phone's change doesn't replace the field", name.value === "Typing", name.value);
  name.blur();
  await T.saved();
  T.check("this phone's name is saved after typing", (await T.config()).name === "Typing");

  // a save that fails: the state says so and it retries
  await T.mock("fail?save=2");
  T.toggle("#countdown", false);
  T.check("failed save: 'Not saved · retrying'", await T.until(() => T.saveState() === "error", 5000), T.saveState());
  T.$("#config [data-save-state]").click(); // tap to retry now (the second failure)
  await T.until(() => T.saveState() === "error" || T.saveState() === "saved", 5000);
  T.check("then saved by the retry", await T.until(() => T.saveState() === "saved", 12000) && (await T.config()).countdown === false, T.saveState());

  // a change just before leaving the page is sent (sendBeacon)
  T.toggle("#countdown", true);
  await T.open(); // leave the page at once
  await T.sleep(300);
  T.check("a change made just before leaving reaches the timer", (await T.config()).countdown === true);

  // WiFi networks
  await T.tab("config");
  await T.until(() => T.$$("#savedNetworks .saved-row").length === 2);
  T.check("saved networks listed, the connected one marked",
    T.$$("#savedNetworks .saved-name").map((e) => e.textContent).join() === "Home WiFi,Field hotspot" &&
    T.text("#savedNetworks .saved-row .badge") === "Connected");
  T.$("#wifiScanButton").click();
  await T.until(() => T.shown("#wifiScanResults"), 8000);
  const found = T.$$("#wifiScanResults button").map((b) => b.textContent);
  T.check("scan: strongest first, locks on protected networks", found[0].startsWith("Home WiFi 🔒") && found[2].startsWith("Cafe guest") &&
    !found[2].includes("🔒"), found);
  T.$$("#wifiScanResults button")[2].click();
  T.check("picking one fills the name and moves to the password", T.$("#ssid").value === "Cafe guest" && T.d.activeElement === T.$("#pwd") &&
    !T.shown("#wifiScanResults"));
  T.$("#ssid").value = " ";
  T.$("#addWifiButton").click();
  T.check("an empty name is refused", T.text("#addWifiButton") === "Enter a network name");
  T.$("#ssid").value = "Cafe guest";
  T.$("#addWifiButton").click();
  await T.until(() => T.text("#addWifiButton").startsWith("Saved"));
  await T.until(() => T.$$("#savedNetworks .saved-row").length === 3);
  T.check("network saved: listed, fields cleared", T.$$("#savedNetworks .saved-name").some((e) => e.textContent === "Cafe guest") &&
    T.$("#ssid").value === "" && T.$("#pwd").value === "");

  // a long unbroken name (32 bytes) in the scan: its row keeps the signal visible
  const long = T.$$("#wifiScanResults button").find((b) => b.textContent.startsWith("ZZZZ"));
  T.$("#wifiScanResults").hidden = false;
  const lr = long.getBoundingClientRect();
  const sr = long.querySelector(".signal").getBoundingClientRect();
  T.check("scan: a 32-byte name doesn't push the signal out of its row", sr.width > 0 && sr.right <= lr.right + 0.5, [sr.right, lr.right]);
  T.$("#wifiScanResults").hidden = true;
  // picking an open network clears a password typed before: with a password the timer joins
  // only WPA2 networks, so an open one saved with one would never be joined
  T.$("#pwd").value = "leftover";
  T.$("#wifiScanResults").hidden = false;
  T.$$("#wifiScanResults button").find((b) => b.textContent.startsWith("Cafe guest")).click();
  T.check("picking an open network clears the password", T.$("#ssid").value === "Cafe guest" && T.$("#pwd").value === "", T.$("#pwd").value);
  // names and passwords the timer can't use are refused with the reason, before anything is sent
  const tryAdd = async (ssid, pwd) => {
    T.$("#ssid").value = ssid;
    T.$("#pwd").value = pwd;
    T.$("#addWifiButton").click();
    await T.sleep(500);
    return T.text("#addWifiButton");
  };
  const savedNames = async () => (await T.get("/api/wifi/saved")).networks;
  let said = await tryAdd("Short pass", "1234567");
  T.check("a password under 8 characters is refused, says why", said === "Password: 8-63 characters, or none", said);
  said = await tryAdd("Long pass", "x".repeat(64));
  T.check("64 characters only as 64 hex digits", said === "Password: 8-63 characters, or none", said);
  said = await tryAdd("ŠĐČĆŽšđčćžŠĐČĆŽšđ", "12345678");
  T.check("a name over 32 bytes (17 letters like Š) is refused, says why", said === "Network name too long", said);
  T.check("none of them reached the timer", (await savedNames()).length === 3, await savedNames());
  T.check("the timer refuses them too (an older page)",
    (await T.post("/api/wifi/saved/add", { ssid: "Short pass", pwd: "1234567" })).code === 400 &&
    (await T.post("/api/wifi/saved/add", { ssid: "Hex", pwd: "0123456789abcdef".repeat(4) })).code === 200);
  await T.post("/api/wifi/saved/remove", { ssid: "Hex" });
  // a full list (5): saving another forgets the oldest, so the page asks first and names it
  await T.post("/api/wifi/saved/add", { ssid: "Net A", pwd: "" });
  await T.post("/api/wifi/saved/add", { ssid: "Net B", pwd: "" });
  await T.w.loadSavedNetworks();
  const asked = T.dialogs.length;
  T.confirmAnswer = false;
  await tryAdd("Net C", "");
  T.confirmAnswer = true;
  T.check("list full: asks first, naming the network that would be forgotten; Cancel saves nothing",
    T.dialogs.length === asked + 1 && T.dialogs.at(-1).includes('"Field hotspot"') && !(await savedNames()).includes("Net C"), [T.dialogs.at(-1), await savedNames()]);
  T.$("#ssid").value = "";
  T.$("#pwd").value = "";
  await T.post("/api/wifi/saved/remove", { ssid: "Net A" });
  await T.post("/api/wifi/saved/remove", { ssid: "Net B" });
  await T.w.loadSavedNetworks();
  const removeOf = (n) => T.$$("#savedNetworks .saved-row").find((r) => r.querySelector(".saved-name").textContent === n).querySelector("button");
  removeOf("Field hotspot").click();
  await T.until(() => T.$$("#savedNetworks .saved-row").length === 2);
  T.check("Remove asks first, then forgets it", T.dialogs.includes('Forget "Field hotspot"?') &&
    !T.$$("#savedNetworks .saved-name").some((e) => e.textContent === "Field hotspot"));
  await T.mock("offline?on=1");
  const failing = removeOf("Cafe guest");
  failing.click();
  T.check("Remove that fails says so", await T.until(() => failing.textContent === "Failed", 6000), failing.textContent);
  await T.mock("offline?on=0");
  // a restart during a race would lose the race: refused
  await T.post("/timer/start");
  await T.until(() => T.v("isRacing()"), 5000);
  T.$("#restartEspButton").click();
  T.check("Restart during a race: refused, says so", await T.until(() => T.text("#restartEspButton") === "After the race", 4000),
    T.text("#restartEspButton"));
  await T.post("/timer/stop");
  await T.idle();
  T.$("#restartEspButton").click();
  T.check("Restart asks first, then restarts", T.dialogs.includes("Restart the timer?") &&
    (await T.until(() => T.text("#restartEspButton") === "Restarting…", 5000)));
  // Forget all whose restart doesn't get through: said so, not "restarting into the hotspot"
  const fetchBefore = T.w.fetch;
  T.w.fetch = (url, opts) => (String(url).startsWith("/restart") ? Promise.reject(new TypeError("Failed to fetch")) : fetchBefore(url, opts));
  T.$("#forgetWifiButton").click();
  T.check("Forget all, restart not through: the list is cleared, Restart asked for, no hotspot note",
    (await T.until(() => T.text("#forgetWifiButton") === "Cleared: tap Restart timer", 5000)) && !T.shown("#wifiForgotten") &&
    !T.$("#forgetWifiButton").disabled, T.text("#forgetWifiButton"));
  T.w.fetch = fetchBefore;
  await T.post("/api/wifi/saved/add", { ssid: "Home WiFi", pwd: "" });
  T.$("#forgetWifiButton").click();
  T.check("Forget all asks first, then shows how to join the hotspot",
    T.dialogs.some((t) => t.startsWith("Forget all saved WiFi networks")) && (await T.until(() => T.shown("#wifiForgotten"), 5000)) &&
    (await T.get("/api/wifi/saved")).networks.length === 0);

  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Race tab: buttons, countdown, finishing, statistics, table, chart, race screen ──
PAGE_TEST.race = async (T) => {
  await T.mock("lap?s=1.0");
  await T.otherPhone({ raceMode: 0, countdown: false, target: 0, anDelta: true, anTarget: false });
  await T.open();
  await T.tab("race");
  const buttons = () => ["#startRaceButton", "#stopRaceButton", "#clearLapsButton", "#editLapsButton"].map((s) => (T.$(s).disabled ? 0 : 1)).join("");
  T.check("idle: Start, Clear on; Stop, Fix laps off", buttons() === "1010" && T.text("#raceStatus") === "Ready", [buttons(), T.text("#raceStatus")]);
  T.check("battery shown", T.text("#bvolt") === "4.1V");
  await T.mock("vbat?v=37");
  T.check("battery follows the timer", await T.until(() => T.text("#bvolt") === "3.7V", 3000));

  // practice, flying start
  T.spoken.length = 0;
  await T.w.startRace();
  T.check("Start: 'Waiting for the first pass'", T.spoken.includes("Waiting for the first pass"), T.spoken);
  T.check("waiting: Stop on; Start, Clear, scan off", await T.until(() => T.text("#raceStatus") === "Waiting for first gate pass…") &&
    buttons().startsWith("01") && T.$("#clearLapsButton").disabled && T.$("#spectrumButton").disabled, [buttons(), T.text("#raceStatus")]);
  await T.until(() => T.raceShown() && T.laps() >= 6, 15000);
  T.check("racing: status 'Racing'", T.text("#raceStatus") === "Racing");
  await T.mock("passes?on=0"); // no new lap while the numbers are compared
  await T.sleep(600);
  const allLaps = T.v("racePilot(raceData).laps");
  const want = T.expectStats(allLaps);
  const got = Object.fromEntries(Object.keys(want).map((k) => [k, T.stat(k)]));
  T.check("statistics match the laps (worked out independently)", JSON.stringify(got) === JSON.stringify(want), { got, want });
  const lapsOnly = allLaps.slice(1);
  const prevBest = Math.min(...lapsOnly.slice(0, -1));
  const dMs = lapsOnly[lapsOnly.length - 1] - prevBest;
  const dText = Math.abs(dMs) < 5 ? "±0.00" : (dMs < 0 ? "−" : "+") + (Math.abs(dMs) / 1000).toFixed(2);
  T.check("Delta: the last lap against the best before it", T.stat("Delta") === dText, [T.stat("Delta"), dText]);
  const rows = T.$$("#racePilot table tr").slice(1);
  const bestRow = T.$("#racePilot tr.best-lap");
  T.check("lap table: newest first, every lap and the start, best marked",
    rows.length === allLaps.length && rows[0].children[0].textContent === String(lapsOnly.length) &&
    rows[rows.length - 1].children[1].textContent === "Start" && bestRow && bestRow.children[2].textContent === "best",
    rows.length);
  // the chart: tap a lap to read it
  const plot = T.$("#racePilot .lap-chart-plot");
  const L = T.v("racePilot(raceData)") && plot.lapChart.layout;
  const rect = plot.getBoundingClientRect();
  const pickX = (i) => rect.left + (L.x(i) / L.W) * rect.width;
  plot.dispatchEvent(new T.w.PointerEvent("pointerdown", { clientX: pickX(1), clientY: rect.top + 50, bubbles: true }));
  const t1 = lapsOnly[1];
  const best = Math.min(...plot.lapChart.laps);
  T.check("chart: tapping lap 2 reads it", T.text("#racePilot .lap-chart-readout") ===
    `Lap 2 · ${(t1 / 1000).toFixed(2)} s · ${t1 === best ? "best" : "+" + ((t1 - best) / 1000).toFixed(2)}`, T.text("#racePilot .lap-chart-readout"));
  // race screen
  const rs = T.raceScreen();
  const nowLaps = T.v("racePilot(raceData).laps").slice(1);
  T.check("race screen: last lap, lap number, best", rs.last === (nowLaps[nowLaps.length - 1] / 1000).toFixed(2) &&
    rs.lap === "Lap " + nowLaps.length && rs.best === "Best " + (Math.min(...nowLaps) / 1000).toFixed(2), rs);
  T.$("#raceScreenButton").click();
  T.w.updateCurrentLaps(); // what the 50 ms timer does (slowed down in a hidden tab)
  const c1 = T.text(".rs-current");
  await T.sleep(600);
  T.w.updateCurrentLaps();
  const c2 = T.text(".rs-current");
  T.check("race screen: this lap's time runs", c1 !== c2 && c1 !== "--.--", [c1, c2]);
  T.$("#rsClose").click();
  T.check("race screen closes", !T.shown("#raceScreen"));
  await T.mock("passes?on=1");
  T.check("voice 'best time' says the best lap", (() => {
    T.spoken.length = 0;
    T.w.speakBestTime();
    return T.spoken[0] === `Best lap ${(Math.min(...T.v("racePilot(raceData).laps").slice(1)) / 1000).toFixed(2)} seconds`;
  })(), T.spoken);
  T.spoken.length = 0;
  await T.w.clearRace();
  T.check("voice 'clear' during a race: 'The race is still running'", T.spoken.includes("The race is still running"));

  // stop, fix laps button, clear
  T.spoken.length = 0;
  await T.w.stopRace();
  await T.idle();
  T.check("Stop: 'Race stopped', 'Last race', clock shows the total", T.spoken.includes("Race stopped") && T.text("#raceStatus") === "Last race" &&
    T.w.clockText() === T.v("formatClock(pilotTotal(racePilot(raceData)))"));
  T.check("Fix laps on once the race is saved", await T.until(() => !T.$("#editLapsButton").disabled, 4000));
  T.$("#editLapsButton").click();
  await T.until(() => T.$(".history-detail .note"));
  T.check("Fix laps opens the race in History, ready to fix", T.text(".history-detail .note").startsWith("Two short laps from a false pass?") &&
    !!T.button("Done"));
  await T.tab("race");
  T.spoken.length = 0;
  await T.w.clearRace();
  await T.until(() => T.text("#raceStatus") === "Ready");
  T.check("Clear: 'Times cleared', Ready", T.spoken.includes("Times cleared") && T.text("#raceStatus") === "Ready");
  T.spoken.length = 0;
  await T.w.clearRace();
  T.check("Clear with nothing: 'Nothing to clear'", T.spoken.includes("Nothing to clear"));

  // countdown start
  T.toggle("#countdown", true);
  await T.saved();
  T.spoken.length = 0;
  await T.w.startRace();
  T.check("countdown: 'Get ready' and the clock counts 3-2-1", T.spoken.includes("Get ready") &&
    (await T.until(() => ["3", "2", "1"].includes(T.w.clockText()), 3000)) && T.text("#raceStatus") === "Get ready", T.w.clockText());
  await T.until(() => T.raceShown() && T.laps() >= 2, 10000);
  const rowsCd = T.$$("#racePilot table tr");
  T.check("after GO: the start pass row shows its time", rowsCd[rowsCd.length - 1].children[1].textContent.startsWith("Start "), rowsCd[rowsCd.length - 1].textContent);
  await T.w.stopRace();
  await T.idle();
  await T.w.clearRace(); // the stopped race stays on show (its total on the clock) until Clear
  await T.until(() => T.laps() === 0);

  // timed race: time left, time's up, finished on the next pass
  await T.otherPhone({ raceMode: 1, raceSec: 30, countdown: false });
  await T.until(() => T.line().startsWith("Timed race · 0:30"));
  T.check("timed race before the start: the clock shows its time", T.w.clockText() === "00:30.00", T.w.clockText());
  T.spoken.length = 0;
  await T.w.startRace();
  await T.until(() => T.text("#raceStatus") === "Time left", 6000);
  T.check("timed race: 'Time left', the clock counts down", T.w.clockText() < "00:30.00", T.w.clockText());
  T.check("time up: 'Time's up · finish your lap' and spoken", await T.until(() => T.text("#raceStatus") === "Time's up · finish your lap", 34000) &&
    T.spoken.includes("Time's up"), T.text("#raceStatus"));
  T.check("next pass: Finished, 'Race over', saved", await T.until(() => T.text("#raceStatus") === "Finished", 6000) &&
    (await T.until(() => T.spoken.includes("Race over"), 3000)) && (await T.until(() => !T.$("#editLapsButton").disabled, 3000)));

  // lap race: finishes after its laps
  await T.otherPhone({ raceMode: 2, raceLaps: 3 });
  await T.until(() => T.line().startsWith("Lap race · 3 laps"));
  await T.w.startRace();
  T.check("lap race finishes after 3 laps", await T.until(() => T.text("#raceStatus") === "Finished", 15000) &&
    T.v("racePilot(raceData).laps.length") === 4);
  T.check("race screen: 'Finished ✓'", T.raceScreen().lap === "Finished ✓");

  // lap memory full (practice: runs until Stop), last race not saved
  await T.otherPhone({ raceMode: 0 });
  await T.until(() => T.line() === "Practice");
  T.spoken.length = 0;
  await T.w.startRace();
  T.check("practice race running with laps", await T.until(() => T.raceShown() && T.laps() >= 2, 8000), T.laps());
  await T.mock("full");
  T.check("lap memory full: shown and spoken", await T.until(() => T.text("#racePilot .lap-memory-full") === "Lap memory full", 4000) &&
    (await T.until(() => T.spoken.includes("Lap memory full"), 3000)));
  await T.w.stopRace();
  await T.idle();
  await T.mock("saveerr?on=1");
  T.check("a race that could not be saved: said under the clock", await T.until(() => T.text("#raceStatus") === "Last race · last race not saved", 3000),
    [T.text("#raceStatus"), T.v("JSON.stringify({race: raceData.race, state: raceData.state, laps: racePilot(raceData).laps, status: [status.race, status.state, status.laps]})")]);
  await T.mock("saveerr?on=0");
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── A race keeps its own settings (pilot, channel, mode, limits, countdown, target) ──
PAGE_TEST.raceSettings = async (T) => {
  const { line, card } = T;
  const deltaLabel = () => T.$$("#racePilot .stat-label")[2].textContent;
  const raceShown = T.raceShown;
  const laps = T.laps;
  await T.otherPhone({ name: "Maverick", freq: 5800, raceMode: 1, raceSec: 90, raceLaps: 5, countdown: true, target: 4400,
    anTarget: true, anDelta: false, anType: 2 });
  await T.open();
  await T.tab("race");
  const thisPhone = {
    target: (text) => {
      const t = T.$("#targetLap");
      t.value = text;
      t.dispatchEvent(new T.w.Event("change", { bubbles: true }));
    },
    name: (text) => T.setValue("#pilotName", text),
  };

  // 1. before any race: the next race's settings, following every change at once
  T.check("before a race: the next race's settings under the clock", line() === "Timed race · 1:30 · countdown · target 4.40", line());
  T.check("before a race: the pilot from the settings", card() === "Maverick F4 5800", card());
  T.check("before a race: 'vs target' with a target set", deltaLabel() === "vs target", deltaLabel());
  T.check("before a timed race: the clock shows its time", T.w.clockText() === "01:30.00", T.w.clockText());
  thisPhone.target("4.6");
  T.check("before a race: this phone's target change shows at once", line().endsWith("target 4.60"), line());
  await T.saved();
  await T.otherPhone({ target: 4700, name: "Goose" });
  T.check("before a race: another phone's change shows (target, pilot)",
    await T.until(() => line().endsWith("target 4.70") && card().startsWith("Goose")), [line(), card()]);
  await T.otherPhone({ target: 4400, name: "Maverick" });
  await T.until(() => line().endsWith("target 4.40") && card().startsWith("Maverick"));
  const rs0 = T.raceScreen();
  T.check("before a race: race screen shows the next race's target", rs0.extra.Target === "4.40" && rs0.lap === "Not started", rs0);
  const compare = () => T.$$("#lapCompare button.active").map((b) => b.dataset.value);
  T.check("compare with: one choice, Target", compare().join() === "target", compare());
  thisPhone.target("");
  T.check("compare with Target, no target set: the hint warns", T.$("#lapCompareHint").classList.contains("warn"), T.text("#lapCompareHint"));
  thisPhone.target("4.4");
  T.check("target set again: no warning", !T.$("#lapCompareHint").classList.contains("warn"));
  T.$('#lapCompare [data-value="best"]').click();
  await T.saved();
  let cfg = await T.config();
  T.check("this phone picks Best lap: only that one on (page and timer)", compare().join() === "best" && cfg.anDelta === true && cfg.anTarget === false,
    [compare(), cfg.anDelta, cfg.anTarget]);
  T.$('#lapCompare [data-value="target"]').click();
  await T.saved();
  cfg = await T.config();
  T.check("back to Target: only that one on", compare().join() === "target" && cfg.anDelta === false && cfg.anTarget === true, [compare(), cfg.anDelta, cfg.anTarget]);

  // 2. Start: the race takes the timer's settings; what the phone says follows the timer
  await T.otherPhone({ countdown: false }); // another phone, just before this one taps Start
  T.spoken.length = 0;
  await T.idle();
  await T.w.startRace();
  T.check("Start says what the timer started (no countdown)", T.spoken.includes("Waiting for the first pass") && !T.spoken.includes("Get ready"), T.spoken);
  await T.until(() => raceShown() && T.v("status.state") === 3 && laps() >= 1);
  T.check("race running: its settings under the clock", line() === "Timed race · 1:30 · target 4.40", line());

  // 3. during the race every setting changes, on this phone and on another one
  await T.until(() => laps() >= 3, 15000);
  T.$('#raceMode [data-value="2"]').click();
  T.setValue("#raceLaps", "9");
  T.toggle("#countdown", true);
  thisPhone.target("9");
  thisPhone.name("Goose");
  T.setValue("#pilotChannel", "0");
  await T.saved();
  await T.otherPhone({ raceSec: 30, name: "Iceman", freq: 5658, target: 3000 });
  await T.until(() => T.v("pilot.name") === "Iceman");
  await T.sleep(700);
  T.check("race running, settings changed: line keeps the race's", line() === "Timed race · 1:30 · target 4.40", line());
  T.check("race running, settings changed: card keeps the race's pilot", card() === "Maverick F4 5800", card());
  T.check("race running, settings changed: 'vs target' stays", deltaLabel() === "vs target", deltaLabel());
  T.check("race running, settings changed: clock counts down from the race's 1:30", T.w.clockText().startsWith("01:"), T.w.clockText());
  const rs1 = T.raceScreen();
  T.check("race running, settings changed: race screen keeps pilot and target", rs1.name === "Maverick" && rs1.extra.Target === "4.40" && !rs1.lap.includes("/"), rs1);
  const nextLap = async () => {
    T.spoken.length = 0;
    const n = laps();
    await T.until(() => laps() > n, 8000);
    const all = T.v("racePilot(raceData).laps").slice(1);
    return { lapMs: all[all.length - 1], best: Math.min(...all.slice(0, -1)) };
  };
  const lap1 = await nextLap();
  T.check("callout uses the race's pilot and target", T.spoken.some((t) => t.startsWith("Maverick lap")) && T.spoken.includes(T.callout(lap1.lapMs, 4400)),
    { ...lap1, spoken: T.spoken });
  await T.otherPhone({ anType: 1 }); // Announce each lap: Beep
  await T.until(() => T.$("#announcerSelect").value === "beep");
  const beepLap = await nextLap();
  T.check("Beep + Target: the target callout still comes, no lap time", T.spoken.includes(T.callout(beepLap.lapMs, 4400)) &&
    !T.spoken.some((t) => t.includes(" lap ")), { ...beepLap, spoken: T.spoken });
  await T.otherPhone({ anDelta: true }); // another phone: compare with the best lap (the target goes off)
  await T.until(() => T.v("lapCompare") === "best");
  const bestLap = await nextLap();
  const diff = bestLap.lapMs - bestLap.best;
  const deltaWords = (diff < 0 ? "minus " : "plus ") + (Math.abs(diff) / 1000).toFixed(2);
  T.check("Best lap chosen on another phone: delta to the best, no target callout", T.spoken.includes(deltaWords) &&
    !T.spoken.includes(T.callout(bestLap.lapMs, 4400)), { ...bestLap, spoken: T.spoken });
  await T.otherPhone({ anTarget: true, anType: 2 });
  await T.until(() => T.v("lapCompare") === "target" && T.$("#announcerSelect").value === "1lap");

  // 4. Stop: the stopped race stays on show with all its own settings
  await T.w.stopRace();
  await T.idle();
  await T.until(() => raceShown() && laps() > 0);
  await T.sleep(400);
  T.check("after Stop: line shows the race's settings, not the next race's", line() === "Timed race · 1:30 · target 4.40", line());
  T.check("after Stop: card, 'vs target' and status are the race's", card() === "Maverick F4 5800" && deltaLabel() === "vs target" &&
    T.text("#raceStatus") === "Last race", [card(), deltaLabel(), T.text("#raceStatus")]);
  T.check("after Stop: clock shows the race's total", T.w.clockText() === T.v("formatClock(pilotTotal(racePilot(raceData)))"), T.w.clockText());

  // 5. History keeps the race as it was flown
  const list = await T.get("/api/races");
  const newest = await T.get("/api/races?id=" + Math.max(...list.map((r) => r.id)));
  T.check("saved race has the race's pilot, channel, mode, limits, countdown and target", newest.pilots[0].name === "Maverick" &&
    newest.pilots[0].freq === 5800 && newest.mode === 1 && newest.raceMs === 90000 && newest.cd === false && newest.target === 4400, newest);
  await T.tab("history");
  await T.until(() => T.$$(".history-summary").length === list.length);
  const item = T.$$(".history-item")[0]; // newest first
  item.querySelector(".history-summary").click();
  await T.until(() => item.querySelector(".lap-chart svg"));
  T.check("History detail: the race's target in its stats and chart", item.querySelector(".history-pilot .hint").textContent.includes("target 4.40") &&
    item.querySelector(".lap-chart svg").innerHTML.includes("target 4.40"), item.querySelector(".history-pilot .hint").textContent);
  const text = T.w.raceText(newest);
  T.check("share text: the race's settings", text.includes("Timed race · 1:30 · flying start") && text.includes("Target 4.40") &&
    text.includes("Maverick · F4 · 5800 MHz"), text.split("\n").slice(0, 7));
  await T.tab("race");

  // 6. Clear: the next race's settings again (this phone's and the other phone's changes)
  await T.w.clearRace();
  await T.until(() => laps() === 0);
  await T.sleep(400);
  T.check("after Clear: the next race's settings", line() === "Lap race · 9 laps · countdown · target 3.00", line());
  T.check("after Clear: the next race's pilot", card() === "Iceman R1 5658", card());

  // 7. the page reloaded during a race: still the race's settings
  T.spoken.length = 0;
  await T.idle();
  await T.w.startRace();
  T.check("Start with countdown says so", T.spoken.includes("Get ready"), T.spoken);
  await T.until(() => raceShown() && T.v("status.state") === 3 && laps() >= 2, 15000);
  await T.otherPhone({ target: 0, name: "Rooster", freq: 5917, raceMode: 0, countdown: false, raceLaps: 3 });
  await T.open(); // reload
  await T.tab("race");
  await T.until(() => raceShown() && laps() >= 2);
  await T.sleep(400);
  T.check("reloaded mid-race: line is the race's", line() === "Lap race · 9 laps · countdown · target 3.00", line());
  T.check("reloaded mid-race: pilot and 'vs target' are the race's", card() === "Iceman R1 5658" && deltaLabel() === "vs target", [card(), deltaLabel()]);
  const rs2 = T.raceScreen();
  T.check("reloaded mid-race: race screen counts to the race's 9 laps", rs2.lap.endsWith("/9") && rs2.extra.Target === "3.00", rs2);
  await T.w.stopRace();
  await T.idle();
  await T.w.clearRace();
  await T.until(() => laps() === 0);
  await T.sleep(400);
  T.check("after Clear: next race is the new settings (practice, no target)", line() === "Practice" && card() === "Rooster R8 5917" &&
    deltaLabel() === "Delta", [line(), card(), deltaLabel()]);

  // Start while the save of a change is still on its way (sent, no reply yet): the race takes the
  // change, not the old setting (Start went out on a second connection and could arrive first)
  await T.mock("slow?config=1500");
  await T.tab("config");
  T.$('#raceMode [data-value="2"]').click(); // Laps
  await T.sleep(900); // the 600 ms save has gone out
  T.check("(the save is on its way)", T.v("savingNow") === true);
  await T.w.startRace();
  await T.until(() => T.v("isRacing()"), 6000);
  T.check("Start during a save on its way: the race has the new mode", T.v("status.mode") === 2, T.v("status.mode"));
  await T.mock("slow?config=0");
  await T.w.stopRace();
  await T.idle();
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Race tab edge cases: lost replies, double taps, Back, a restart, voice commands ──
PAGE_TEST.raceEdges = async (T) => {
  await T.mock("lap?s=1.5");
  await T.open();
  await T.tab("race");
  const plainFetch = T.w.fetch;
  const failRace = (on) => {
    T.w.fetch = on ? (url, o) => (String(url) === "/api/race" ? Promise.reject(new TypeError("Failed to fetch")) : plainFetch(url, o)) : plainFetch;
  };

  // the race fetch after the last pass fails: it is made again (the card kept the old laps)
  await T.otherPhone({ raceMode: 2, raceLaps: 2, countdown: false });
  await T.until(() => T.v("raceMode") === 2);
  await T.w.startRace();
  await T.until(() => T.v("status.state") === 3, 6000);
  failRace(true);
  await T.until(() => T.v("status.state") === 4, 15000);
  await T.sleep(800);
  failRace(false);
  T.check("a race fetch that failed at the finish is made again: the card shows every lap",
    await T.until(() => T.raceShown() && T.laps() === 3, 3000), [T.v("raceData && raceData.race"), T.v("status.race")]);
  await T.w.clearRace();
  await T.idle();

  // Start while a start is still being sent (the timer busy saving): one start, said once
  await T.otherPhone({ raceMode: 0 });
  await T.until(() => T.v("raceMode") === 0);
  await T.mock("busy?start=3");
  T.spoken.length = 0;
  const first = T.w.startRace();
  await T.sleep(500);
  const offMeanwhile = T.$("#startRaceButton").disabled;
  await T.w.startRace(); // a second tap, or "start", meanwhile
  await first;
  await T.until(() => T.v("isRacing()"), 4000);
  await T.sleep(300);
  const said = T.spoken.filter((t) => t === "Waiting for the first pass" || t === "Get ready" || t.startsWith("The timer is busy"));
  T.check("while a start is being sent, Start stays off and a second Start does nothing", offMeanwhile && said.length === 1,
    [offMeanwhile, said]);

  // laps that arrive together (no connection for a while, the phone asleep): only the newest is said
  await T.otherPhone({ anType: 2, anDelta: false, anTarget: false });
  await T.until(() => T.v("ui.announcer.value") === "1lap");
  await T.until(() => T.laps() >= 2, 8000);
  failRace(true);
  await T.sleep(4000); // two or three laps
  await T.mock("passes?on=0"); // no new lap while the late ones are taken in
  T.spoken.length = 0;
  failRace(false);
  await T.until(() => T.spoken.length > 0, 3000);
  await T.sleep(600);
  await T.mock("passes?on=1");
  const lapCalls = T.spoken.filter((t) => /^(Maverick )?lap \d+/.test(t));
  T.check("laps that arrive together: only the newest is said", lapCalls.length === 1 && lapCalls[0].includes("lap " + (T.laps() - 1)),
    [lapCalls, T.laps()]);
  // a callout not yet spoken when the next lap comes is dropped (short laps, long callouts)
  T.v("audioEnabled = false");
  await T.sleep(250); // the speech loop ends
  const stub = T.w.queueSpeak;
  T.w.queueSpeak = T.realQueueSpeak;
  T.v("audioEnabled = true; speakQueue = []");
  T.v("announceLap({ name: '', laps: [0, 4400, 4300] }, 1, 0); announceLap({ name: '', laps: [0, 4400, 4300] }, 2, 0)");
  const queued = T.v("speakQueue.map((i) => i.text || i)");
  T.check("a newer lap replaces callouts not yet spoken", queued.join() === "lap 2, 4.30,Best lap", queued);
  T.w.queueSpeak = stub;
  T.v("speakQueue = []; audioEnabled = false");
  await T.sleep(250);
  T.v("enableAudioLoop()");

  // the countdown clock never shows a negative number (a status reply late by seconds)
  await T.w.stopRace();
  await T.idle();
  await T.otherPhone({ countdown: true });
  await T.until(() => T.$("#countdown").checked);
  await T.w.startRace();
  await T.until(() => T.v("status.state") === 1, 4000);
  const shownLate = T.v("statusAtMs -= 6000; clockText()");
  T.check("countdown with a late status: 'GO', not a negative number", shownLate === "GO", shownLate);
  await T.w.stopRace();
  await T.idle();

  // Start with a settings change whose save failed (waiting for its retry): the race has it
  await T.tab("config");
  await T.mock("fail?save=1");
  T.toggle("#countdown", false);
  await T.until(() => T.saveState() === "error", 4000);
  await T.w.startRace();
  await T.until(() => T.v("isRacing()"), 6000);
  T.check("Start after a failed save: the race has the change (no countdown)", !T.v("status.cd"), T.v("status.cd"));
  await T.w.stopRace();
  await T.idle();

  // the race screen: the phone's Back button closes it (it left the timer's page)
  await T.tab("race");
  const before = T.w.history.length;
  T.$("#raceScreenButton").click();
  const added = T.w.history.length === before + 1;
  if (added) T.w.history.back();
  else T.$("#rsClose").click();
  T.check("race screen: Back closes it and stays on the page", added && (await T.until(() => !T.shown("#raceScreen"), 2000)) &&
    T.w.location.pathname === "/", [added, T.shown("#raceScreen")]);
  const entries = T.w.history.length;
  T.$("#raceScreenButton").click();
  T.$("#rsClose").click();
  await T.sleep(400);
  T.check("race screen: ✕ closes it, Back then isn't needed twice", !T.shown("#raceScreen") && (!T.w.history.state || !T.w.history.state.raceScreen),
    [T.w.history.length, entries, T.w.history.state]);
  // closed and opened again at once (✕'s step back lands after the new opening)
  T.$("#raceScreenButton").click();
  T.$("#rsClose").click();
  T.$("#raceScreenButton").click();
  await T.sleep(500);
  const stillOpen = T.shown("#raceScreen");
  T.w.history.back();
  T.check("race screen closed and opened again at once: stays open, Back then closes it",
    stillOpen && (await T.until(() => !T.shown("#raceScreen"), 2000)) && T.w.location.pathname === "/", stillOpen);

  // a timed race with no pass ends with nothing saved; Clear then makes way for the next race
  await T.otherPhone({ raceMode: 1, raceSec: 30, countdown: true });
  await T.mock("passes?on=0");
  await T.w.startRace();
  await T.until(() => T.v("status.state") === 4, 40000);
  await T.w.clearRace();
  T.check("a finished race without laps can be cleared", await T.until(() => T.v("status.state") === 0, 3000), T.v("status.state"));
  await T.mock("passes?on=1");

  // the timer restarts during a race: the race is lost, and the page says so
  await T.otherPhone({ raceMode: 0, countdown: false });
  await T.w.startRace();
  await T.until(() => T.v("isRacing()"), 4000);
  T.spoken.length = 0;
  await T.mock("reboot");
  T.check("timer restarted during a race: the page says the race was lost", (await T.until(() => T.shown("#raceLostNote"), 4000)) &&
    T.spoken.some((t) => t.startsWith("The timer restarted")), T.spoken.slice(-3));
  await T.w.startRace();
  T.check("... until the next start", await T.until(() => !T.shown("#raceLostNote"), 3000));
  await T.w.stopRace();
  await T.idle();

  // voice commands: "clear best time" clears (it said the best time)
  const did = [];
  const keep = { speakBestTime: T.w.speakBestTime, clearRace: T.w.clearRace };
  T.w.speakBestTime = () => did.push("best");
  T.w.clearRace = () => did.push("clear");
  for (const words of ["best time", "clear best time", "clear time"]) if (T.w.voiceCommand) T.w.voiceCommand(words);
  Object.assign(T.w, keep);
  T.check("voice commands: 'clear best time' clears, 'best time' says it", did.join() === "best,clear,clear", did);
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Calibrate: live RSSI, Enter/Exit, auto-calibration, channel scan ──
PAGE_TEST.calibrate = async (T) => {
  await T.mock("lap?s=1.5");
  await T.otherPhone({ minLap: 10 }); // 1.0 s: the simulated passes come every 1.5 s
  await T.open();
  await T.tab("calib");
  const seq0 = T.v("rssiSeq");
  await T.sleep(1200);
  T.check("live RSSI: readings arrive, the number shows", T.v("rssiSeq") > seq0 && /^\d+$/.test(T.text("#rssiNow")), T.text("#rssiNow"));
  T.check("calibrated pilot shown", T.text("#calibPilotName") === "Maverick" && T.text("#calibPilotFreq") === "F4 5800");

  // Enter/Exit: exit stays below enter, also at the ends of the sliders
  T.setValue("#enter", "140");
  await T.saved();
  let cfg = await T.config();
  T.check("Enter 140 saved", cfg.enterRssi === 140 && T.text("#enterSpan") === "140");
  T.setValue("#exit", "150");
  await T.saved();
  cfg = await T.config();
  T.check("Exit above Enter: Enter goes up with it", cfg.exitRssi === 150 && cfg.enterRssi === 151 && T.text("#enterSpan") === "151");
  T.setValue("#enter", "50");
  await T.saved();
  cfg = await T.config();
  T.check("Enter at the bottom: 51, Exit 50 (sliders show what is saved)", cfg.enterRssi === 51 && cfg.exitRssi === 50 &&
    T.$("#enter").value === "51" && T.$("#exit").value === "50" && T.text("#exitSpan") === "50", [cfg.enterRssi, cfg.exitRssi]);
  T.setValue("#exit", "255");
  await T.saved();
  cfg = await T.config();
  T.check("Exit at the top: 254, Enter 255 (the page and the timer agree)", cfg.enterRssi === 255 && cfg.exitRssi === 254 &&
    T.$("#exit").value === "254" && T.text("#enterSpan") === "255", [cfg.enterRssi, cfg.exitRssi]);

  // auto-calibration from the simulated passes
  T.toggle("#autoCal", true);
  T.check("auto-calibration starts listening", T.shown("#autoCalResult") && T.text("#autoCalResult").startsWith("Listening"), T.text("#autoCalResult"));
  T.check("after a few passes it suggests Enter and Exit", await T.until(() => !!T.$("#applyAutoCal"), 20000), T.text("#autoCalResult"));
  const suggested = T.text("#autoCalResult").match(/Enter (\d+), Exit (\d+)/);
  T.$("#applyAutoCal").click();
  await T.saved();
  cfg = await T.config();
  T.check("Apply saves the suggestion", suggested && cfg.enterRssi === +suggested[1] && cfg.exitRssi === +suggested[2], [suggested && suggested[0], cfg.enterRssi, cfg.exitRssi]);
  T.toggle("#autoCal", false);
  T.check("auto-calibration off: no result shown", !T.shown("#autoCalResult"));
  // a receiver with a low floor (40 between passes, passes 120): the suggestion stays within
  // the sliders (Exit 50 or more), or Apply sends a value the timer and the slider change
  const low = [];
  for (let i = 0; i < 1200; i++) low.push(i % 200 === 100 ? 120 : 40 + ((i * 7) % 5)); // a pass every 5 s, noise 40-44
  const lowCal = T.v(`analyseAutoCal(${JSON.stringify(low)}, 1000)`);
  T.check("auto-calibration on a low floor: Enter/Exit within the sliders", lowCal.enter >= 51 && lowCal.exit >= 50 && lowCal.exit < lowCal.enter,
    lowCal);
  // short laps (a pass every 2.4 s, minimum lap 2 s, as the mock's passes): suggested wherever
  // the readings end. Every ±1 s window around a reading between passes reached a pass, so only
  // the passes were candidates, all about as high: "0 found" for half of each lap
  const shortLaps = (n) => Array.from({ length: n }, (_, i) => {
    const k = (i % 96) - 48; // readings from the middle of the pass (25 ms each)
    return Math.round(70 + 80 * Math.exp(-(k * k) / 32) + ((i * 7) % 7) - 3);
  });
  const missed = [];
  for (let n = 400; n < 496; n += 4) {
    if (T.v(`analyseAutoCal(${JSON.stringify(shortLaps(n))}, 2000)`).enter === undefined) missed.push(n);
  }
  T.check("auto-calibration with 2.4 s laps: Enter/Exit suggested wherever the readings end", missed.length === 0, missed);
  const quiet = Array.from({ length: 600 }, (_, i) => 70 + ((i * 7) % 7) - 3);
  T.check("... and no passes found in readings without a drone", T.v(`analyseAutoCal(${JSON.stringify(quiet)}, 2000)`).enter === undefined);

  // channel scan
  T.$("#spectrumButton").click();
  T.check("scan: progress, live RSSI paused", await T.until(() => T.text("#spectrumButton").startsWith("Scanning"), 2000) &&
    (await T.until(() => T.shown("#rssiPaused"), 2000)));
  T.check("scan done: 'Scan again', chart with labels and the pilot's channel", await T.until(() => T.text("#spectrumButton") === "Scan again", 15000) &&
    T.shown("#spectrum svg") && T.$$(".spectrum-labels span").length > 5 && T.text(".spectrum-pilots span") === "F4", T.text(".spectrum-pilots"));
  T.check("live RSSI back after the scan", await T.until(() => !T.shown("#rssiPaused"), 3000));
  // another channel picked after the scan (to get away from a busy one): the chart marks it
  await T.otherPhone({ freq: 5740 });
  T.check("the scan chart marks the channel picked after the scan", await T.until(() => T.text(".spectrum-pilots span") === "F1", 4000),
    T.text(".spectrum-pilots"));
  await T.otherPhone({ freq: 5800 });
  await T.until(() => T.text(".spectrum-pilots span") === "F4", 4000);
  // a scan started on another phone pauses this one's live RSSI too
  await T.get("/api/spectrum?start=1");
  T.check("another phone's scan: live RSSI paused, then back", await T.until(() => T.shown("#rssiPaused"), 3000) &&
    (await T.until(() => !T.shown("#rssiPaused"), 10000)));
  // a race started during a scan stops it (once the scan really runs: "Scanning… (about 7 s)"
  // shows before the timer has the request, and a race started first refuses the scan)
  T.$("#spectrumButton").click();
  await T.until(() => /Scanning… \d+%/.test(T.text("#spectrumButton")), 4000);
  await T.post("/timer/start");
  T.check("a race started during a scan stops it", await T.until(() => T.text("#spectrumButton") === "Stopped: a race started", 12000),
    T.text("#spectrumButton"));
  await T.post("/timer/stop");
  await T.until(() => !T.v("isRacing()"));
  // the other order: a race already started when the scan is asked for
  await T.post("/timer/start");
  T.$("#spectrumButton").disabled = false; // as if tapped just before this page heard of the race
  T.$("#spectrumButton").click();
  T.check("a scan asked for just after a race started: 'Not possible during a race'",
    await T.until(() => T.text("#spectrumButton") === "Not possible during a race", 4000), T.text("#spectrumButton"));
  T.check("scan button off during the race", await T.until(() => T.$("#spectrumButton").disabled, 3000));
  await T.post("/timer/stop");
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── History: list, detail, fix laps, rename, CSV, picture, text, delete, deleted races ──
PAGE_TEST.history = async (T) => {
  await T.open();
  await T.tab("history");
  await T.until(() => T.$$(".history-item").length === 6);
  const items = () => T.$$(".history-item");
  const titles = items().map((i) => T.text(i.querySelector(".history-title")));
  T.check("six races, newest first, a named one shows its name and date", items().length === 6 && titles[2] === "Evening session at the field" &&
    !!items()[2].querySelector(".history-sub") && !items()[0].querySelector(".history-sub"), titles);
  const gaps = items().slice(1).map((item, k) => item.getBoundingClientRect().top - items()[k].getBoundingClientRect().bottom);
  T.check("race cards have space between them", gaps.every((g) => g >= 8), gaps);
  T.check("summary: mode and pilot line", T.text(items()[0].querySelector(".history-meta")) === "Lap race" &&
    T.text(items()[0].querySelector(".history-pilots")) === "Maverick · 5 laps · best 3.92", T.text(items()[0].querySelector(".history-pilots")));

  // detail
  const open = async (item) => {
    item.querySelector(".history-summary").click();
    await T.until(() => item.querySelector(".history-detail .button-row"));
  };
  let item = items()[0];
  await open(item);
  const race = await T.get("/api/races?id=6");
  const laps = race.pilots[0].laps;
  T.check("detail: statistics line, chart, every lap", T.text(item.querySelector(".history-pilot .hint")).startsWith("Best 3.92 (lap 5)") &&
    !!item.querySelector(".lap-chart svg") && item.querySelectorAll("table tr").length === laps.length, T.text(item.querySelector(".history-pilot .hint")));
  item.querySelector(".history-summary").click();
  T.check("tapping the summary again closes it", !T.shown(item.querySelector(".history-detail")));
  await open(item);

  // fix laps: merge, split, false start, delete the last
  T.button("Fix laps", item).click();
  const lapsNow = async () => (await T.get("/api/races?id=6")).pilots[0].laps;
  const act = async (row, label) => {
    const before = JSON.stringify(await lapsNow());
    const button = [...[...item.querySelectorAll("table tr")][row + 1].querySelectorAll(".lap-actions button")].find((x) => x.textContent === label);
    button.click();
    await T.sleep(600);
    await T.until(() => !item.querySelector(".history-detail").dataset.busy);
    return { before: JSON.parse(before), after: await lapsNow() };
  };
  let r = await act(4, "Split"); // lap 4 is the double lap (7960)
  T.check("Split halves a lap (missed pass)", r.after.length === r.before.length + 1 && r.after[4] + r.after[5] === r.before[4], r.after);
  r = await act(4, "Merge ↓");
  T.check("Merge joins a lap with the next (false pass)", r.after.length === r.before.length - 1 && r.after[4] === r.before[4] + r.before[5], r.after);
  r = await act(0, "False start");
  T.check("False start joins the start pass with lap 1", r.after.length === r.before.length - 1 && r.after[0] === r.before[0] + r.before[1], r.after);
  const lastRow = (await lapsNow()).length - 1;
  r = await act(lastRow, "Delete");
  T.check("Delete removes a false last pass", r.after.length === r.before.length - 1, r.after);
  const summaryNow = T.text(item.querySelector(".history-pilots"));
  T.check("the summary follows the fixes", summaryNow.startsWith(`Maverick · ${(await lapsNow()).length - 1} laps`), summaryNow);
  // another phone fixed the race meanwhile: refused, the laps as they are now
  const current = await lapsNow();
  await T.post("/api/races/edit", { id: 6, pilot: 0, op: 1, lap: 1, expect: current[1] });
  [...item.querySelectorAll(".lap-actions button")].find((x) => x.textContent === "Merge ↓").click();
  T.check("a fix on laps changed meanwhile: said so, laps reloaded", await T.until(() => (T.text(item.querySelector(".note.warn")) || "").startsWith("The laps changed meanwhile")) &&
    item.querySelectorAll("table tr").length === (await lapsNow()).length + 1);
  // during a race: refused
  await T.post("/timer/start");
  await T.until(() => T.v("isRacing()"));
  [...item.querySelectorAll(".lap-actions button")].find((x) => x.textContent === "Merge ↓").click();
  T.check("a fix during a race: 'Not during a race'", await T.until(() => (T.text(item.querySelector(".note.warn")) || "").startsWith("Not during a race")));
  await T.post("/timer/stop");
  await T.until(() => !T.v("isRacing()"));
  T.button("Done", item).click();

  // rename: Cancel, Escape, Enter, a name a spreadsheet would run as a formula
  T.button("Rename", item).click();
  T.check("Rename opens a field with the date as placeholder", !!item.querySelector(".rename-row input") &&
    item.querySelector(".rename-row input").placeholder === T.v("raceDate")(race));
  T.button("Cancel", item).click();
  T.check("Cancel closes it", !item.querySelector(".rename-row"));
  T.button("Rename", item).click();
  item.querySelector(".rename-row").dispatchEvent(new T.w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  T.check("Escape closes it", !item.querySelector(".rename-row"));
  T.button("Rename", item).click();
  item.querySelector(".rename-row input").value = "=SUM(A1)";
  item.querySelector(".rename-row").requestSubmit();
  await T.until(() => !item.querySelector(".rename-row"));
  T.check("renamed: title and date line", T.text(item.querySelector(".history-title")) === "=SUM(A1)" && !!item.querySelector(".history-sub"));

  // CSV of one race and of all
  T.downloads.length = 0;
  T.button("Export CSV", item).click();
  await T.until(() => T.downloads.length === 1);
  const csv = (await T.downloads[0].blob.text()).replace(/^﻿/, "").split("\r\n");
  const lapsCsv = (await lapsNow()).length - 1;
  T.check("CSV: file name, header, a row per lap", T.downloads[0].name === "laptimer-race-6.csv" &&
    csv[0] === '"race","date","mode","pilot","frequency","lap","time_s","race_name"' && csv.length === lapsCsv + 1, [T.downloads[0].name, csv[0], csv.length]);
  T.check("CSV: a name starting with = is kept as text", csv[1].endsWith(`"'=SUM(A1)"`), csv[1]);
  T.$("#exportAllButton").click();
  await T.until(() => T.downloads.length === 2);
  const all = (await T.downloads[1].blob.text()).split("\r\n");
  const allRaces = await T.get("/api/races");
  let rowsWanted = 0;
  for (const rr of allRaces) for (const p of (await T.get("/api/races?id=" + rr.id)).pilots) rowsWanted += p.laps.length - 1;
  T.check("Export all: every lap of every race", T.downloads[1].name === "laptimer-races.csv" && all.length === rowsWanted + 1, [all.length, rowsWanted + 1]);

  // the race picture and the text
  T.button(T.v("shareMenu") ? "Share image" : "Save image", item).click();
  T.check("race picture: shown full screen", await T.until(() => T.$(".image-preview img") && T.$(".image-preview img").naturalWidth === 1080, 15000));
  T.check("the page behind can't be reached meanwhile", T.$("main").inert === true);
  T.downloads.length = 0;
  T.button("Download", T.$(".image-preview")).click();
  T.check("Download saves laptimer-race-6.png", T.downloads.length === 1 && T.downloads[0].name === "laptimer-race-6.png" &&
    T.downloads[0].blob.type === "image/png");
  T.w.history.back();
  T.check("Back closes the picture", await T.until(() => !T.$(".image-preview"), 3000) && T.$("main").inert === false);
  T.copied.length = 0;
  T.button("Copy as text", item).click();
  T.check("Copy as text: the race as text", T.copied.length === 1 && T.copied[0].startsWith("=SUM(A1)") && T.copied[0].includes("Lap  Time  vs best"),
    T.copied[0] && T.copied[0].split("\n").slice(0, 3));

  // an old race with two pilots shows both
  await T.mock("oldrace");
  await T.w.loadHistory();
  item = items()[0];
  await open(item);
  T.check("an old two-pilot race shows both pilots with a chart each", item.querySelectorAll(".history-pilot").length === 2 &&
    item.querySelectorAll(".lap-chart svg").length === 2);

  // delete all: asks first; refused during a race
  await T.post("/timer/start");
  await T.until(() => T.v("isRacing()"));
  T.$("#clearHistoryButton").click();
  T.check("Delete all during a race: 'After the race'", T.text("#clearHistoryButton") === "After the race");
  await T.post("/timer/stop");
  await T.until(() => !T.v("isRacing()"));
  T.confirmAnswer = false;
  T.$("#clearHistoryButton").click();
  await T.sleep(500);
  T.check("Delete all, then Cancel: nothing deleted", T.dialogs.includes("Delete all saved races?") && (await T.get("/api/races")).length > 0);
  T.confirmAnswer = true;
  T.$("#clearHistoryButton").click();
  T.check("Delete all: list empty, the empty note", await T.until(() => items().length === 0 && T.shown("#historyEmpty")));

  // races deleted on another phone while this page shows them
  const note = () => T.$("#historyNote");
  const goneShown = () => !note().hidden && note().textContent.includes("no longer on the timer");
  const freshList = async () => {
    await T.mock("oldrace");
    await T.w.loadHistory();
    return items()[0];
  };
  const deleteAllElsewhere = () => T.post("/api/races/clear");
  item = await freshList();
  await open(item);
  T.button("Fix laps", item).click();
  await deleteAllElsewhere();
  item.querySelector(".lap-actions button").click();
  T.check("Fix laps on a deleted race: said so, list reloaded", await T.until(() => goneShown() && !T.$(".history-item")), note().textContent);
  item = await freshList();
  T.check("the note goes away when the list loads again", note().hidden);
  await open(item);
  await deleteAllElsewhere();
  T.button("Rename", item).click();
  item.querySelector(".rename-row input").value = "Too late";
  item.querySelector(".rename-row").requestSubmit();
  T.check("Rename of a deleted race: said so, list reloaded", await T.until(() => goneShown() && !T.$(".history-item")), note().textContent);
  item = await freshList();
  await deleteAllElsewhere();
  item.querySelector(".history-summary").click();
  T.check("opening a deleted race: said so, list reloaded", await T.until(() => goneShown() && !T.$(".history-item")), note().textContent);
  await freshList();
  await deleteAllElsewhere();
  T.$("#exportAllButton").click();
  T.check("Export all with deleted races: said so, nothing downloaded", await T.until(() => goneShown() &&
    T.text("#exportAllButton") === "Nothing to export"), [note().textContent, T.text("#exportAllButton")]);
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── History edge cases: no connection, a race saved meanwhile, refused fixes, charts ──
PAGE_TEST.historyEdges = async (T) => {
  await T.mock("lap?s=1.5");
  // History opened while the timer can't be reached: said so (not "No saved races yet")
  await T.open();
  await T.mock("offline?on=1");
  await T.tab("history");
  await T.sleep(1500);
  T.check("History unreachable: says so, not 'No saved races yet'", T.shown("#historyNote") && /connection/i.test(T.text("#historyNote")) &&
    !T.shown("#historyEmpty"), [T.text("#historyNote"), T.shown("#historyEmpty")]);
  await T.mock("offline?on=0");
  T.check("... and the races come once it answers", await T.until(() => T.$$(".history-item").length === 6 && !T.shown("#historyNote"), 8000));

  // a race saved while History is open is listed (an open race stays open)
  const items = () => T.$$(".history-item");
  items()[2].querySelector(".history-summary").click();
  await T.until(() => items()[2].querySelector(".history-detail table"));
  await T.otherPhone({ raceMode: 2, raceLaps: 1, countdown: false });
  await T.post("/timer/start");
  T.check("a race saved while History is open appears at the top", await T.until(() => items().length === 7, 12000), items().length);
  T.check("... and the race that was open stays open", T.shown(items()[3].querySelector(".history-detail")) &&
    !!items()[3].querySelector(".history-detail table"));

  // a fix refused because a race has just started (the page hasn't heard yet): said so
  const item = items()[0];
  item.querySelector(".history-summary").click();
  await T.until(() => item.querySelector(".history-detail .button-row"));
  T.button("Fix laps", item).click();
  await T.until(() => item.querySelector(".lap-actions button"));
  await T.otherPhone({ raceMode: 0 });
  await T.post("/timer/start");
  T.v("status.state = 0"); // this page's last status is from before the start
  item.querySelector(".lap-actions button").click();
  T.check("a fix refused because a race just started: 'Not during a race'", await T.until(() =>
    /Not during a race/.test(T.text(item.querySelector(".history-detail .note.warn")) || ""), 4000),
    T.text(item.querySelector(".history-detail .note.warn")));
  await T.post("/timer/stop");

  // "Fix laps" tapped while the timer can't be reached: not opened in fix mode later by itself
  await T.open();
  await T.mock("offline?on=1");
  T.v("editRaceId = 6; openTab('history')");
  await T.sleep(800);
  await T.tab("race");
  await T.mock("offline?on=0");
  await T.sleep(500);
  await T.tab("history");
  await T.until(() => T.$$(".history-item").length >= 6, 6000);
  await T.sleep(600);
  T.check("Fix laps asked for while unreachable doesn't open fix mode later", !T.$(".history-detail .lap-actions"));

  // a race of only the start pass: says so (an empty table before)
  const box = T.d.createElement("div");
  T.w.renderHistoryDetail(box, { id: 99, mode: 0, pilots: [{ name: "Solo", freq: 5800, laps: [2100] }] }, false);
  T.check("a race with only the start pass: 'No laps'", /No laps/.test(box.textContent) && !box.querySelector("table"), box.textContent);

  // the chart's scale: never below 0 s, a few grid lines also for a huge lap
  const colors = { lap: "#000", best: "#000", band: "#000", target: "#000", grid: "#000", text: "#000", bg: "#fff" };
  const svg = T.w.lapChartSvg([10000, 600000], { width: 320, height: 170 }, colors);
  const labels = [...svg.matchAll(/<text[^>]*text-anchor="end"[^>]*>(-?[\d.]+)<\/text>/g)].map((m) => Number(m[1])); // the time grid
  T.check("chart of a 10 s and a 600 s lap: no negative times, at most 6 grid labels", labels.length >= 2 && labels.length <= 6 &&
    labels.every((v) => v >= 0), labels);
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Connection: unreachable, settings failing to load, a timer restart ──
PAGE_TEST.connection = async (T) => {
  await T.mock("lap?s=1.5");
  // opened while the timer doesn't answer: the WiFi list and the timer info come once it does
  await T.mock("offline?on=1");
  await T.open("/", false);
  await T.sleep(2000);
  await T.mock("offline?on=0");
  T.check("opened unreachable: saved networks and timer info load once it answers",
    await T.until(() => T.$$("#savedNetworks .saved-row").length === 2 && T.text("#infoVersion") === "1.2.0-dev", 10000),
    [T.$$("#savedNetworks .saved-row").length, T.text("#infoVersion")]);
  await T.open();
  await T.tab("race");
  // the timer can't be reached
  await T.mock("offline?on=1");
  T.check("unreachable: 'No connection to the timer', 'Offline' in the top bar", await T.until(() => T.text("#raceStatus") === "No connection to the timer", 9000) &&
    T.text("#bvolt") === "Offline" && T.$("#bvolt").classList.contains("chip-offline"), [T.text("#raceStatus"), T.text("#bvolt")]);
  T.spoken.length = 0;
  const t0 = Date.now();
  await T.w.startRace();
  T.check("Start while unreachable: 'No answer' within seconds, not 'busy'", T.spoken.includes("No answer from the timer") &&
    T.text("#startRaceButton") === "No answer, try again" && Date.now() - t0 < 10000, [T.spoken, Date.now() - t0]);
  await T.tab("config");
  T.toggle("#countdown", true);
  T.check("a setting changed while unreachable: 'Not saved · retrying'", await T.until(() => T.saveState() === "error", 5000));
  await T.mock("offline?on=0");
  await T.tab("race");
  T.check("back: status and battery again", await T.until(() => T.text("#raceStatus") === "Ready" && T.text("#bvolt") === "4.1V", 5000) &&
    !T.$("#bvolt").classList.contains("chip-offline"));
  T.check("back: the setting is saved by itself", await T.until(() => T.saveState() === "saved", 10000) && (await T.config()).countdown === true);
  // offline during a race: the clock keeps running, the status says so, laps come back after
  await T.otherPhone({ countdown: false });
  await T.w.startRace();
  await T.until(() => T.raceShown() && T.laps() >= 2, 8000);
  await T.mock("offline?on=1");
  await T.until(() => T.text("#raceStatus") === "No connection to the timer", 9000);
  const c1 = T.w.clockText();
  await T.sleep(500);
  T.check("unreachable during a race: said so, the race clock keeps running", T.w.clockText() !== c1, [c1, T.w.clockText()]);
  const lapsBefore = T.laps();
  await T.mock("offline?on=0");
  T.check("back during the race: the laps flown meanwhile arrive", await T.until(() => T.laps() > lapsBefore + 1 && T.text("#raceStatus") === "Racing", 8000));
  await T.w.stopRace();
  await T.idle();

  // the settings can't be read at start: retried until they come
  await T.mock("fail?config=2");
  await T.open("/", false);
  T.check("settings not readable at start: 'Can't reach the timer · retrying…'", await T.until(() => T.saveState() === "offline", 4000), T.saveState());
  T.check("then loaded", await T.until(() => T.saveState() === "saved" && T.v("configLoaded"), 12000));

  // the timer restarts (into its hotspot, with other settings)
  await T.mock("info?mode=hotspot");
  await T.mock("reboot");
  await T.otherPhone({ name: "After Restart" });
  T.check("restart noticed: settings read again", await T.until(() => T.$("#pilotName").value === "After Restart", 6000), T.$("#pilotName").value);
  T.check("restart: timer info read again (now its hotspot)", await T.until(() => T.text("#infoMode") === "Own hotspot · LapTimer_BD58 192.168.4.1", 4000) &&
    !T.shown("#wifiLostNote"), T.text("#infoMode"));
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Voice commands: the mic help card in each state ──
PAGE_TEST.voice = async (T) => {
  await T.open();
  T.$("#micIndicator").click();
  T.check("mic icon opens the help card", T.shown("#micHelp"));
  T.check("voice commands off: says where to switch them on", T.text("#micHelpText") === "Voice commands are off on this phone. Switch them on in Setup → This phone.",
    T.text("#micHelpText"));
  const state = (expr) => {
    T.v(expr);
    T.w.renderMicHelp();
    return T.text("#micHelpText");
  };
  T.v("voiceCommandsOn = true");
  T.check("listening: the commands", state('micState = "listening"; micError = null').startsWith("Listening. Say start (or go), stop, best time or clear time"));
  T.check("microphone refused on http: the Chrome flag steps with Copy buttons", state('micState = "error"; micError = "not-allowed"').includes("chrome://flags/#unsafely-treat-insecure-origin-as-secure") &&
    T.$$("#micHelpText [data-copy]").length === 2 && T.text("#micHelpText").includes("Share image"));
  T.check("busy", state('micError = "busy"').startsWith("Speech recognition is busy"));
  T.check("no internet", state('micError = "network"').startsWith("No connection to the speech service"));
  T.check("no microphone", state('micError = "audio-capture"').startsWith("The microphone couldn't be opened"));
  T.check("another error", state('micError = "weird"') === "Speech recognition failed (weird). Tried again every 30 s.");
  T.check("starting", state('micState = ""; micError = null').startsWith("Starting voice recognition"));
  T.$("#micHelpClose").click();
  T.check("Close hides it", !T.shown("#micHelp"));
  T.check("no script errors", T.errors.length === 0, T.errors);
};

// ── Firmware update page ──
PAGE_TEST.update = async (T) => {
  const w = await T.open("/update.html");
  await T.until(() => T.text("#version") !== "–", 4000);
  T.check("update page: firmware version, Upload off until a file is chosen", T.text("#version") === "1.2.0-dev" && T.$("#upload").disabled);
  const choose = (name) => {
    const dt = new w.DataTransfer();
    dt.items.add(new w.File([new Uint8Array(4096)], name));
    T.$("#file").files = dt.files;
    T.$("#file").dispatchEvent(new w.Event("change", { bubbles: true }));
  };
  const asked = [];
  const realFetch = w.fetch.bind(w);
  w.fetch = (url, opts) => {
    asked.push(String(url));
    return realFetch(url, opts);
  };
  choose("laptimer-v1.2.0-littlefs.bin");
  T.check("a file chosen: Upload on", !T.$("#upload").disabled);
  T.confirmAnswer = false;
  T.$("#upload").click();
  T.check("web files are named so in the question; Cancel uploads nothing", T.dialogs.some((d) => d.startsWith("Upload laptimer-v1.2.0-littlefs.bin as web pages?")) &&
    !asked.some((u) => u.includes("/ota/start")));
  T.confirmAnswer = true;
  choose("laptimer-v1.2.0-firmware.bin");
  T.$("#upload").click();
  T.check("firmware: asked as firmware, mode fr", T.dialogs.some((d) => d.startsWith("Upload laptimer-v1.2.0-firmware.bin as firmware?")) &&
    (await T.until(() => asked.some((u) => u.includes("/ota/start?mode=fr")), 3000)), asked);
  T.check("uploaded: 'Update installed', waiting for the restart", await T.until(() => T.text("#result").startsWith("Update installed"), 5000), T.text("#result"));
  T.check("back on the timer's page once it answers", await T.until(() => T.frame().contentWindow.location.pathname === "/", 10000));
  await T.open("/update.html");
  await T.mock("offline?on=1");
  const w2 = T.w;
  const dt = new w2.DataTransfer();
  dt.items.add(new w2.File([new Uint8Array(16)], "laptimer-v1.2.0-firmware.bin"));
  T.$("#file").files = dt.files;
  T.$("#file").dispatchEvent(new w2.Event("change", { bubbles: true }));
  T.$("#upload").click();
  T.check("the timer refuses or can't be reached: said so, Upload on again", await T.until(() => T.text("#result") === "The timer did not accept the update.", 5000) &&
    !T.$("#upload").disabled, T.text("#result"));
  await T.mock("offline?on=0");
  // during a race: refused before anything is sent (the flash write and the restart lose the race)
  await T.post("/timer/start");
  await T.open("/update.html");
  const w3 = T.w;
  const sent = [];
  const fetch3 = w3.fetch.bind(w3);
  w3.fetch = (url, opts) => {
    sent.push(String(url));
    return fetch3(url, opts);
  };
  const dt3 = new w3.DataTransfer();
  dt3.items.add(new w3.File([new Uint8Array(16)], "laptimer-v1.2.0-firmware.bin"));
  T.$("#file").files = dt3.files;
  T.$("#file").dispatchEvent(new w3.Event("change", { bubbles: true }));
  T.$("#upload").click();
  T.check("update during a race: refused, nothing sent", await T.until(() => T.text("#result") === "A race is running: stop it first, then update.", 4000) &&
    !sent.some((u) => u.includes("/ota/")) && !T.$("#upload").disabled, [T.text("#result"), sent]);
  await T.post("/timer/stop");
  // no connection at all (not a refusal): said so
  w3.fetch = () => Promise.reject(new TypeError("Failed to fetch"));
  T.$("#upload").click();
  T.check("update with no connection: says so (not 'did not accept')",
    await T.until(() => T.text("#result") === "No connection to the timer. Check the WiFi and try again.", 4000), T.text("#result"));
  T.check("no script errors", T.errors.length === 0, T.errors);
};
