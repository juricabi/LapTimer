"""API checks against a real timer (no drone needed). Restores the settings afterwards.

Usage: python tools/device_test.py <host>     e.g. 192.168.1.50 (the IP is faster than laptimer.local)

Covers settings round trips and checks (pace target too), race start/stop/clear, race vs
channel scan, history, lap-fix conflicts and race names, saved pilots and the WiFi password
never being sent. Lap detection itself needs a drone flying through the gate; renaming a race
needs a saved race (fly one lap first: a web-files update deletes the history).
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
    print(("PASS " if ok else "FAIL ") + name + (f"  [{ascii(detail)}]" if detail else ""), flush=True)


def status():
    return req("/api/status")[1]


def wait_scan_done(limit=10):
    end = time.time() + limit
    while time.time() < end and status()["spectrum"]:
        time.sleep(0.3)


TEST_PILOT = "Device Test Pilot"
WIFI_TEST = "device_test"  # a WiFi entry it tries (and removes)
_, original = req("/config")
try:
    # settings: partial updates keep everything else, revision counts changes
    s0 = status()
    rev0 = s0["cfg"]
    st, answer = req("/config", {"countdown": not original["countdown"]})
    _, c = req("/config")
    same = all(c[k] == original[k] for k in original if k not in ("countdown", "rev"))
    check("partial settings save keeps the rest", st == 200 and same and c["countdown"] != original["countdown"])
    check("settings revision increases, reply has base and rev",
          answer.get("base") == rev0 and answer.get("rev", 0) == rev0 + 1 and status()["cfg"] == answer["rev"],
          (rev0, answer))
    check("status has boot id, saved-pilot revision, rssi and laps",
          s0.get("boot", 0) > 0 and all(k in s0 for k in ("prof", "rssi", "laps", "fin")) and status()["boot"] == s0["boot"])
    # transmitter held (classic ESP32, docs/hotspot.md): power loop off, gain byte 19, and the
    # start-up analog gain never weaker than 0x5f: a code of libphy's table, where the number
    # says nothing about strength (0x7f +2.5 dB, 0x6f +1.25, 0x5f 0, 0x5a -4.5, 0x75 -8.5)
    _, load = req("/api/debug/load")
    ana = int(load.get("txAnaGain", "0"), 16) & 0xFF
    check("transmitter held: power loop off, gain 19, analog gain 0x5f or stronger",
          load.get("txLoop") == 0 and load.get("txGain") == 19 and ana in (0x7F, 0x6F, 0x5F), load)
    # every start goes through 1 ms of deep sleep, so the radio uses its stored calibration
    # instead of calibrating again on a warm board (esp_reset_reason 8: woke from deep sleep)
    check("this start used the stored radio calibration (woke from deep sleep)", load.get("rst") == 8, load.get("rst"))
    _, graph = req("/api/rssi?since=0")
    check("RSSI history is one series", isinstance(graph.get("rssi"), list) and len(graph["rssi"]) > 0)
    raw = urllib.request.urlopen(BASE + "/config", timeout=5).read().decode()
    check("WiFi password never sent", '"pwd"' not in raw)
    req("/config", {"countdown": False, "raceMode": 0})

    # settings checks: exit stays below enter, names cut at whole characters
    req("/config", {"exitRssi": original["enterRssi"] + 5})
    _, c = req("/config")
    check("exit kept below enter", c["exitRssi"] < c["enterRssi"], (c["enterRssi"], c["exitRssi"]))
    req("/config", {"name": "ŠĐČĆŽšđčćžŠĐČĆŽ"})
    name = req("/config")[1]["name"]
    check("long name cut at a whole character", name == "ŠĐČĆŽšđčćž", name)

    # pace target: 0 = off, otherwise kept within 3-600 s; saving other settings leaves it alone
    check("settings have the pace target and its announce switch", "target" in original and "anTarget" in original, sorted(original))
    # a lap is compared with the best lap or with the target, never both: the one switched on wins
    req("/config", {"anDelta": True})
    req("/config", {"anTarget": True})
    a = req("/config")[1]
    req("/config", {"anDelta": True})
    b = req("/config")[1]
    req("/config", {"anDelta": True, "anTarget": True})
    c = req("/config")[1]
    got = [a["anDelta"], a["anTarget"], b["anDelta"], b["anTarget"], c["anDelta"], c["anTarget"]]
    check("delta to the best lap and to the target never both on", got == [False, True, True, False, False, True], got)
    targets = []
    for value in (45000, 1000, 999999, 0):
        req("/config", {"target": value})
        targets.append(req("/config")[1].get("target"))
    check("pace target kept within 3-600 s, 0 = off", targets == [45000, 3000, 600000, 0], targets)
    req("/config", {"target": 45000})
    req("/config", {"countdown": not original["countdown"]})
    check("other settings leave the pace target alone", req("/config")[1].get("target") == 45000)
    req("/config", {"anType": 7})
    an_type = req("/config")[1]["anType"]
    check("announce type kept within the page's five choices", 0 <= an_type <= 4, an_type)
    req("/config", {"anType": original["anType"]})
    req("/config", {k: original[k] for k in original})

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

    req("/config", {"countdown": True, "target": 45000})
    time.sleep(1.2)
    at_start = req("/config")[1]  # the settings this race takes

    def race_view():
        """The race as the timer reports it (race data and status), to compare with at_start."""
        _, r = req("/api/race")
        s = status()
        p = r["pilots"][0]
        return {"name": p["name"], "freq": p["freq"], "mode": r["mode"], "cd": bool(r["cd"]), "raceMs": r["raceMs"],
                "raceLaps": r["raceLaps"], "target": r.get("target", 0),
                "status": [s["mode"], bool(s["cd"]), s["raceMs"], s["raceLaps"]]}

    expected = {"name": at_start["name"], "freq": at_start["freq"], "mode": at_start["raceMode"], "cd": True,
                "raceMs": at_start["raceSec"] * 1000, "raceLaps": at_start["raceLaps"], "target": 45000,
                "status": [at_start["raceMode"], True, at_start["raceSec"] * 1000, at_start["raceLaps"]]}
    req("/timer/start", {})
    time.sleep(0.3)
    req("/config", {"target": 30000})  # a change during the race applies from the next one
    race_target = req("/api/race")[1].get("target")
    check("race keeps the pace target it started with", race_target == 45000, race_target)
    st, _ = req("/api/spectrum?start=1")
    check("scan refused during the countdown", st == 409 and status()["state"] == 1, st)
    time.sleep(3.2)
    st, _ = req("/api/spectrum?start=1")
    check("scan refused while racing", st == 409 and status()["state"] == 3, st)
    # every race setting changed during the race (this phone or another one): the race keeps its own
    req("/config", {"name": "Mid Race Pilot", "freq": 5658 if at_start["freq"] != 5658 else 5800,
                    "raceMode": (at_start["raceMode"] + 1) % 3, "raceSec": 300 if at_start["raceSec"] != 300 else 240,
                    "raceLaps": 9 if at_start["raceLaps"] != 9 else 8, "countdown": False})
    got = race_view()
    check("race keeps pilot, channel, mode, limits, countdown and target when settings change", got == expected, got)
    st, _ = req("/timer/start", {})
    check("second start refused while racing", st == 409, st)
    st, _ = req("/timer/clear", {})
    check("clear refused while racing", st == 409, st)
    st, _ = req("/api/profiles/save", {"name": TEST_PILOT, "freq": 5800, "enter": 120, "exit": 100})
    check("saved pilots refused while racing (flash write)", st == 409, st)
    st, _ = req("/api/races/rename", {"id": 1, "name": "During the race"})
    check("race rename refused while racing (flash write)", st == 409, st)
    # only against a firmware that has the guard: on one without, this erases the stored radio
    # calibration and the next start stores a new one, weaker if the board is warm
    st, _ = req("/api/debug/phyerase", {})
    check("radio calibration erase refused while racing (flash write)", st == 409, st)
    boot0 = status()["boot"]
    st, _ = req("/restart", {})
    time.sleep(1.5)
    if st == 200:  # restarted (older firmware): wait until it is back
        for _ in range(40):
            try:
                if status()["boot"] != boot0:
                    break
            except Exception:
                pass
            time.sleep(1)
    check("restart refused while racing (the race would be lost)", st == 409 and status()["boot"] == boot0, st)
    req("/timer/stop", {})
    time.sleep(0.3)
    got = race_view()
    next_race = req("/config")[1]
    check("after Stop the race keeps all its settings, the next race takes the new ones",
          got == expected and next_race["target"] == 30000 and next_race["name"] == "Mid Race Pilot", (got, next_race["target"]))
    req("/config", {k: original[k] for k in original})
    st, _ = req("/api/spectrum?start=1")
    wait_scan_done()
    _, spec = req("/api/spectrum")
    check("scan works again after the race", st == 200 and len(spec["rssi"]) == 61)
    req("/config", {"countdown": original["countdown"]})

    # race data and history
    _, race = req("/api/race")
    check("race data has one pilot with name and laps", "edits" in race and len(race["pilots"]) == 1 and
          all(k in race["pilots"][0] for k in ("name", "freq", "laps")))
    st, _ = req("/api/races/edit", {"id": 999999, "pilot": 0, "op": 0, "lap": 1})
    check("editing a missing race refused", st == 400, st)
    t0 = time.time()
    st, races = req("/api/races")
    check("history list fast", st == 200 and time.time() - t0 < 1, f"{len(races)} races")
    if races:
        newest = max(races, key=lambda r: r["id"])
        _, saved = req(f"/api/races?id={newest['id']}")
        pilot = next((i for i, p in enumerate(saved["pilots"]) if len(p["laps"]) > 1), None)
        if pilot is not None:
            laps = saved["pilots"][pilot]["laps"]
            st, _ = req("/api/races/edit", {"id": newest["id"], "pilot": pilot, "op": 0, "lap": 1, "expect": laps[1] + 1})
            _, after = req(f"/api/races?id={newest['id']}")
            check("stale lap fix refused, race unchanged", st == 409 and after["pilots"][pilot]["laps"] == laps, st)

    # race names: cut at a whole character (32 bytes), an empty name goes back to the date
    st, _ = req("/api/races/rename", {"id": 999999, "name": "Missing"})
    check("renaming a missing race refused", st == 400, st)
    if races:
        rid = max(races, key=lambda r: r["id"])["id"]
        _, before = req(f"/api/races?id={rid}")
        long_name = "A" + "ŠĐČĆŽšđčćžŠĐČĆŽš"  # 1 + 16 two-byte characters = 33 bytes
        st, _ = req("/api/races/rename", {"id": rid, "name": long_name})
        _, after = req(f"/api/races?id={rid}")
        listed = next((r for r in req("/api/races")[1] if r["id"] == rid), {})
        check("race renamed, name cut at a whole character, in the list too",
              st == 200 and after.get("name") == long_name[:16] and listed.get("name") == long_name[:16] and
              after["pilots"] == before["pilots"], (st, after.get("name"), listed.get("name")))
        st, _ = req("/api/races/rename", {"id": rid, "name": ""})
        _, after = req(f"/api/races?id={rid}")
        listed = next((r for r in req("/api/races")[1] if r["id"] == rid), {})
        check("empty race name goes back to the date", st == 200 and "name" not in after and "name" not in listed, after.get("name"))
        if before.get("name"):
            req("/api/races/rename", {"id": rid, "name": before["name"]})
    else:
        print("SKIP race rename: no saved race (fly one lap, then run this again)", flush=True)

    # saved pilots: one at a time, names match without case, rename replaces, pace target kept
    st, _ = req("/api/profiles/save", {"name": TEST_PILOT, "freq": 5800, "enter": 400, "exit": 300})
    mine = next((p for p in req("/api/profiles")[1] if p["name"] == TEST_PILOT), {})
    check("saved pilot thresholds kept within the sliders (Enter 400 -> 255, not 144)",
          st == 200 and mine.get("enter") == 255 and mine.get("exit") == 254, (st, mine))
    st, _ = req("/api/profiles/save", {"name": TEST_PILOT, "freq": 7000, "enter": 120, "exit": 100})
    check("saved pilot on a channel outside 5.8 GHz refused", st == 400, st)
    req("/api/profiles/remove", {"name": TEST_PILOT})
    prof0 = status()["prof"]
    st, _ = req("/api/profiles/save", {"name": TEST_PILOT, "freq": 5800, "enter": 120, "exit": 100, "target": 45000})
    st2, _ = req("/api/profiles/save", {"name": TEST_PILOT.upper(), "freq": 5880, "enter": 130, "exit": 140})
    mine = [p for p in req("/api/profiles")[1] if p["name"].lower() == TEST_PILOT.lower()]
    check("saved pilot added and updated once (no target: none stored)", st == 200 and st2 == 200 and len(mine) == 1 and
          mine[0]["freq"] == 5880 and mine[0]["exit"] < mine[0]["enter"] and "target" not in mine[0], mine)
    req("/api/profiles/save", {"name": TEST_PILOT + " 2", "prev": TEST_PILOT.upper(), "freq": 5880, "enter": 130, "exit": 110,
                               "target": 1000})
    saved_pilots = req("/api/profiles")[1]
    names = [p["name"] for p in saved_pilots]
    check("rename replaces the saved pilot", TEST_PILOT + " 2" in names and TEST_PILOT.upper() not in names, names)
    renamed = next((p for p in saved_pilots if p["name"] == TEST_PILOT + " 2"), {})
    check("saved pilot keeps its pace target (within 3-600 s)", renamed.get("target") == 3000, renamed)
    check("saved-pilot revision changes", status()["prof"] != prof0)
    # WiFi: with a password the timer joins WPA2 only (8-63 characters or 64 hex digits): other
    # lengths could never be joined, so they are refused (no change to the list)
    nets_before = req("/api/wifi/saved")[1]["networks"]
    st1, _ = req("/api/wifi/saved/add", {"ssid": WIFI_TEST + " short", "pwd": "1234567"})
    st2, _ = req("/api/wifi/saved/add", {"ssid": WIFI_TEST + " long", "pwd": "x" * 64})
    nets_after = req("/api/wifi/saved")[1]["networks"]
    check("WiFi passwords the timer can't use refused (7 characters, 64 not hex)",
          st1 == 400 and st2 == 400 and nets_after == nets_before, (st1, st2, nets_after))
finally:
    for suffix in (" short", " long"):  # if an older firmware took them
        req("/api/wifi/saved/remove", {"ssid": WIFI_TEST + suffix})
    req("/config", {k: original[k] for k in original})
    for n in (TEST_PILOT, TEST_PILOT + " 2"):
        req("/api/profiles/remove", {"name": n})
    time.sleep(1.5)
    _, now = req("/config")
    check("settings restored", all(now[k] == original[k] for k in original if k != "rev"))

print(f"\n{sum(results)}/{len(results)} checks passed")
sys.exit(0 if all(results) else 1)
