"""Simulated LapTimer for UI work: serves data/ and fakes the firmware JSON API.

Run: python tools/mock_server.py, then open http://127.0.0.1:8765/
Keep it in step with lib/WEBSERVER/api.cpp when the API changes.
"""
import json, math, os, random, threading, time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data")
LOCK = threading.Lock()

CONFIG = {
    "freq": 5800, "minLap": 50, "alarm": 0, "anType": 2, "anRate": 10, "anDelta": True, "buzzerOn": True,
    "enterRssi": 120, "exitRssi": 100, "name": "Maverick", "pilots": 2,
    "p": [
        {"name": "Maverick", "freq": 5800, "enter": 120, "exit": 100},
        {"name": "Goose", "freq": 5880, "enter": 118, "exit": 98},
        {"name": "", "freq": 5732, "enter": 120, "exit": 100},
        {"name": "", "freq": 5917, "enter": 120, "exit": 100},
    ],
    "raceMode": 0, "raceSec": 60, "raceLaps": 3, "countdown": False, "ssid": "", "pwd": "",
}
SAVED = ["Home WiFi", "Field hotspot"]
PROFILES = [{"name": "Iceman", "freq": 5658, "enter": 125, "exit": 104}]
RACES = {}
T0 = time.time()

# race simulation
R = {"state": 0, "race": 0, "mode": 0, "cd": False, "raceMs": 60000, "raceLaps": 3,
     "start": 0.0, "timeUp": False, "pilots": [], "date": 0, "count": 1}
LAP_BASE = [4.2, 4.6, 5.0, 5.4]  # seconds per lap per pilot (fast for testing)


def now_ms():
    return int((time.time() - T0) * 1000)


def rssi(i, t):
    """Fake RSSI with a pass every ~4.5 s per pilot."""
    period = LAP_BASE[i]
    phase = ((t / 1000.0) + i * 1.1) % period
    peak = 150 + 10 * i
    return int(70 + (peak - 70) * math.exp(-((phase - period / 2) ** 2) / 0.02) + random.uniform(-3, 3))


def simulate():
    with LOCK:
        t = now_ms()
        if R["state"] == 1 and t >= R["start"]:
            R["state"] = 3
        if R["state"] == 2 and t - R["arm"] > 1500:  # first pass after 1.5 s
            R["state"] = 3
            R["start"] = t
            for i, p in enumerate(R["pilots"]):
                p["laps"] = [0 if i == 0 else 300 * i]
                p["last"] = t + 300 * i
        if R["state"] != 3:
            return
        elapsed = t - R["start"]
        if R["mode"] == 1 and not R["timeUp"] and elapsed >= R["raceMs"]:
            R["timeUp"] = True
        for i, p in enumerate(R["pilots"]):
            if p["fin"]:
                continue
            if not p["laps"]:
                if elapsed > 400 * i:
                    p["laps"] = [400 * i if R["cd"] else 0]
                    p["last"] = t
                continue
            if "next" not in p:
                p["next"] = int(LAP_BASE[i] * 1000 + random.uniform(-600, 600))
            if t - p["last"] >= p["next"]:
                p["laps"].append(p["next"])
                p["last"] += p["next"]
                p["next"] = int(LAP_BASE[i] * 1000 + random.uniform(-600, 600))
                done = len(p["laps"]) - 1
                if (R["mode"] == 2 and done >= R["raceLaps"]) or (R["mode"] == 1 and R["timeUp"]):
                    p["fin"] = True
        if R["mode"] != 0 and all(p["fin"] for p in R["pilots"]):
            R["state"] = 4
            save_race()


