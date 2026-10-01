// Page test: a race keeps its own settings. What the Race tab, race screen, clock, callouts,
// History and the share text show for a race comes from that race (as the timer took it at
// the start), never from settings changed later on this phone or another one; only with no
// race shown (before the first race, after Clear) the page shows the next race's settings.
//
// Run against the mock:
//   1. python tools/mock_server.py
//   2. open http://127.0.0.1:8765/mock/log in Chrome, keep the tab in front (background tabs
//      run timers once a second), and in the console paste this file, or load it:
//        document.head.append(Object.assign(document.createElement("script"), { src: "/mock/page_race_test.js" }))
//   3. await pageRaceTest()   → {passed, failed}, each check also logged (about a minute)
// The page runs in a 390 px iframe, so it can be reloaded mid-race while the test goes on.

async function pageRaceTest() {
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, ok: !!ok, detail });
    console.log((ok ? "PASS " : "FAIL ") + name, detail === undefined ? "" : detail);
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (cond, ms = 10000) => {
    for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
      try {
        if (cond()) return true;
      } catch (e) {
        // not there yet
      }
    }
    return false;
  };
  const post = (url, body) =>
    fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) }).then((r) => r.json());
  const get = (url) => fetch(url).then((r) => r.json());
  const otherPhone = (settings) => post("/config", settings); // a second phone saving settings

  // the page in a phone-sized frame
  document.documentElement.innerHTML = '<body style="margin:0;background:#888"><iframe id="pt" style="width:390px;height:844px;border:0"></iframe></body>';
  const frame = document.getElementById("pt");
  const errors = [];
  const spoken = [];
  let w, d;
  const v = (expr) => w.eval(expr); // the page's own variables (let/const aren't on window)
  const open = async () => {
    await new Promise((r) => {
      frame.onload = r;
      frame.src = "/?t=" + Date.now();
    });
    w = frame.contentWindow;
    d = w.document;
    w.addEventListener("error", (e) => errors.push(e.message));
    w.addEventListener("unhandledrejection", (e) => errors.push("rejection: " + (e.reason && e.reason.message)));
    w.queueSpeak = (text) => spoken.push(text); // what the phone would say
    await until(() => v("configLoaded") && v("status") !== null);
    w.openTab("race");
    await until(() => v("raceData") !== null);
  };
  const line = () => d.getElementById("raceInfo").textContent;
  const card = () => d.querySelector("#racePilot .race-pilot-head").innerText.replace(/\s+/g, " ").trim();
  const deltaLabel = () => d.querySelectorAll("#racePilot .stat-label")[2].textContent;
  const raceShown = () => v("raceData && status && raceData.race === status.race");
  const laps = () => v("racePilot(raceData).laps.length");
  const raceScreen = () => {
    d.getElementById("raceScreenButton").click();
    const extra = {};
    for (const item of d.querySelectorAll(".rs-extra > div")) extra[item.querySelector("span").textContent] = item.querySelector("b").textContent;
    const out = { name: d.querySelector(".rs-name span").textContent, lap: d.querySelector(".rs-lapno").textContent, extra };
    d.getElementById("rsClose").click();
    return out;
  };
  const thisPhone = {
    target: (text) => {
      const t = d.getElementById("targetLap");
      t.value = text;
      t.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    mode: (m) => d.querySelector(`#raceMode [data-value="${m}"]`).click(),
    range: (id, value) => {
      const r = d.getElementById(id);
      r.value = value;
      r.dispatchEvent(new w.Event("input", { bubbles: true }));
      r.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    toggle: (id, on) => {
      const c = d.getElementById(id);
      if (c.checked !== on) c.click();
    },
    name: (text) => {
      const n = d.getElementById("pilotName");
      n.value = text;
      n.dispatchEvent(new w.Event("input", { bubbles: true }));
      n.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    channel: (index) => {
      const c = d.getElementById("pilotChannel");
      c.value = String(index);
      c.dispatchEvent(new w.Event("change", { bubbles: true }));
    },
    saved: () => until(() => v("saveTimer === null && !savingNow") && d.querySelector("[data-save-state]").dataset.saveState === "saved"),
  };
  const idle = () => until(() => v("status.state") === 0 && !d.getElementById("startRaceButton").disabled);
  const callout = (lapMs, target) => {
    const diff = lapMs - target;
    return Math.abs(diff) <= 50 ? "On target" : (diff > 0 ? "plus " : "minus ") + (Math.abs(diff) / 1000).toFixed(2);
  };

  // a fresh timer: no race yet; the settings a phone saved
  await fetch("/mock/reboot");
  await fetch("/mock/passes?on=1");
  await otherPhone({ name: "Maverick", freq: 5800, raceMode: 1, raceSec: 90, raceLaps: 5, countdown: true, target: 4400,
    anTarget: true, anDelta: false, anType: 2 });
  await open();

  // 1. Before any race: the next race's settings, following every change at once
  check("before a race: the next race's settings under the clock", line() === "Timed race · 1:30 · countdown · target 4.40", line());
  check("before a race: the pilot from the settings", card() === "Maverick F4 5800", card());
  check("before a race: 'vs target' with a target set", deltaLabel() === "vs target", deltaLabel());
  check("before a timed race: the clock shows its time", w.clockText() === "01:30.00", w.clockText());
  thisPhone.target("4.6");
  check("before a race: this phone's target change shows at once", line().endsWith("target 4.60"), line());
  await thisPhone.saved();
  await otherPhone({ target: 4700, name: "Goose" });
  check("before a race: another phone's change shows (target, pilot)",
    await until(() => line().endsWith("target 4.70") && card().startsWith("Goose")), [line(), card()]);
  await otherPhone({ target: 4400, name: "Maverick" });
  await until(() => line().endsWith("target 4.40") && card().startsWith("Maverick"));
  const rs0 = raceScreen();
  check("before a race: race screen shows the next race's target", rs0.extra.Target === "4.40" && rs0.lap === "Not started", rs0);
  const compare = () => [...d.querySelectorAll("#lapCompare button.active")].map((b) => b.dataset.value);
  check("compare with: one choice, Target", compare().join() === "target", compare());
  thisPhone.target("");
  check("compare with Target, no target set: the hint warns", d.getElementById("lapCompareHint").classList.contains("warn"),
    d.getElementById("lapCompareHint").textContent);
  thisPhone.target("4.4");
  check("target set again: no warning", !d.getElementById("lapCompareHint").classList.contains("warn"));
  d.querySelector('#lapCompare [data-value="best"]').click();
  await thisPhone.saved();
  let cfg = await get("/config");
  check("this phone picks Best lap: only that one on (page and timer)",
    compare().join() === "best" && cfg.anDelta === true && cfg.anTarget === false, [compare(), cfg.anDelta, cfg.anTarget]);
  d.querySelector('#lapCompare [data-value="target"]').click();
  await thisPhone.saved();
  cfg = await get("/config");
  check("back to Target: only that one on", compare().join() === "target" && cfg.anDelta === false && cfg.anTarget === true,
    [compare(), cfg.anDelta, cfg.anTarget]);

  // 2. Start: the race takes the settings the timer has; what the phone says follows the timer
  await otherPhone({ countdown: false }); // another phone, just before this one taps Start
  spoken.length = 0;
  await idle();
  await w.startRace();
  check("Start says what the timer started (no countdown)", spoken.includes("Waiting for the first pass") && !spoken.includes("Get ready"), spoken);
  await until(() => raceShown() && v("status.state") === 3 && laps() >= 1);
  check("race running: its settings under the clock", line() === "Timed race · 1:30 · target 4.40", line());

  // 3. During the race every setting changes, on this phone and on another one
  await until(() => laps() >= 3, 15000);
  thisPhone.mode(2);
  thisPhone.range("raceLaps", 9);
  thisPhone.toggle("countdown", true);
  thisPhone.target("9");
  thisPhone.name("Goose");
  thisPhone.channel(0);
  await thisPhone.saved();
  await otherPhone({ raceSec: 30, name: "Iceman", freq: 5658, target: 3000 });
  await until(() => v("pilot.name") === "Iceman");
  await sleep(700); // a few status polls
  check("race running, settings changed: line keeps the race's", line() === "Timed race · 1:30 · target 4.40", line());
  check("race running, settings changed: card keeps the race's pilot", card() === "Maverick F4 5800", card());
  check("race running, settings changed: 'vs target' stays", deltaLabel() === "vs target", deltaLabel());
  check("race running, settings changed: clock counts down from the race's 1:30", w.clockText().startsWith("01:"), w.clockText());
  const rs1 = raceScreen();
  check("race running, settings changed: race screen keeps pilot and target",
    rs1.name === "Maverick" && rs1.extra.Target === "4.40" && !rs1.lap.includes("/"), rs1);
  spoken.length = 0;
  const before = laps();
  await until(() => laps() > before, 8000);
  const lapMs = v("racePilot(raceData).laps[racePilot(raceData).laps.length - 1]");
  check("callout uses the race's pilot and target", spoken.some((t) => t.startsWith("Maverick lap")) && spoken.includes(callout(lapMs, 4400)),
    { lapMs, spoken });
  const nextLap = async () => {
    spoken.length = 0;
    const n = laps();
    await until(() => laps() > n, 8000);
    const all = v("racePilot(raceData).laps").slice(1);
    return { lapMs: all[all.length - 1], best: Math.min(...all.slice(0, -1)) };
  };
  await otherPhone({ anType: 1 }); // Announce each lap: Beep
  await until(() => d.getElementById("announcerSelect").value === "beep");
  const beepLap = await nextLap();
  check("Beep + Target: the target callout still comes, no lap time",
    spoken.includes(callout(beepLap.lapMs, 4400)) && !spoken.some((t) => t.includes(" lap ")), { ...beepLap, spoken });
  await otherPhone({ anDelta: true }); // another phone: compare with the best lap (the target goes off)
  await until(() => v("lapCompare") === "best");
  const bestLap = await nextLap();
  const diff = bestLap.lapMs - bestLap.best;
  const deltaWords = (diff < 0 ? "minus " : "plus ") + (Math.abs(diff) / 1000).toFixed(2);
  check("Best lap chosen on another phone: delta to the best, no target callout",
    spoken.includes(deltaWords) && !spoken.includes(callout(bestLap.lapMs, 4400)), { ...bestLap, spoken });
  await otherPhone({ anTarget: true, anType: 2 });
  await until(() => v("lapCompare") === "target" && d.getElementById("announcerSelect").value === "1lap");

  // 4. Stop: the stopped race stays on show with all its own settings
  await w.stopRace();
  await idle();
  await until(() => raceShown() && laps() > 0);
  await sleep(400);
  check("after Stop: line shows the race's settings, not the next race's", line() === "Timed race · 1:30 · target 4.40", line());
  check("after Stop: card, 'vs target' and status are the race's",
    card() === "Maverick F4 5800" && deltaLabel() === "vs target" && d.getElementById("raceStatus").textContent === "Last race",
    [card(), deltaLabel(), d.getElementById("raceStatus").textContent]);
  check("after Stop: clock shows the race's total", w.clockText() === v("formatClock(pilotTotal(racePilot(raceData)))"), w.clockText());

  // 5. History keeps the race as it was flown
  const list = await get("/api/races");
  const newest = await get("/api/races?id=" + Math.max(...list.map((r) => r.id)));
  check("saved race has the race's pilot, channel, mode, limits, countdown and target",
    newest.pilots[0].name === "Maverick" && newest.pilots[0].freq === 5800 && newest.mode === 1 && newest.raceMs === 90000 &&
    newest.cd === false && newest.target === 4400, newest);
  w.openTab("history");
  await until(() => d.querySelectorAll(".history-summary").length === list.length);
  const item = d.querySelectorAll(".history-item")[0]; // newest first
  item.querySelector(".history-summary").click();
  await until(() => item.querySelector(".lap-chart svg"));
  check("History detail: the race's target in its stats and chart",
    item.querySelector(".history-pilot .hint").textContent.includes("target 4.40") && item.querySelector(".lap-chart svg").innerHTML.includes("target 4.40"),
    item.querySelector(".history-pilot .hint").textContent);
  const text = w.raceText(newest);
  check("share text: the race's settings", text.includes("Timed race · 1:30 · flying start") && text.includes("Target 4.40") &&
    text.includes("Maverick · F4 · 5800 MHz"), text.split("\n").slice(0, 7));
  w.openTab("race");

  // 6. Clear: the next race's settings again (this phone's and the other phone's changes)
  await w.clearRace();
  await until(() => laps() === 0);
  await sleep(400);
  check("after Clear: the next race's settings", line() === "Lap race · 9 laps · countdown · target 3.00", line());
  check("after Clear: the next race's pilot", card() === "Iceman R1 5658", card());

  // 7. The page reloaded during a race: still the race's settings
  spoken.length = 0;
  await idle();
  await w.startRace();
  check("Start with countdown says so", spoken.includes("Get ready"), spoken);
  await until(() => raceShown() && v("status.state") === 3 && laps() >= 2, 15000);
  await otherPhone({ target: 0, name: "Rooster", freq: 5917, raceMode: 0, countdown: false, raceLaps: 3 });
  await open(); // reload
  await until(() => raceShown() && laps() >= 2);
  await sleep(400);
  check("reloaded mid-race: line is the race's", line() === "Lap race · 9 laps · countdown · target 3.00", line());
  check("reloaded mid-race: pilot and 'vs target' are the race's", card() === "Iceman R1 5658" && deltaLabel() === "vs target", [card(), deltaLabel()]);
  const rs2 = raceScreen();
  check("reloaded mid-race: race screen counts to the race's 9 laps", rs2.lap.endsWith("/9") && rs2.extra.Target === "3.00", rs2);
  await w.stopRace();
  await idle();
  await w.clearRace();
  await until(() => laps() === 0);
  await sleep(400);
  check("after Clear: next race is the new settings (practice, no target)",
    line() === "Practice" && card() === "Rooster R8 5917" && deltaLabel() === "Delta", [line(), card(), deltaLabel()]);

  // 8. Races deleted on another phone while this page still shows them: each action says so
  //    and shows the list as the timer has it now
  const note = () => d.getElementById("historyNote");
  const goneShown = () => !note().hidden && note().textContent.includes("no longer on the timer");
  const freshList = async () => {
    await fetch("/mock/oldrace"); // a saved race to work on
    w.openTab("history");
    await w.loadHistory();
    return d.querySelectorAll(".history-item")[0];
  };
  const deleteAllElsewhere = () => post("/api/races/clear"); // another phone: History → Delete all
  let item8 = await freshList();
  item8.querySelector(".history-summary").click();
  await until(() => item8.querySelector(".history-detail .button-row"));
  [...item8.querySelectorAll("button")].find((b) => b.textContent === "Fix laps").click();
  await deleteAllElsewhere();
  item8.querySelector(".lap-actions button").click();
  check("Fix laps on a deleted race: said so, list reloaded", await until(() => goneShown() && !d.querySelector(".history-item")),
    note().textContent);
  item8 = await freshList();
  check("the note goes away when the list loads again", note().hidden);
  item8.querySelector(".history-summary").click();
  await until(() => item8.querySelector(".history-detail .button-row"));
  await deleteAllElsewhere();
  [...item8.querySelectorAll("button")].find((b) => b.textContent === "Rename").click();
  item8.querySelector(".rename-row input").value = "Too late";
  item8.querySelector(".rename-row").requestSubmit();
  check("Rename of a deleted race: said so, list reloaded", await until(() => goneShown() && !d.querySelector(".history-item")),
    note().textContent);
  item8 = await freshList();
  await deleteAllElsewhere();
  item8.querySelector(".history-summary").click();
  check("opening a deleted race: said so, list reloaded", await until(() => goneShown() && !d.querySelector(".history-item")),
    note().textContent);
  await freshList();
  await deleteAllElsewhere();
  d.getElementById("exportAllButton").click();
  check("Export all with deleted races: said so, nothing downloaded",
    await until(() => goneShown() && d.getElementById("exportAllButton").textContent === "Nothing to export"),
    [note().textContent, d.getElementById("exportAllButton").textContent]);

  check("no script errors", errors.length === 0, errors);
  const failed = results.filter((r) => !r.ok);
  return { passed: results.length - failed.length, failed: failed.map((r) => ({ name: r.name, detail: r.detail })) };
}
