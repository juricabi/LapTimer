"""Simulated LapTimer for UI work: serves data/ and fakes the firmware JSON API.

Run: python tools/mock_server.py, then open http://127.0.0.1:8765/
     python tools/mock_server.py --host 0.0.0.0   (reachable from a phone on the same network)
Keep it in step with lib/WEBSERVER/api.cpp when the API changes.

Test helpers (mock only, GET):
  /mock/reset             everything back to the start: settings, saved pilots, WiFi list, races,
                          boot, and the helpers below (for tests that need a known state)
  /mock/reboot            new boot id, settings revision back to 1, race ids from 0
  /mock/fail?config=N     the next N GET /config fail (500)
  /mock/fail?save=N       the next N POST /config fail (500)
  /mock/slow?config=MS    every POST /config takes MS before it is applied (a save still on its way)
  /mock/busy?start=N      the next N /timer/start answer 409 (still saving the last race)
  /mock/offline?on=1|0    the timer can't be reached: every API request answers 503
  /mock/passes?on=0|1     stop / resume the simulated gate passes
  /mock/lap?s=2.0         simulated lap length in seconds (default 4.4; shorter for quick tests)
  /mock/full              the pilot's lap memory is full (finished + "full")
  /mock/saveerr?on=1|0    the last race could not be saved (status saveErr)
  /mock/info?mode=hotspot the timer runs its own hotspot (default wifi)
  /mock/vbat?v=37         battery voltage in tenths of a volt
  /mock/oldrace           adds a race saved by the multi-pilot firmware (two pilots)
  /mock/log               the last settings changes (POST /config bodies)
  /mock/page_test.js      tools/page_test.js, for the browser console (see that file)
"""
import argparse, copy, json, math, os, random, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
LOCK = threading.Lock()

DEFAULT_CONFIG = {
    "freq": 5800, "minLap": 50, "alarm": 0, "anType": 2, "anRate": 10, "anDelta": True, "anTarget": False, "buzzerOn": True,
    "enterRssi": 120, "exitRssi": 100, "name": "Maverick",
    "raceMode": 0, "raceSec": 60, "raceLaps": 5, "countdown": False, "target": 0,
}
DEFAULT_SAVED = ["Home WiFi", "Field hotspot"]
DEFAULT_PROFILES = [
    {"name": "Maverick", "freq": 5800, "enter": 120, "exit": 100},
    {"name": "Iceman", "freq": 5658, "enter": 125, "exit": 104, "target": 4300},
    {"name": "Rooster", "freq": 5917, "enter": 118, "exit": 98},
]
CONFIG = copy.deepcopy(DEFAULT_CONFIG)
SAVED = list(DEFAULT_SAVED)
PROFILES = copy.deepcopy(DEFAULT_PROFILES)
MAX_PROFILES_SIZE = 4096  # bytes of JSON, as in the firmware
MAX_WIFI_NETWORKS = 5  # a sixth forgets the oldest
RACE_NAME_MAX_BYTES = 32
TARGET_LAP_MIN_MS, TARGET_LAP_MAX_MS = 3000, 600000
MAX_LAPS = 200
LAP_BASE = 4.4  # seconds per simulated lap (fast for testing)
CONFIG_LOG = []  # last POST /config bodies, for /mock/log
T0 = time.time()


def initial_state():
    return {"rev": 1, "boot": random.randint(1, 2**31 - 1), "prof": 1, "edits": 0, "failConfig": 0, "failSave": 0,
            "savedId": 0, "savedRace": 0, "passes": True, "lap": LAP_BASE, "offline": False, "saveErr": 0,
            "mode": "wifi", "vbat": 41, "slowConfig": 0, "busyStart": 0}


def initial_race():
    """The current (or last) race; "pilot" is None before the first race."""
    return {"state": 0, "race": 0, "mode": 0, "cd": False, "raceMs": 60000, "raceLaps": 5, "start": 0,
            "timeUp": False, "date": 0, "pilot": None}


S = initial_state()
R = initial_race()
RACING = (1, 2, 3)


