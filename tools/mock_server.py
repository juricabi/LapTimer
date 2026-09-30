"""Simulated LapTimer for UI work: serves data/ and fakes the firmware JSON API.

Run: python tools/mock_server.py, then open http://127.0.0.1:8765/
Keep it in step with lib/WEBSERVER/api.cpp when the API changes.

Test helpers (mock only, GET):
  /mock/reboot            new boot id, settings revision back to 1, race ids from 0
  /mock/fail?config=N     the next N GET /config fail (500)
  /mock/fail?save=N       the next N POST /config fail (500)
  /mock/passes?on=0|1     stop / resume the simulated gate passes
  /mock/full              the pilot's lap memory is full (finished + "full")
  /mock/oldrace           adds a race saved by the multi-pilot firmware (two pilots)
  /mock/log               the last settings changes (POST /config bodies)
"""
import json, math, os, random, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
LOCK = threading.Lock()

CONFIG = {
    "freq": 5800, "minLap": 50, "alarm": 0, "anType": 2, "anRate": 10, "anDelta": True, "buzzerOn": True,
    "enterRssi": 120, "exitRssi": 100, "name": "Maverick",
    "raceMode": 0, "raceSec": 60, "raceLaps": 5, "countdown": False,
}
SAVED = ["Home WiFi", "Field hotspot"]
PROFILES = [
    {"name": "Maverick", "freq": 5800, "enter": 120, "exit": 100},
    {"name": "Iceman", "freq": 5658, "enter": 125, "exit": 104},
    {"name": "Rooster", "freq": 5917, "enter": 118, "exit": 98},
]
MAX_PROFILES_SIZE = 4096  # bytes of JSON, as in the firmware
MAX_LAPS = 200
LAP_BASE = 4.4  # seconds per simulated lap (fast for testing)
CONFIG_LOG = []  # last POST /config bodies, for /mock/log
T0 = time.time()
S = {"rev": 1, "boot": random.randint(1, 2**31 - 1), "prof": 1, "edits": 0, "failConfig": 0, "failSave": 0,
     "savedId": 0, "savedRace": 0, "passes": True}

# the current (or last) race; "pilot" is None before the first race
R = {"state": 0, "race": 0, "mode": 0, "cd": False, "raceMs": 60000, "raceLaps": 5, "start": 0,
     "timeUp": False, "date": 0, "pilot": None}
RACING = (1, 2, 3)


def seed_races():
    """Two saved single-pilot races, so History has something to show."""
    now = int(time.time())
    races = {}
    for rid, (ago, laps, mode) in enumerate([(3 * 86400, [0, 4620, 4410, 4388, 4501, 4297, 4350], 0),
                                             (2 * 3600, [0, 4210, 3980, 4105, 7960, 3920], 2)], start=1):
        races[rid] = {"id": rid, "date": now - ago, "mode": mode, "cd": False, "raceMs": 60000, "raceLaps": 5,
                      "pilots": [{"name": "Maverick", "freq": 5800, "fin": mode == 2, "laps": laps}]}
    return races


RACES = seed_races()


def now_ms():
    return int((time.time() - T0) * 1000)


def cut_utf8(text, limit=20):
    """Config/profile names: at most 20 bytes of UTF-8, cut at a whole character."""
    return (text or "").encode()[:limit].decode(errors="ignore")


def fix_thresholds(entry, enter_key, exit_key):
    """Exit stays below enter (as fixThresholds in the firmware)."""
    entry[enter_key] = max(1, int(entry[enter_key]))
    if entry[exit_key] >= entry[enter_key]:
        entry[exit_key] = entry[enter_key] - 1


def rssi(t):
    """Fake RSSI with a peak on every simulated pass."""
    phase = (t / 1000.0) % LAP_BASE
    return int(70 + 80 * math.exp(-((phase - LAP_BASE / 2) ** 2) / 0.02) + random.uniform(-3, 3))


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
        if p["fin"] or not S["passes"]:
            return
        if not p["laps"]:
            if elapsed > 700:  # after a countdown the first pass comes a little after GO
                p["laps"], p["last"] = [700], R["start"] + 700
            return
        if "next" not in p:
            p["next"] = int(LAP_BASE * 1000 + random.uniform(-500, 500))
        if t - p["last"] >= p["next"]:
            p["laps"].append(p["next"])
            p["last"] += p["next"]
            p["next"] = int(LAP_BASE * 1000 + random.uniform(-500, 500))
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


