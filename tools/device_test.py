"""API checks against a real timer (no drone needed). Restores the settings afterwards.

Usage: python tools/device_test.py <host>     e.g. 192.168.1.50 (the IP is faster than laptimer.local)

Covers settings round trips, race start/stop/clear, race vs channel scan, history,
saved pilots limits and the WiFi password never being sent. Lap detection itself
needs a drone flying through the gate.
"""
import json, sys, time, urllib.error, urllib.request

if len(sys.argv) < 2:
    sys.exit(__doc__)
BASE = "http://" + sys.argv[1]
results = []


def req(path, body=None, raw=None, timeout=8):
    data = raw if raw is not None else (None if body is None else json.dumps(body).encode())
    r = urllib.request.Request(BASE + path, data=data, method="POST" if data is not None else "GET",
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            text = resp.read()
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def status():
    return req("/api/status")[1]


def wait_scan_done(limit=10):
    end = time.time() + limit
    while time.time() < end and status()["spectrum"]:
        time.sleep(0.3)


_, original = req("/config")
_, profiles = req("/api/profiles")
try:
    # settings: partial updates keep everything else, revision counts changes
    rev0 = status()["cfg"]
    st, answer = req("/config", {"countdown": not original["countdown"]})
    _, c = req("/config")
    same = all(c[k] == original[k] for k in original if k != "countdown")
    check("partial settings save keeps the rest", st == 200 and same and c["countdown"] != original["countdown"])
    check("settings revision increases and is returned", answer.get("rev", 0) > rev0 and status()["cfg"] == answer["rev"],
          (rev0, answer.get("rev")))
    raw = urllib.request.urlopen(BASE + "/config", timeout=5).read().decode()
    check("WiFi password never sent", '"pwd"' not in raw)
    req("/config", {"countdown": False, "raceMode": 0})

    # race vs channel scan, in every order
    st, _ = req("/api/spectrum?start=1")
    time.sleep(0.4)
    st2, _ = req("/timer/start", {})
    time.sleep(0.4)
    s = status()
    check("start during a scan: race starts, scan cancelled", st == 200 and st2 == 200 and s["state"] == 2 and s["spectrum"] == 0,
          (st, st2, s["state"], s["spectrum"]))
    st, _ = req("/api/spectrum?start=1")
    check("scan refused while waiting for the first pass", st == 409, st)
    req("/timer/stop", {})
    time.sleep(0.3)

    req("/config", {"countdown": True})
    time.sleep(1.2)
    req("/timer/start", {})
    time.sleep(0.3)
    st, _ = req("/api/spectrum?start=1")
    check("scan refused during the countdown", st == 409 and status()["state"] == 1, st)
    time.sleep(3.2)
    st, _ = req("/api/spectrum?start=1")
    check("scan refused while racing", st == 409 and status()["state"] == 3, st)
    st, _ = req("/timer/start", {})
    check("second start refused while racing", st == 409, st)
    st, _ = req("/timer/clear", {})
    check("clear refused while racing", st == 409, st)
    req("/timer/stop", {})
    time.sleep(0.3)
    st, _ = req("/api/spectrum?start=1")
    wait_scan_done()
    _, spec = req("/api/spectrum")
    check("scan works again after the race", st == 200 and len(spec["rssi"]) == 61)
    req("/config", {"countdown": original["countdown"]})

    # race data and history
    _, race = req("/api/race")
    check("race data has names, edits, staggered flag", all(k in race for k in ("edits", "stag")) and
          all("name" in p for p in race["pilots"]))
    st, _ = req("/api/races/edit", {"id": 999999, "pilot": 0, "op": 0, "lap": 1})
    check("editing a missing race refused", st == 400, st)
    t0 = time.time()
    st, races = req("/api/races")
    check("history list fast", st == 200 and time.time() - t0 < 1, f"{len(races)} races")

    # saved pilots limits
    big = b"[" + b",".join([b'{"name":"xxxxxxxxxxxxxxxxxxxx","freq":5800,"enter":120,"exit":100}'] * 400) + b"]"
    st, _ = req("/api/profiles", raw=big)
    check("oversized saved-pilot upload refused, timer fine", st == 400 and req("/api/info")[0] == 200, st)
finally:
    req("/config", {k: original[k] for k in original})
    req("/api/profiles", profiles)
    time.sleep(1.5)
    _, now = req("/config")
    check("settings restored", all(now[k] == original[k] for k in original))

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
