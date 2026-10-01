// Takes the README's screenshots (docs/images) from the mock in a headless Chrome: a phone
// (390 px at 1.25x), dark theme, the same framing every time. Run it after a UI change.
//
//   python tools/mock_server.py                (in another window)
//   node tools/readme_images.js [folder]       default docs/images
//
// It resets the mock first and flies a short practice there (about a minute in all). Needs
// Node 22+ (WebSocket) and Chrome or Edge (or the CHROME environment variable).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MOCK = "http://127.0.0.1:8765";
const OUT = path.resolve(process.argv[2] || path.join(__dirname, "..", "docs", "images"));
const WIDTH = 390; // css px, a phone
const HEIGHT = 780;
const SCALE = 1.25; // 488 px wide files, shown 240 px wide in the README
const BROWSERS = [
  process.env.CHROME,
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mock = (p) => fetch(MOCK + "/mock/" + p).then((r) => r.json());
const post = (p, body) =>
  fetch(MOCK + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

async function main() {
  try {
    await fetch(MOCK + "/api/info");
  } catch (e) {
    console.error(`The mock isn't running: start python tools/mock_server.py first (${MOCK}).`);
    return 2;
  }
  const browser = BROWSERS.find((b) => b && fs.existsSync(b));
  if (!browser) {
    console.error("No Chrome or Edge found: set CHROME to its path.");
    return 2;
  }
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "laptimer-readme-images-"));
  const chrome = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--hide-scrollbars", "about:blank"], { stdio: "ignore" });
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const port = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").split("\n")[0].trim();
        target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === "page");
      } catch (e) {
        // still starting
      }
      if (!target) await sleep(200);
    }
    if (!target) throw new Error("the browser didn't start");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });
    let nextId = 0;
    const pending = new Map();
    const listeners = new Map();
    ws.onmessage = (message) => {
      const msg = JSON.parse(message.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method && listeners.has(msg.method)) {
        listeners.get(msg.method)(msg.params);
      }
    };
    const send = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        ws.send(JSON.stringify({ id, method, params }));
      });
    const ev = async (expression) => {
      const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(`${expression.slice(0, 80)}: ${r.exceptionDetails.exception.description}`);
      return r.result.value;
    };
    const until = async (expression, ms = 15000) => {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
        if (await ev(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`)) return;
      }
      throw new Error("timed out waiting for " + expression);
    };
    const viewport = (height = HEIGHT) =>
      send("Emulation.setDeviceMetricsOverride", { width: WIDTH, height, deviceScaleFactor: SCALE, mobile: true });
    // the page as it is on screen (height: a shorter picture, e.g. one card)
    const shot = async (name, height = HEIGHT) => {
      if (height !== HEIGHT) await viewport(height);
      await sleep(500); // transitions, the chart's resize
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
      if (height !== HEIGHT) await viewport();
      console.log("  " + name);
    };
    const open = async (url) => {
      const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", resolve));
      await send("Page.navigate", { url });
      await loaded;
    };
    // A part of the page, from the top of one element to the bottom of another (12 px around):
    // the screen is made that tall and scrolled to it, the tab bar not pinned to the top
    const region = async (name, top, bottom) => {
      const box = await ev(`(() => {
        document.head.insertAdjacentHTML("beforeend", '<style id="shotStyle">.tabs { position: static !important; }</style>');
        document.body.style.paddingBottom = "${HEIGHT}px"; // room to scroll the last card up
        const t = document.querySelector(${JSON.stringify(top)}).getBoundingClientRect().top + scrollY - 12;
        const b = document.querySelector(${JSON.stringify(bottom)}).getBoundingClientRect().bottom + scrollY + 12;
        return [t, Math.ceil(b - t)];
      })()`);
      await viewport(box[1]);
      await ev(`window.scrollTo(0, ${box[0]})`);
      await sleep(500);
      const { data } = await send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(OUT, name), Buffer.from(data, "base64"));
      await viewport();
      await ev(`document.getElementById("shotStyle").remove(); document.body.style.paddingBottom = ""`);
      console.log(`  ${name} (${box[1]} px tall)`);
    };
    // an element just below the tab bar (it sticks to the top of the screen when scrolled)
    const scrollTo = (selector, gap = 12) =>
      ev(`window.scrollTo(0, document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect().top + scrollY
        - document.querySelector(".tabs").offsetHeight - 2 * ${gap})`);

    await send("Page.enable");
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    await viewport();

    // the timer: Maverick on F4 with a pace target, two more saved pilots, sample races
    await mock("reset");
    await mock("lap?s=4.4");
    await post("/config", { target: 4400, countdown: false, raceMode: 0, anType: 2, anDelta: false, anTarget: true });
    await post("/api/profiles/save", { name: "Maverick", freq: 5800, enter: 120, exit: 100, target: 4400 });
    await open(MOCK + "/");
    await ev(`localStorage.setItem("voiceCommands", "0"); localStorage.setItem("voiceOn", "1")`);
    await open(MOCK + "/");
    await until("configLoaded && status && profiles.length === 3");
    await ev(`setMicState("listening")`); // as on a phone with voice commands working

    console.log(`Screenshots in ${OUT}:`);
    await ev(`openTab("config"); window.scrollTo(0, 0)`);
    await shot("setup.png");

    // a practice with the target, a few laps in
    await ev(`openTab("race"); startRace()`);
    await until(`raceData && status && raceData.race === status.race && racePilot(raceData).laps.length >= 7`, 60000);
    await ev(`setMicState("listening")`);
    await ev(`window.scrollTo(0, 0)`);
    await shot("race.png");
    await ev(`window.scrollTo(0, 0); document.getElementById("raceScreenButton").click()`);
    await sleep(1200); // "This lap" running
    await shot("race-screen.png");
    await ev(`closeRaceScreen(false); stopRace()`);
    await until(`status.state === STATE.IDLE`);

    // calibration: passes every 2.4 s (minimum lap 2 s), auto-calibration listening
    await mock("lap?s=2.4");
    await post("/config", { minLap: 20 });
    await until(`+ui.minLap.value === 2`);
    await ev(`openTab("calib"); window.scrollTo(0, 0)`);
    await ev(`document.getElementById("autoCal").click()`);
    await until(`document.getElementById("applyAutoCal")`, 30000);
    await region("calibrate.png", "#calib .card", "#applyAutoCal"); // the graph to the suggestion
    await ev(`document.getElementById("spectrumButton").click()`);
    await until(`document.getElementById("spectrumButton").textContent === "Scan again"`, 20000);
    await sleep(1500); // the chart eases to its values
    await ev(`document.getElementById("spectrum").closest(".card").id = "scanCard"`);
    await region("channel-scan.png", "#scanCard", "#scanCard");

    // History: a race with a crash lap (kept off the chart's scale) and a target, fixing laps
    await ev(`openTab("history"); window.scrollTo(0, 0)`);
    await until(`document.querySelectorAll(".history-item").length >= 6`); // and the practice flown above
    const openRace = async (title, fix) => {
      await ev(`(() => { const item = [...document.querySelectorAll(".history-item")].find((i) => i.textContent.includes(${JSON.stringify(title)}));
        item.querySelector(".history-summary").click(); item.id = "shotItem"; })()`);
      await until(`document.querySelector("#shotItem .history-detail .button-row")`);
      if (fix) {
        await ev(`[...document.querySelectorAll("#shotItem button")].find((b) => b.textContent === "Fix laps").click()`);
        await until(`document.querySelector("#shotItem .lap-actions button")`);
      }
      await sleep(400);
      await scrollTo("#shotItem");
    };
    await openRace("Timed race");
    await shot("history.png");
    await ev(`document.querySelector("#shotItem .history-summary").click(); document.getElementById("shotItem").id = ""`);
    await openRace("Lap race", true);
    await shot("fix-laps.png");

    // the race picture History shares (1080 px) of the 45-lap practice, saved at half size
    {
      const name = "race-image.png";
      const url = await ev(`(async () => {
        const id = (await fetchJson("/api/races")).find((r) => r.name === "Evening session at the field").id;
        const race = await fetchJson("/api/races?id=" + id);
        const { blob } = await raceImage(race);
        const img = await createImageBitmap(blob);
        const c = document.createElement("canvas");
        c.width = Math.round(img.width / 2);
        c.height = Math.round(img.height / 2);
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, c.width, c.height);
        return c.toDataURL("image/png");
      })()`);
      fs.writeFileSync(path.join(OUT, name), Buffer.from(url.split(",")[1], "base64"));
      console.log("  " + name);
    }

    // the firmware update page
    await open(MOCK + "/update.html");
    await sleep(800);
    // the firmware's version, not the mock's "-dev"
    const version = fs.readFileSync(path.join(__dirname, "..", "lib", "WEBSERVER", "webserver.h"), "utf8").match(/FIRMWARE_VERSION "([^"]+)"/)[1];
    await ev(`document.getElementById("version").textContent = ${JSON.stringify(version)}`);
    await shot("update.png", 600);
    ws.close();
    return 0;
  } finally {
    if (process.platform === "win32") {
      const folder = path.basename(profile);
      spawnSync("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${folder}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { stdio: "ignore" });
    } else {
      chrome.kill();
    }
    await mock("reset").catch(() => {});
    await sleep(1000);
    try {
      fs.rmSync(profile, { recursive: true, force: true });
    } catch (e) {
      // Chrome may still hold a file for a moment
    }
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(2);
  },
);