def apply_config(data):
    """Config::fromJson: only keys that are present, then the same checks as the firmware."""
    new = dict(CONFIG)
    for k, v in data.items():
        if k in new:
            new[k] = cut_utf8(v) if k == "name" else v
    if new["raceMode"] not in (0, 1, 2):
        new["raceMode"] = 0
    new["raceSec"] = max(10, int(new["raceSec"]))
    new["raceLaps"] = max(1, int(new["raceLaps"]))
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
        with LOCK:
            if u.path == "/mock/reboot":
                S.update({"rev": 1, "boot": random.randint(1, 2**31 - 1), "prof": 1, "edits": 0,
                          "savedId": 0, "savedRace": 0})
                R.update({"state": 0, "race": 0, "pilot": None})
                return self._json({"status": "OK"})
            if u.path == "/mock/fail":
                S["failConfig"] = int(q.get("config", ["0"])[0])
                S["failSave"] = int(q.get("save", ["0"])[0])
                return self._json({"status": "OK"})
            if u.path == "/mock/passes":
                S["passes"] = q.get("on", ["1"])[0] == "1"
                return self._json({"status": "OK"})
            if u.path == "/mock/log":
                return self._json(CONFIG_LOG)
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
                                   "timeUp": int(R["timeUp"]), "vbat": 41, "saveErr": 0,
                                   "savedId": S["savedId"], "savedRace": S["savedRace"], "spectrum": 0,
                                   "edits": S["edits"], "cfg": S["rev"], "boot": S["boot"], "prof": S["prof"],
                                   "rssi": rssi(t), "laps": len(p["laps"]), "fin": int(p["fin"])})
            if u.path == "/api/race":
                return self._json({"race": R["race"], "state": R["state"], "mode": R["mode"], "cd": R["cd"],
                                   "raceMs": R["raceMs"], "raceLaps": R["raceLaps"], "date": R["date"],
                                   "edits": S["edits"], "pilots": race_pilots()})
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
                    out.append({"id": r["id"], "date": r["date"], "mode": r["mode"],
                                "pilots": [{"name": p["name"], "laps": max(0, len(p["laps"]) - 1),
                                            "best": min(p["laps"][1:]) if len(p["laps"]) > 1 else 0} for p in r["pilots"]]})
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
                    {"ssid": "Cafe guest", "rssi": -80, "open": True}]})
            if u.path == "/api/spectrum":
                if "start" in q:
                    if R["state"] in RACING:
                        return self._json({"status": "busy"}, 409)
                    R["specAt"] = time.time()
                    return self._json({"status": "OK"})
                elapsed = time.time() - R.get("specAt", 0)
                total = 61 * 2  # SPECTRUM_POINTS x SPECTRUM_SWEEPS, ~6.5 s
                done = min(total, int(elapsed / 6.5 * total))
                running = done < total
                peaks = [(5800, 75), (5880, 55), (5740, 30)]
                vals = [max([55 + random.randint(0, 6)] + [int(55 + h * math.exp(-((5645 + k * 5 - f) ** 2) / 150)) for f, h in peaks])
                        if (done >= 61 or k < done) else 0 for k in range(61)]
                return self._json({"running": running, "done": done, "total": total, "start": 5645, "step": 5, "rssi": vals})
            if u.path == "/api/wifi/saved":
                return self._json({"networks": SAVED, "connected": SAVED[0] if SAVED else "", "max": 5})
            if u.path == "/api/info":
                return self._json({"version": "1.1.0-dev", "mode": "wifi", "ip": "192.168.1.50", "ssid": "Home WiFi",
                                   "host": "laptimer.local", "signal": -55})
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        u = urlparse(self.path)
        q = parse_qs(u.query)
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
                R.update({"race": R["race"] + 1, "mode": CONFIG["raceMode"], "cd": CONFIG["countdown"],
                          "raceMs": CONFIG["raceSec"] * 1000, "raceLaps": CONFIG["raceLaps"], "timeUp": False,
                          "date": int(q.get("t", ["0"])[0]),
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
            if u.path == "/api/races/clear":
                if R["state"] in RACING:
                    return self._json({"status": "racing"}, 409)
                RACES.clear()
                S["savedId"] = S["savedRace"] = 0
                return self._json({"status": "OK"})
            if u.path in ("/api/wifi/saved/add", "/api/wifi/saved/remove", "/api/wifi/saved/clear") and R["state"] in RACING:
                return self._json({"status": "racing"}, 409)
            if u.path == "/api/wifi/saved/add":
                d = json.loads(body)
                if d["ssid"] in SAVED:
                    SAVED.remove(d["ssid"])
                SAVED.insert(0, d["ssid"])
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
                drop = {name.lower(), (d.get("prev") or "").lower()}
                updated = [p for p in PROFILES if p["name"].lower() not in drop] + [entry]
                if len(json.dumps(updated)) > MAX_PROFILES_SIZE:
                    return self._json({"status": "full"}, 507)
                PROFILES[:] = updated
                S["prof"] += 1
                return self._json({"status": "OK"})
            if u.path in ("/restart",):
                return self._json({"status": "OK"})
        return self._json({"status": "not found"}, 404)

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
