// Runs the page test suite (tools/page_test.js) against the mock in a headless Chrome: nothing
// on screen, and not slowed down like a browser tab that is hidden or covered.
//
//   python tools/mock_server.py              (in another window)
//   node tools/run_page_test.js              every section
//   node tools/run_page_test.js setup race   some of them
//
// Prints every PASS/FAIL as it runs; exit code 0 when all pass. Needs Node 22+ (WebSocket) and
// Chrome or Edge (or the CHROME environment variable pointing at one).
const { spawn, spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MOCK = "http://127.0.0.1:8765";
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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "laptimer-page-test-"));
  // port 0: Chrome picks a free port and writes it into the profile, so this run can only ever
  // talk to the browser it started (not one left over from an earlier run)
  const chrome = spawn(browser, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--window-size=1200,1000", "about:blank"], { stdio: "ignore" });
  try {
    let target = null;
    const portFile = path.join(profile, "DevToolsActivePort");
    for (let i = 0; i < 100 && !target; i++) {
      try {
        const port = fs.readFileSync(portFile, "utf8").split("\n")[0].trim();
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

    let failures = 0;
    listeners.set("Runtime.consoleAPICalled", ({ type, args }) => {
      const text = args.map((a) => (a.value !== undefined ? a.value : a.description)).join(" ");
      if (type === "log" || type === "info") {
        if (text.startsWith("FAIL")) failures++;
        if (text.startsWith("PASS") || text.startsWith("FAIL") || text.startsWith("──")) console.log(text);
      }
    });
    listeners.set("Runtime.exceptionThrown", ({ exceptionDetails }) =>
      console.log("page error:", exceptionDetails.exception ? exceptionDetails.exception.description : exceptionDetails.text));
    await send("Runtime.enable");
    await send("Page.enable");
    // the page under test in its dark theme by default (the layout section also tries light)
    await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
    // a headless page has no focus: without this, focus() and blur() fire no events
    await send("Emulation.setFocusEmulationEnabled", { enabled: true });
    const loaded = new Promise((resolve) => listeners.set("Page.loadEventFired", resolve));
    await send("Page.navigate", { url: MOCK + "/mock/log" });
    await loaded;
    await send("Runtime.evaluate", {
      expression: `new Promise((resolve, reject) => { const s = document.createElement("script"); s.src = "/mock/page_test.js?" + Date.now();
        s.onload = resolve; s.onerror = () => reject(new Error("could not load /mock/page_test.js")); document.head.append(s); })`,
      awaitPromise: true,
    });
    const sections = process.argv.slice(2);
    const started = Date.now();
    const reply = await send("Runtime.evaluate", {
      expression: `pageTest(${sections.length ? JSON.stringify(sections) : "undefined"})`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception.description);
    const result = reply.result.value;
    console.log(`\n${result.passed} passed, ${result.failed.length} failed (${Math.round((Date.now() - started) / 1000)} s)`);
    for (const f of result.failed) console.log(`  FAIL ${f.name}  ${JSON.stringify(f.detail)}`);
    ws.close();
    return result.failed.length || failures ? 1 : 0;
  } finally {
    // the whole browser: on Windows the started process hands over to a new one and exits, so
    // its process tree is gone; every process using this run's profile folder is closed instead
    if (process.platform === "win32") {
      const folder = path.basename(profile);
      spawnSync("powershell", ["-NoProfile", "-Command",
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${folder}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`],
        { stdio: "ignore" });
    } else {
      chrome.kill();
    }
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