def seed_races():
    """Saved single-pilot races for History: 1, 2, 6 and 45 laps, a missed pass (double lap),
    a 60 s crash lap, a named race and races flown with a pace target."""
    now = int(time.time())
    rnd = random.Random(7)
    many = [0] + [int(12800 + rnd.uniform(-450, 650) - k * 8) for k in range(45)]
    outlier = [0, 13120, 12840, 12990, 60150, 13300, 12710, 12880]
    seeds = [  # (ago, laps, mode, extra)
        (6 * 86400, [0, 13420], 0, {}),
        (5 * 86400, [0, 13110, 12870], 0, {}),
        (3 * 86400, [0, 4620, 4410, 4388, 4501, 4297, 4350], 0, {}),
        (2 * 86400, many, 0, {"name": "Evening session at the field", "target": 12800}),
        (26 * 3600, outlier, 1, {"target": 13000}),
        (2 * 3600, [0, 4210, 3980, 4105, 7960, 3920], 2, {}),
    ]
    races = {}
    for rid, (ago, laps, mode, extra) in enumerate(seeds, start=1):
        races[rid] = {"id": rid, "date": now - ago, "mode": mode, "cd": mode == 1, "raceMs": 120000, "raceLaps": 5,
                      "pilots": [{"name": "Maverick", "freq": 5800, "fin": mode == 2, "laps": laps}], **extra}
    return races


RACES = seed_races()


def reset_all():
    """/mock/reset: the state the mock starts with."""
    CONFIG.clear()
    CONFIG.update(copy.deepcopy(DEFAULT_CONFIG))
    SAVED[:] = DEFAULT_SAVED
    PROFILES[:] = copy.deepcopy(DEFAULT_PROFILES)
    RACES.clear()
    RACES.update(seed_races())
    CONFIG_LOG.clear()
    S.clear()
    S.update(initial_state())
    R.clear()
    R.update(initial_race())


def scan_running():
    return time.time() - R.get("specAt", 0) < 6.5


def offline_api(path):
    """/mock/offline: the timer's own requests fail (the page files are still served)."""
    return S["offline"] and path.startswith(("/api/", "/config", "/timer/", "/restart", "/ota/"))


def now_ms():
    return int((time.time() - T0) * 1000)


def cut_utf8(text, limit=20):
    """Config/profile names: at most 20 bytes of UTF-8, cut at a whole character."""
    return (text or "").encode()[:limit].decode(errors="ignore")


def clamp_target(ms):
    """Pace target: 0 = off, otherwise 3-600 s (clampTargetLapMs in the firmware)."""
    ms = max(0, int(ms or 0))
    return 0 if ms == 0 else min(TARGET_LAP_MAX_MS, max(TARGET_LAP_MIN_MS, ms))


RSSI_SLIDER_MIN = 50


def fix_thresholds(entry, enter_key, exit_key):
    """Exit stays below enter, both within the page's sliders (as fixThresholds in the firmware)."""
    entry[enter_key] = max(RSSI_SLIDER_MIN + 1, min(255, int(entry[enter_key])))
    entry[exit_key] = max(RSSI_SLIDER_MIN, min(255, int(entry[exit_key])))
    if entry[exit_key] >= entry[enter_key]:
        entry[exit_key] = entry[enter_key] - 1


def within(value, low, high):
    return max(low, min(high, int(value)))


def rssi(t):
    """Fake RSSI with a peak on every simulated pass."""
    lap = S["lap"]
    phase = (t / 1000.0) % lap
    return int(70 + 80 * math.exp(-((phase - lap / 2) ** 2) / 0.02) + random.uniform(-3, 3))


