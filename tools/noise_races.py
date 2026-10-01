"""Records test races on a real timer without a drone, for trying History, the chart, rename
and the race image. Enter/Exit go just inside the RSSI noise, so noise counts as gate passes
(laps from the minimum lap time up). All settings are restored afterwards; the races stay in
the history, named "Test · ...", until History -> Delete all (or the next web-files upload,
which deletes the history: record them after it).

Usage: python tools/noise_races.py <host>        e.g. 192.168.2.221 (takes about 6 minutes)
       python tools/noise_races.py <host> --one  only the practice with a target (about 1 minute)
       python tools/noise_races.py <host> --thresholds
           a test (about 2 minutes, saves one race): another pilot picked on the same channel
           during a race leaves the flying pilot's Enter/Exit alone, while the flying pilot's
           own change applies at once (calibrating during a race)

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


# Tried when the pilot's channel is too quiet: the timer keeps Enter at 51 or more (the page's
# slider range), so the noise must reach 52 to count as passes
CHANNELS = (5800, 5740, 5880, 5917, 5843, 5769, 5732, 5695, 5658)
ENTER_MIN = 51


def noise_on(freq):
    """The noise on a channel: sorted 25 ms maxima from the 3 s after tuning to it."""
    seq = req("/api/rssi?since=0")[1]["seq"]
    req("/config", {"freq": freq})
    time.sleep(3)
    return sorted(req(f"/api/rssi?since={seq}")[1]["rssi"][8:])  # the first readings are from the retune


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


def thresholds_test(base):
    """Laps counted in 30 s after another pilot (Enter 250) is picked, then after the flying
    pilot's own Enter goes to 250: some, then none. Returns True when both hold."""
    name = "Test · thresholds"
    req("/config", {**base, "raceMode": 0, "name": name})
    time.sleep(1.5)
    req(f"/timer/start?t={int(time.time())}", {})
    race_id = status()["race"]
    for _ in range(90):  # the start pass and a lap from the noise
        if status()["laps"] >= 2:
            break
        time.sleep(1)

    def laps_in(settings, seconds=30):
        req("/config", settings)
        time.sleep(1)
        n0 = status()["laps"]
        time.sleep(seconds)
        return status()["laps"] - n0

    other = laps_in({"name": "Other pilot", "enterRssi": 250, "exitRssi": 249})
    own = laps_in({"name": name, "enterRssi": 250, "exitRssi": 249})
    req("/timer/stop", {})
    for _ in range(40):
        s = status()
        if s["savedRace"] == race_id:
            req("/api/races/rename", {"id": s["savedId"], "name": name})
            break
        time.sleep(0.25)
    ok_other, ok_own = other > 0, own == 0
    print(("PASS" if ok_other else "FAIL") + f" another pilot picked (same channel, Enter 250): laps still counted ({other} in 30 s)")
    print(("PASS" if ok_own else "FAIL") + f" the flying pilot's own Enter 250: applies at once ({own} laps in 30 s)")
    return ok_other and ok_own


s = status()
if s["state"] in (1, 2, 3):
    sys.exit("A race is running: stop it first.")
_, original = req("/config")
try:
    base = None
    for freq in (original["freq"],) + tuple(c for c in CHANNELS if c != original["freq"]):
        values = noise_on(freq)
        if not values or values[-1] <= ENTER_MIN:
            print(f"  {freq} MHz: noise {values[0] if values else '-'}-{values[-1] if values else '-'}, too quiet")
            continue
        enter = max(values[int(len(values) * 0.97)], values[0] + 1, ENTER_MIN)
        print(f"Noise on {freq} MHz {values[0]}-{values[-1]}: Enter {enter}, Exit {enter - 1}"
              f" (yours: {original['freq']} MHz, {original['enterRssi']}/{original['exitRssi']})")
        base = {"freq": freq, "enterRssi": enter, "exitRssi": enter - 1, "countdown": False, "target": 0}
        break
    if not base:
        raise SystemExit("No channel is noisy enough here to make passes from noise: fly a lap instead.")
    if "--thresholds" in sys.argv[2:]:
        passed = thresholds_test(base)
        raise SystemExit(0 if passed else 1)  # the settings are restored below
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