def save_race():
    rid = len(RACES) + 1
    RACES[rid] = {"id": rid, "date": R["date"], "mode": R["mode"], "raceMs": R["raceMs"], "raceLaps": R["raceLaps"],
                  "countdown": R["cd"],
                  "pilots": [{"name": CONFIG["p"][i]["name"], "freq": CONFIG["p"][i]["freq"], "fin": p["fin"], "laps": list(p["laps"])}
                             for i, p in enumerate(R["pilots"])]}


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
            if u.path == "/config":
                return self._json(CONFIG)
            if u.path == "/api/status":
                count = CONFIG["pilots"] if R["state"] == 0 and not any(p["laps"] for p in R["pilots"]) else R["count"]
                elapsed = t - R["start"] if R["state"] in (1, 3) else 0
                return self._json({"state": R["state"], "mode": R["mode"], "cd": int(R["cd"]), "race": R["race"],
                                   "elapsed": elapsed, "raceMs": R["raceMs"], "raceLaps": R["raceLaps"],
                                   "timeUp": int(R["timeUp"]), "stag": 0, "vbat": 41, "saveErr": 0,
                                   "savedId": len(RACES), "savedRace": R["race"] if RACES else 0, "spectrum": 0,
                                   "pilots": [{"rssi": rssi(i, t), "laps": len(R["pilots"][i]["laps"]) if i < len(R["pilots"]) else 0,
                                               "fin": int(R["pilots"][i]["fin"]) if i < len(R["pilots"]) else 0} for i in range(count)]})
            if u.path == "/api/race":
                return self._json({"race": R["race"], "state": R["state"], "mode": R["mode"], "cd": R["cd"], "stag": False,
                                   "raceMs": R["raceMs"], "raceLaps": R["raceLaps"], "date": R["date"],
                                   "pilots": [{"name": CONFIG["p"][i]["name"], "freq": CONFIG["p"][i]["freq"], "fin": p["fin"], "laps": p["laps"]}
                                              for i, p in enumerate(R["pilots"])] or
                                             [{"name": CONFIG["p"][0]["name"], "freq": CONFIG["p"][0]["freq"], "fin": False, "laps": []}]})
            if u.path == "/api/rssi":
                seq = t // 25
                since = int(q.get("since", ["0"])[0])
                if since > seq or seq - since > 239:
                    since = seq - 239
                count = CONFIG["pilots"]
                return self._json({"seq": seq, "step": 25,
                                   "pilots": [[rssi(i, s * 25) for s in range(since + 1, seq + 1)] for i in range(count)]})
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
                    if R["state"] in (1, 2, 3):
                        return self._json({"status": "busy"}, 409)
                    R["specAt"] = time.time()
                    return self._json({"status": "OK"})
                elapsed = time.time() - R.get("specAt", 0)
                total = 61 * 3
                done = min(total, int(elapsed / 3.5 * total))
                running = done < total
                peaks = [(5800, 75), (5880, 55), (5740, 30)]
                vals = [max([55 + random.randint(0, 6)] + [int(55 + h * math.exp(-((5645 + k * 5 - f) ** 2) / 150)) for f, h in peaks])
                        if (done >= 61 or k < done) else 0 for k in range(61)]
                return self._json({"running": running, "done": done, "total": total, "start": 5645, "step": 5, "rssi": vals})
            if u.path == "/api/wifi/saved":
                return self._json({"networks": SAVED, "connected": SAVED[0] if SAVED else "", "max": 5})
            if u.path == "/api/info":
                return self._json({"version": "1.1.0-dev", "mode": "wifi", "ip": "192.168.1.50", "ssid": "Home WiFi",
                                   "host": "laptimer.local", "signal": -55, "maxPilots": 4})
        return super().do_GET()

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        u = urlparse(self.path)
        q = parse_qs(u.query)
        with LOCK:
            if u.path == "/config":
                data = json.loads(body or b"{}")
                CONFIG.update({k: v for k, v in data.items() if k != "p"})
                if "p" in data:
                    CONFIG["p"] = data["p"]
                return self._json({"status": "OK"})
            if u.path == "/timer/start":
                if R["state"] in (1, 2, 3):
                    return self._json({"status": "busy"}, 409)
                R.update({"race": R["race"] + 1, "mode": CONFIG["raceMode"], "cd": CONFIG["countdown"],
                          "raceMs": CONFIG["raceSec"] * 1000, "raceLaps": CONFIG["raceLaps"], "timeUp": False,
                          "count": CONFIG["pilots"], "date": int(q.get("t", ["0"])[0]),
                          "pilots": [{"laps": [], "fin": False, "last": 0} for _ in range(CONFIG["pilots"])]})
                if R["cd"]:
                    R["state"] = 1
                    R["start"] = now_ms() + 3000
                else:
                    R["state"] = 2
                    R["arm"] = now_ms()
                return self._json({"status": "OK"})
            if u.path == "/timer/stop":
                if R["state"] in (1, 2, 3) and any(p["laps"] for p in R["pilots"]):
                    save_race()
                R["state"] = 0
                return self._json({"status": "OK"})
            if u.path == "/timer/clear":
                if R["state"] in (0, 4):
                    R["state"] = 0
                    for p in R["pilots"]:
                        p["laps"] = []
                        p["fin"] = False
                return self._json({"status": "OK"})
            if u.path == "/api/races/clear":
                RACES.clear()
                return self._json({"status": "OK"})
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
            if u.path == "/api/profiles":
                PROFILES[:] = json.loads(body)
                return self._json({"status": "OK"})
            if u.path in ("/restart",):
                return self._json({"status": "OK"})
        return self._json({"status": "OK"})

    def log_message(self, *a):
        pass


ThreadingHTTPServer(("127.0.0.1", 8765), H).serve_forever()