def simulate():
    with LOCK:
        t = now_ms()
        p = R["pilot"]
        if R["state"] == 1 and t >= R["start"]:
            R["state"] = 3
        if R["state"] == 2 and S["passes"] and t - R["arm"] > 1500:  # first pass after 1.5 s
            R["state"] = 3
            R["start"] = t
            p["laps"], p["last"] = [0], t
        if R["state"] != 3:
            return
        elapsed = t - R["start"]
        if R["mode"] == 1 and not R["timeUp"] and elapsed >= R["raceMs"]:
            R["timeUp"] = True
        if R["mode"] == 1 and R["timeUp"] and not p["laps"]:
            R["state"] = 4  # time up before the first pass: the race ends, nothing to save
            return
        if R["mode"] != 0 and p["fin"]:  # finished (or lap memory full): a timed/lap race ends
            R["state"] = 4
            save_race()
            return
        if p["fin"] or not S["passes"]:
            return
        if not p["laps"]:
            if elapsed > 700:  # after a countdown the first pass comes a little after GO
                p["laps"], p["last"] = [700], R["start"] + 700
            return
        if "next" not in p:
            p["next"] = int(S["lap"] * 1000 + random.uniform(-500, 500) * S["lap"] / LAP_BASE)
        if t - p["last"] >= p["next"]:
            p["laps"].append(p["next"])
            p["last"] += p["next"]
            p["next"] = int(S["lap"] * 1000 + random.uniform(-500, 500) * S["lap"] / LAP_BASE)
            pass_at = p["last"] - R["start"]
            if len(p["laps"]) >= MAX_LAPS:
                p["fin"] = p["full"] = True
            if (R["mode"] == 2 and len(p["laps"]) - 1 >= R["raceLaps"]) or (R["mode"] == 1 and pass_at >= R["raceMs"]):
                p["fin"] = True
        if R["mode"] != 0 and p["fin"]:
            R["state"] = 4
            save_race()


def race_pilots():
    p = R["pilot"]
    if not p:
        return [{"name": CONFIG["name"], "freq": CONFIG["freq"], "fin": False, "laps": []}]
    entry = {"name": p["name"], "freq": p["freq"], "fin": p["fin"], "laps": list(p["laps"])}
    if p.get("full"):
        entry["full"] = True
    return [entry]


def save_race():
    rid = max(RACES, default=0) + 1
    RACES[rid] = {"id": rid, "date": R["date"], "mode": R["mode"], "cd": R["cd"], "raceMs": R["raceMs"],
                  "raceLaps": R["raceLaps"], "pilots": race_pilots()}
    if R.get("target"):
        RACES[rid]["target"] = R["target"]  # the pace target the race started with
    S["savedId"], S["savedRace"] = rid, R["race"]


def apply_lap_edit(laps, op, index):
    """Same as applyLapEdit() in the firmware; returns False if not possible."""
    if index < 0 or index >= len(laps):
        return False
    if op == 0:  # merge
        if index == len(laps) - 1:
            laps.pop()
            return True
        laps[index] += laps.pop(index + 1)
        return True
    if op == 1:  # split
        if index == 0 or len(laps) >= MAX_LAPS:
            return False
        first = laps[index] // 2
        laps.insert(index + 1, laps[index] - first)
        laps[index] = first
        return True
    return False


def wifi_entry_ok(ssid, pwd):
    """As the firmware: a name of 1-32 bytes; a password empty (open network), 8-63 bytes, or 64 hex digits."""
    if not 1 <= len(ssid.encode()) <= 32:
        return False
    n = len(pwd.encode())
    return n == 0 or 8 <= n <= 63 or (n == 64 and all(c in "0123456789abcdefABCDEF" for c in pwd))


def apply_config(data):
    """Config::fromJson: only keys that are present, then the same checks as the firmware."""
    new = dict(CONFIG)
    for k, v in data.items():
        if k in new:
            new[k] = cut_utf8(v) if k == "name" else v
    if new["raceMode"] not in (0, 1, 2):
        new["raceMode"] = 0
    # within the page's control ranges (as the firmware)
    new["raceSec"] = within(new["raceSec"], 30, 600)
    new["raceLaps"] = within(new["raceLaps"], 1, 30)
    new["minLap"] = within(new["minLap"], 10, 200)
    new["anRate"] = within(new["anRate"], 1, 20)
    new["alarm"] = within(new["alarm"], 0, 42)
    new["target"] = clamp_target(new["target"])
    if new["anDelta"] and new["anTarget"]:  # best lap or target, never both: the one switched on now wins
        if data.get("anTarget"):
            new["anDelta"] = False
        else:
            new["anTarget"] = False
    fix_thresholds(new, "enterRssi", "exitRssi")
    if new != CONFIG:
        CONFIG.update(new)
        S["rev"] += 1


