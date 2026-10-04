"""Checks the kept radio calibration (lib/RADIOCAL) on a real timer, over USB and WiFi.

Usage: python tools/cal_test.py <port> <host>     e.g. COM3 192.168.4.1

Resets the board through the serial port's RTS line (the chip sees a power-on, so it calibrates
in full) and reads /api/debug/load after each start. On a warm board a power-on calibrates
weaker than a good kept calibration, so the recorded code of the best is first set to the
weakest and to the strongest code (/api/debug/calbest) to force both outcomes: "better" (the new
calibration is kept) and "restored" (the best is put back and the timer restarted through deep
sleep). Then a plain power-on and a restart from the page. Leaves the best as the board's last
calibration. On the hotspot the PC's WiFi is nudged back to it (Windows). Needs pyserial.
"""
import json, platform, subprocess, sys, time, urllib.error, urllib.request

import serial

if len(sys.argv) < 3:
    sys.exit(__doc__)
PORT, BASE = sys.argv[1], "http://" + sys.argv[2]
results = []


def req(path, post=False, timeout=5):
    r = urllib.request.Request(BASE + path, data=b"" if post else None, method="POST" if post else "GET")
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            text = resp.read()
            return resp.status, (json.loads(text) if text else None)
    except urllib.error.HTTPError as e:
        return e.code, None


def check(name, ok, detail=""):
    results.append(ok)
    print(("PASS " if ok else "FAIL ") + name + (f"  [{detail}]" if detail else ""), flush=True)


def reset_board():
    s = serial.Serial()
    s.port, s.baudrate = PORT, 115200
    s.dtr = False
    s.rts = True  # EN low
    s.open()
    time.sleep(0.1)
    s.rts = False
    time.sleep(0.2)
    s.close()


def wait_up(ssid, seconds=120):
    time.sleep(3)
    end = time.time() + seconds
    last_nudge = time.time()
    while time.time() < end:
        try:
            urllib.request.urlopen(BASE + "/api/info", timeout=2).read()
            return True
        except Exception:
            if ssid and platform.system() == "Windows" and time.time() - last_nudge > 10:
                subprocess.run(["netsh", "wlan", "connect", f"name={ssid}"], capture_output=True)
                last_nudge = time.time()
            time.sleep(1)
    return False


def load():
    st, l = req("/api/debug/load")
    return l or {}


def show(tag, l):
    print(f"  {tag}: cal={l.get('cal')} calibrated={l.get('txAnaCal')} best={l.get('calBest')} using={str(l.get('txAnaGain'))[-2:]} rst={l.get('rst')}")


def start_and_read(ssid, how):
    if how == "power-on":
        reset_board()
    else:
        req("/restart", post=True)
    if not wait_up(ssid):
        print("the timer did not come back")
        return {}
    time.sleep(2)
    l = load()
    show(how, l)
    return l


_, info = req("/api/info")
ssid = info.get("ssid") if info and info.get("mode") == "hotspot" else None
l0 = load()
show("before", l0)
check("the start reports its calibration outcome", l0.get("cal") in ("reused", "restored", "adopted", "better", "same"), l0.get("cal"))

st, _ = req("/api/debug/calbest?code=0x00", post=True)
check("best's code set to the weakest (diagnostics)", st == 200, st)
l = start_and_read(ssid, "power-on")
check("power-on calibrates stronger than the recorded best: kept as the new best",
      l.get("cal") == "better" and l.get("txAnaCal") == l.get("calBest"), (l.get("cal"), l.get("txAnaCal"), l.get("calBest")))

st, _ = req("/api/debug/calbest?code=0x7f", post=True)
check("best's code set to the strongest (diagnostics)", st == 200, st)
l = start_and_read(ssid, "power-on")
check("power-on calibrates weaker than the best: best put back, restarted through deep sleep",
      l.get("cal") == "restored" and l.get("rst") == 8 and l.get("txAnaCal") == l.get("calBest"),
      (l.get("cal"), l.get("rst"), l.get("txAnaCal"), l.get("calBest")))

l = start_and_read(ssid, "power-on")
check("plain power-on: a known outcome, the calibration in use is the best",
      l.get("cal") in ("same", "better", "restored") and l.get("txAnaCal") == l.get("calBest"),
      (l.get("cal"), l.get("txAnaCal"), l.get("calBest")))

l = start_and_read(ssid, "restart")
check("restart from the page: the best reused without calibrating",
      l.get("cal") == "reused" and l.get("rst") == 8 and l.get("txAnaCal") == l.get("calBest"),
      (l.get("cal"), l.get("rst"), l.get("txAnaCal"), l.get("calBest")))

print(f"\n{sum(results)}/{len(results)} passed")
sys.exit(0 if all(results) else 1)
