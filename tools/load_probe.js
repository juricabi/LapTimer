// Load test for the timer's web server: the traffic of two open pages (status and RSSI history
// polls every 250 ms, the race now and then, saved pilots and settings every few seconds) and,
// every 15 s, a page load (ten parallel requests on fresh connections, as a new tab makes).
// Prints every request slower than 1 s or failed, an "alive" line each minute, and a summary.
//
//   node tools/load_probe.js <host> [seconds]      e.g. node tools/load_probe.js 192.168.4.1 600
//
// Up to v1.2.2 this crashed the timer within minutes (the 2019 AsyncTCP fork: lwIP assert
// "tcp_update_rcv_ann_wnd" from _tcp_recved_api during a page load, or CORRUPT HEAP in
// _async_service_task): the timer rebooted, and every phone saw "Offline" for a while. Run it
// with tools/boot_log.py recording the serial port; /api/debug/load's rst0 shows a crash (4)
// after the restart too. Expected now: 0 failed, no restart.
const http = require("http");
const HOST = process.argv[2];
const SECONDS = +(process.argv[3] || 600);
if (!HOST) {
  console.log("usage: node tools/load_probe.js <host> [seconds]");
  process.exit(1);
}
let n = 0, slow = 0, failed = 0;
const stamp = () => new Date().toTimeString().slice(0, 8);

function get(agent, path, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      const ms = Date.now() - t0;
      n++;
      if (r.err) failed++;
      else if (ms >= 1000) slow++;
      if (r.err || ms >= 1000) console.log(`${stamp()} ${r.err ? "FAILED " + r.err : "slow"} ${ms} ms ${path}`);
      resolve();
    };
    const req = http.get({ host: HOST, path, agent, timeout: timeoutMs }, (res) => {
      res.resume();
      res.on("end", () => done({ code: res.statusCode }));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", (e) => done({ err: e.code || e.message }));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const end = Date.now() + SECONDS * 1000;
async function chain(agent, path, periodMs) {
  while (Date.now() < end) {
    await get(agent, path);
    await sleep(periodMs);
  }
}
function page(agent) {
  return [
    chain(agent, "/api/status", 250),
    chain(agent, "/api/rssi?since=0", 250),
    chain(agent, "/api/race", 1300),
    chain(agent, "/api/profiles", 7000),
    chain(agent, "/config", 11000),
  ];
}
async function loads() {
  while (Date.now() < end) {
    const agent = new http.Agent({ keepAlive: true, maxSockets: 6 });
    await Promise.all(["/", "/style.css", "/script.js", "/smoothie.js", "/favicon.ico", "/config", "/api/profiles", "/api/races", "/api/info", "/api/status"]
      .map((p) => get(agent, p, 8000)));
    agent.destroy();
    await sleep(15000);
  }
}
async function alive() {
  while (Date.now() < end) {
    await sleep(60000);
    console.log(`${stamp()} alive: ${n} requests, ${slow} slow, ${failed} failed`);
  }
}
(async () => {
  const a = new http.Agent({ keepAlive: true, maxSockets: 6 });
  const b = new http.Agent({ keepAlive: true, maxSockets: 6 });
  await Promise.all([...page(a), ...page(b), loads(), alive()]);
  console.log(`SUMMARY: ${n} requests, ${slow} slower than 1 s, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
