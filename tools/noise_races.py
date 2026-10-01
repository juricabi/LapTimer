"""Records test races on a real timer without a drone, for trying History, the chart, rename
and the race image. Enter/Exit go just inside the RSSI noise, so noise counts as gate passes
(laps from the minimum lap time up). All settings are restored afterwards; the races stay in
the history, named "Test · ...", until History -> Delete all (or the next web-files upload,
which deletes the history: record them after it).

Usage: python tools/noise_races.py <host>        e.g. 192.168.2.221 (takes about 6 minutes)
       python tools/noise_races.py <host> --one  only the practice with a target (about 1 minute)

Races: a practice with a target, a timed race with countdown and target, a lap race without
a target (shown by its date), a long practice with a "crash" (three laps merged, as if passes
were missed) and a race of one lap. Laps depend on the noise: if few come, the floor moved
(another transmitter nearby, a different place): run it again.
"""
import json, sys, time, urllib.error, urllib.request

if len(sys.argv) < 2:
    sys.exit(__doc__)
BASE = "http://" + sys.argv[1]
STATE_IDLE, STATE_FINISHED = 0, 4


def req(path, body=None, timeout=8):
    data = None if body is None else json.dumps(body).encode()
    r = urllib.request.Request(BASE + path, data=data, method="POST" if data is not None else "GET",
                               headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            text = resp.read()
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def status():
    return req("/api/status")[1]


def noise_thresholds():
    """Enter at the top few percent of the noise (25 ms maxima over 6 s), Exit one below."""
    values = sorted(req("/api/rssi?since=0")[1]["rssi"])
    enter = max(values[int(len(values) * 0.97)], values[0] + 1, 51)
    return enter, enter - 1, (values[0], values[-1])


def race(name, settings, seconds=None, merge_at=None, laps_max=None):
    """Runs one race (practice: for `seconds` or until laps_max laps; timed/laps: until it
    finishes), names it, and merges laps merge_at+1 and +2 into lap merge_at (a long lap, like
    missed passes)."""
    req("/config", settings)
    time.sleep(1.5)  # the timer takes the settings when the race starts
    st, _ = req(f"/timer/start?t={int(time.time())}", {})
    if st != 200:
        print(f"  {name or 'race'}: start refused ({st})")
        return None
    race_id = status()["race"]
    end = time.time() + (seconds or 240)
    while time.time() < end:
        s = status()
        if s["state"] == STATE_FINISHED or (laps_max and s["laps"] > laps_max):  # laps: start pass + laps
            break
        time.sleep(0.2 if laps_max else 1)
    if status()["state"] != STATE_FINISHED:
        req("/timer/stop", {})
    for _ in range(40):  # saved in the background after the race
        s = status()
        if s["savedRace"] == race_id and s["state"] in (STATE_IDLE, STATE_FINISHED):
            break
        time.sleep(0.25)
    s = status()
    if s["savedRace"] != race_id:
        print(f"  {name or 'race'}: no laps, nothing saved")
        return None
    saved_id = s["savedId"]
    if merge_at:
        for _ in range(2):
            laps = req(f"/api/races?id={saved_id}")[1]["pilots"][0]["laps"]
            if len(laps) > merge_at + 1:
                req("/api/races/edit", {"id": saved_id, "pilot": 0, "op": 0, "lap": merge_at, "expect": laps[merge_at]})
    if name:
        req("/api/races/rename", {"id": saved_id, "name": name})
    laps = req(f"/api/races?id={saved_id}")[1]["pilots"][0]["laps"][1:]
    print(f"  {name or '(date)'}: {len(laps)} laps " + " ".join(f"{t / 1000:.2f}" for t in laps))
    return saved_id


s = status()
if s["state"] in (1, 2, 3):
    sys.exit("A race is running: stop it first.")
_, original = req("/config")
enter, exit_, noise = noise_thresholds()
print(f"Noise {noise[0]}-{noise[1]}: Enter {enter}, Exit {exit_} (yours: {original['enterRssi']}/{original['exitRssi']})")
base = {"enterRssi": enter, "exitRssi": exit_, "countdown": False, "target": 0}
try:
    race("Test · practice", {**base, "raceMode": 0, "target": 7000}, seconds=70)
    if "--one" in sys.argv[2:]:
        raise SystemExit(0)  # the settings are restored below
    race("Test · timed 1:00", {**base, "raceMode": 1, "raceSec": 60, "countdown": True, "target": 7500})
    race(None, {**base, "raceMode": 2, "raceLaps": 5})
    race("Test · long practice, crash", {**base, "raceMode": 0, "target": 7000}, seconds=150, merge_at=5)
    race("Test · one lap", {**base, "raceMode": 0}, seconds=30, laps_max=1)
finally:
    req("/config", {k: original[k] for k in original if k != "rev"})
    time.sleep(1.5)
    _, now = req("/config")
    same = all(now[k] == original[k] for k in original if k != "rev")
    print("Settings restored" if same else f"Settings NOT fully restored: {now}")