def old_two_pilot_race():
    rid = max(RACES, default=0) + 1
    RACES[rid] = {"id": rid, "date": int(time.time()) - 7 * 86400, "mode": 2, "cd": True, "stag": False,
                  "raceMs": 60000, "raceLaps": 3,
                  "pilots": [{"name": "Maverick", "freq": 5800, "fin": True, "laps": [120, 4410, 4388, 4297]},
                             {"name": "Goose", "freq": 5880, "fin": True, "laps": [310, 4620, 4501, 4350]}]}


class H(SimpleHTTPRequestHandler):
    def __init__(self, *a, **k):
        super().__init__(*a, directory=DATA, **k)

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        simulate()
        u = urlparse(self.path)
        q = parse_qs(u.query)
        t = now_ms()
        if offline_api(u.path):
            return self._json({"status": "offline"}, 503)
        with LOCK:
            if u.path == "/mock/reset":
                reset_all()
                return self._json({"status": "OK"})
            if u.path == "/mock/offline":
                S["offline"] = q.get("on", ["1"])[0] == "1"
                return self._json({"status": "OK"})
            if u.path == "/mock/lap":
                S["lap"] = max(0.5, float(q.get("s", [str(LAP_BASE)])[0]))
                return self._json({"status": "OK"})
            if u.path == "/mock/saveerr":
                S["saveErr"] = 1 if q.get("on", ["1"])[0] == "1" else 0
                return self._json({"status": "OK"})
            if u.path == "/mock/info":
                S["mode"] = "hotspot" if q.get("mode", ["wifi"])[0] == "hotspot" else "wifi"
                return self._json({"status": "OK"})
            if u.path == "/mock/vbat":
                S["vbat"] = int(q.get("v", ["41"])[0])
                return self._json({"status": "OK"})
            if u.path == "/mock/reboot":
                S.update({"rev": 1, "boot": random.randint(1, 2**31 - 1), "prof": 1, "edits": 0,
                          "savedId": 0, "savedRace": 0})
                R.update({"state": 0, "race": 0, "pilot": None})
                return self._json({"status": "OK"})
            if u.path == "/mock/fail":
                S["failConfig"] = int(q.get("config", ["0"])[0])
                S["failSave"] = int(q.get("save", ["0"])[0])
                return self._json({"status": "OK"})
            if u.path == "/mock/slow":
                S["slowConfig"] = int(q.get("config", ["0"])[0])
                return self._json({"status": "OK"})
            if u.path == "/mock/busy":
                S["busyStart"] = int(q.get("start", ["0"])[0])
                return self._json({"status": "OK"})
            if u.path == "/mock/passes":
                S["passes"] = q.get("on", ["1"])[0] == "1"
                return self._json({"status": "OK"})
            if u.path == "/mock/log":
                return self._json(CONFIG_LOG)
            if u.path == "/mock/page_test.js":
                with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "page_test.js"), "rb") as f:
                    body = f.read()
                self.send_response(200)
                self.send_header("Content-Type", "application/javascript")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
                return
            if u.path == "/mock/full":
                if R["pilot"]:
                    R["pilot"]["fin"] = R["pilot"]["full"] = True
                return self._json({"status": "OK"})
            if u.path == "/mock/oldrace":
                old_two_pilot_race()
                return self._json({"status": "OK"})
            if u.path == "/config":
                if S["failConfig"] > 0:
                    S["failConfig"] -= 1
                    return self._json({"status": "error"}, 500)
                return self._json({"rev": S["rev"], **CONFIG})
            if u.path == "/api/status":
                p = R["pilot"] or {"laps": [], "fin": False}
                elapsed = t - R["start"] if R["state"] in (1, 3) else 0
                return self._json({"state": R["state"], "mode": R["mode"], "cd": int(R["cd"]), "race": R["race"],
                                   "elapsed": elapsed, "raceMs": R["raceMs"], "raceLaps": R["raceLaps"],
                                   "timeUp": int(R["timeUp"]), "vbat": S["vbat"], "saveErr": S["saveErr"],
                                   "savedId": S["savedId"], "savedRace": S["savedRace"], "spectrum": int(scan_running()),
                                   "edits": S["edits"], "cfg": S["rev"], "boot": S["boot"], "prof": S["prof"],
                                   "rssi": rssi(t), "laps": len(p["laps"]), "fin": int(p["fin"])})
            if u.path == "/api/race":
                race = {"race": R["race"], "state": R["state"], "mode": R["mode"], "cd": R["cd"],
                        "raceMs": R["raceMs"], "raceLaps": R["raceLaps"], "date": R["date"],
                        "edits": S["edits"], "pilots": race_pilots()}
                if R.get("target"):
                    race["target"] = R["target"]
                return self._json(race)
            if u.path == "/api/rssi":
                seq = t // 25
                since = int(q.get("since", ["0"])[0])
                if since > seq or seq - since > 239:
                    since = seq - 239
                return self._json({"seq": seq, "step": 25, "rssi": [rssi(s * 25) for s in range(since + 1, seq + 1)]})
            if u.path == "/api/races":
                if "id" in q:
                    race = RACES.get(int(q["id"][0]))
                    return self._json(race) if race else self._json({"error": "not found"}, 404)
                out = []
                for r in RACES.values():
                    item = {"id": r["id"], "date": r["date"], "mode": r["mode"],
                            "pilots": [{"name": p["name"], "laps": max(0, len(p["laps"]) - 1),
                                        "best": min(p["laps"][1:]) if len(p["laps"]) > 1 else 0} for p in r["pilots"]]}
                    if "name" in r:
                        item["name"] = r["name"]
                    out.append(item)
                return self._json(out)
            if u.path == "/api/profiles":
                return self._json(PROFILES)
            if u.path == "/api/wifi/scan":
                if "start" in q:
                    R["scanAt"] = time.time()
                    return self._json({"scanning": True})
                if time.time() - R.get("scanAt", 0) < 2:
                    return self._json({"scanning": True})
                return self._json({"scanning": False, "networks": [
                    {"ssid": "Home WiFi", "rssi": -48, "open": False},
                    {"ssid": "Neighbour", "rssi": -61, "open": False},
                    {"ssid": "Cafe guest", "rssi": -80, "open": True},
                    {"ssid": "Z" * 32, "rssi": -90, "open": False}]})  # the longest name, unbroken
            if u.path == "/api/spectrum":
                if "start" in q:
                    if R["state"] in RACING:
                        return self._json({"status": "busy"}, 409)
                    R["specAt"] = time.time()
                    R["specCancelled"] = False
                    return self._json({"status": "OK"})
                elapsed = time.time() - R.get("specAt", 0)
                total = 61 * 2  # SPECTRUM_POINTS x SPECTRUM_SWEEPS, ~6.5 s
                done = 0 if R.get("specCancelled") else min(total, int(elapsed / 6.5 * total))
                running = done < total and not R.get("specCancelled")
                peaks = [(5800, 75), (5880, 55), (5740, 30)]
                vals = [max([55 + random.randint(0, 6)] + [int(55 + h * math.exp(-((5645 + k * 5 - f) ** 2) / 150)) for f, h in peaks])
                        if (done >= 61 or k < done) else 0 for k in range(61)]
                return self._json({"running": running, "done": done, "total": total, "start": 5645, "step": 5, "rssi": vals})
            if u.path == "/api/wifi/saved":
                connected = SAVED[0] if SAVED and S["mode"] == "wifi" else ""  # none on its own hotspot
                return self._json({"networks": SAVED, "connected": connected, "max": MAX_WIFI_NETWORKS})
            if u.path == "/api/debug/load":
                return self._json({"samplesPerSec": 8400, "core0RoundsPerSec": 100000, "cpuMhz": 240, "wifiMode": 1,
                                   "txPowerDbm": 19.5, "protoAp": 7, "protoSta": 7, "bwAp": 2, "ps": 1, "channel": 1,
                                   "apClients": 0, "txLoop": 0, "txGain": 19, "txAnaGain": "0120005f", "txAnaCal": "5f"})
            if u.path == "/api/debug/aplog":
                return self._json({"now": now_ms(), "events": []})
            if u.path == "/ota/start":  # update.html / ElegantOTA: a GET, then POST /ota/upload
                return self._json({"status": "OK"})
            if u.path == "/api/info":
                if S["mode"] == "hotspot":
                    return self._json({"version": "1.2.0-dev", "mode": "hotspot", "ip": "192.168.4.1",
                                       "ssid": "LapTimer_BD58 192.168.4.1", "host": "laptimer.local"})
                return self._json({"version": "1.2.0-dev", "mode": "wifi", "ip": "192.168.1.50", "ssid": "Home WiFi",
                                   "host": "laptimer.local", "signal": -55})
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        u = urlparse(self.path)
        if offline_api(u.path):
            return self._json({"status": "offline"}, 503)
        if u.path in ("/ota/start", "/ota/upload"):  # update.html: the upload is accepted and dropped
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.end_headers()
            self.wfile.write(b"OK")
            return
        if u.path in ("/api/debug/hotspot", "/api/debug/txgain"):
            return self._json({"status": "OK"})
        q = parse_qs(u.query)
        if u.path == "/config" and S["slowConfig"]:
            time.sleep(S["slowConfig"] / 1000)  # on its way: another request can be handled first
        with LOCK:
            if u.path == "/config":
                if S["failSave"] > 0:
                    S["failSave"] -= 1
                    return self._json({"status": "error"}, 500)
                base = S["rev"]
                data = json.loads(body or b"{}")
                CONFIG_LOG.append({"t": now_ms(), "from": self.headers.get("Referer", ""), "body": data})
                del CONFIG_LOG[:-50]
                apply_config(data)
                return self._json({"status": "OK", "base": base, "rev": S["rev"]})
            if u.path == "/timer/start":
                if R["state"] in RACING:
                    return self._json({"status": "busy"}, 409)
                if S["busyStart"] > 0:  # the last race is still being saved
                    S["busyStart"] -= 1
                    return self._json({"status": "busy"}, 409)
                if scan_running():  # a race start cancels a channel scan (as the firmware: progress 0)
                    R["specCancelled"] = True
                R["specAt"] = 0
                R.update({"race": R["race"] + 1, "mode": CONFIG["raceMode"], "cd": CONFIG["countdown"],
                          "raceMs": CONFIG["raceSec"] * 1000, "raceLaps": CONFIG["raceLaps"], "timeUp": False,
                          "date": int(q.get("t", ["0"])[0]), "target": CONFIG["target"],
                          "pilot": {"name": CONFIG["name"], "freq": CONFIG["freq"], "laps": [], "fin": False, "last": 0}})
                S["edits"] = 0
                if R["cd"]:
                    R["state"] = 1
                    R["start"] = now_ms() + 3000
                else:
                    R["state"] = 2
                    R["arm"] = now_ms()
                return self._json({"status": "OK"})
            if u.path == "/timer/stop":
                if R["state"] in RACING and R["pilot"]["laps"]:
                    save_race()
                R["state"] = 0
                return self._json({"status": "OK"})
            if u.path == "/timer/clear":
                if R["state"] in RACING:
                    return self._json({"status": "busy"}, 409)
                R["state"] = 0
                R["pilot"] = None
                return self._json({"status": "OK"})
            if u.path == "/api/races/edit":
                if R["state"] in RACING:  # no flash writes during a race
                    return self._json({"status": "racing"}, 409)
                d = json.loads(body or b"{}")
                race = RACES.get(d.get("id", 0))
                pilot, op, lap = d.get("pilot", 0), d.get("op", 255), d.get("lap", -1)
                if not race or pilot >= len(race["pilots"]):
                    return self._json({"status": "invalid"}, 400)
                laps = race["pilots"][pilot]["laps"]
                if "expect" in d and not (0 <= lap < len(laps) and laps[lap] == d["expect"]):
                    return self._json({"status": "stale"}, 409)
                if not apply_lap_edit(laps, op, lap):
                    return self._json({"status": "invalid"}, 400)
                if len(laps) < MAX_LAPS:
                    race["pilots"][pilot].pop("full", None)
                # the race still shown on the Race tab gets the same correction
                live = R["pilot"]
                if race["id"] == S["savedId"] and R["race"] == S["savedRace"] and pilot == 0 and live:
                    apply_lap_edit(live["laps"], op, lap)
                    if len(live["laps"]) < MAX_LAPS:
                        live.pop("full", None)
                    S["edits"] += 1
                return self._json({"status": "OK"})
            if u.path == "/api/races/rename":
                if R["state"] in RACING:  # no flash writes during a race
                    return self._json({"status": "racing"}, 409)
                d = json.loads(body or b"{}")
                race = RACES.get(d.get("id", 0))
                if not race:
                    return self._json({"status": "invalid"}, 400)
                name = cut_utf8(d.get("name") or "", RACE_NAME_MAX_BYTES)
                if name:
                    race["name"] = name
                else:
                    race.pop("name", None)  # back to the date
                return self._json({"status": "OK"})
            if u.path == "/api/races/clear":
                if R["state"] in RACING:
                    return self._json({"status": "racing"}, 409)
                RACES.clear()
                S["savedId"] = S["savedRace"] = 0
                return self._json({"status": "OK"})
            if u.path in ("/api/wifi/saved/add", "/api/wifi/saved/remove", "/api/wifi/saved/clear") and R["state"] in RACING:
                return self._json({"status": "racing"}, 409)
            if u.path == "/api/wifi/saved/add":
                d = json.loads(body or b"{}")
                ssid, pwd = d.get("ssid") or "", d.get("pwd") or ""
                if not wifi_entry_ok(ssid, pwd):
                    return self._json({"status": "invalid"}, 400)
                if ssid in SAVED:
                    SAVED.remove(ssid)
                SAVED.insert(0, ssid)
                del SAVED[MAX_WIFI_NETWORKS:]  # full: the oldest is forgotten
                return self._json({"status": "OK"})
            if u.path == "/api/wifi/saved/remove":
                d = json.loads(body)
                if d["ssid"] in SAVED:
                    SAVED.remove(d["ssid"])
                return self._json({"status": "OK"})
            if u.path == "/api/wifi/saved/clear":
                SAVED.clear()
                return self._json({"status": "OK"})
            if u.path in ("/api/profiles/save", "/api/profiles/remove"):
                if R["state"] in RACING:  # no flash writes during a race
                    return self._json({"status": "racing"}, 409)
                d = json.loads(body or b"{}")
                name = cut_utf8((d.get("name") or "").strip())
                if not name:
                    return self._json({"status": "invalid"}, 400)
                if u.path.endswith("/remove"):
                    kept = [p for p in PROFILES if p["name"].lower() != name.lower()]
                    if len(kept) != len(PROFILES):
                        PROFILES[:] = kept
                        S["prof"] += 1
                    return self._json({"status": "OK"})
                entry = {"name": name, "freq": d.get("freq", 0), "enter": d.get("enter", 120), "exit": d.get("exit", 100)}
                fix_thresholds(entry, "enter", "exit")
                if clamp_target(d.get("target")):
                    entry["target"] = clamp_target(d.get("target"))  # stored only when set
                drop = {name.lower(), (d.get("prev") or "").lower()}
                updated = [p for p in PROFILES if p["name"].lower() not in drop] + [entry]
                if len(json.dumps(updated)) > MAX_PROFILES_SIZE:
                    return self._json({"status": "full"}, 507)
                PROFILES[:] = updated
                S["prof"] += 1
                return self._json({"status": "OK"})
            if u.path in ("/restart",):
                if R["state"] in RACING:  # a restart would lose the race
                    return self._json({"status": "racing"}, 409)
                return self._json({"status": "OK"})
        return self._json({"status": "not found"}, 404)

    def log_message(self, *a):
        pass


parser = argparse.ArgumentParser(description="Simulated LapTimer for UI work")
parser.add_argument("--host", default="127.0.0.1", help="0.0.0.0 to reach it from a phone")
parser.add_argument("--port", type=int, default=8765)
args = parser.parse_args()
ThreadingHTTPServer((args.host, args.port), H).serve_forever()
