"""Records the RSSI (25 ms steps) and the passes the timer counts, for tuning Enter/Exit.

Usage: python tools/rssi_log.py <host> <seconds> [out.csv]

Prints the signal while it is above the noise floor (one row per 100 ms, the highest value
in it) with the passes marked, then a summary. The CSV has every 25 ms value.
"""
import csv, json, sys, time, urllib.request

if len(sys.argv) < 3:
    sys.exit(__doc__)
HOST, SECONDS = sys.argv[1], float(sys.argv[2])
OUT = sys.argv[3] if len(sys.argv) > 3 else None


def get(path):
    return json.loads(urllib.request.urlopen(f"http://{HOST}{path}", timeout=4).read())


config = get("/config")
series = {}  # seq -> value
passes = []  # (seq, pass number)
seq = get("/api/rssi?since=0")["seq"]
last_laps = None
end = time.time() + SECONDS
while time.time() < end:
    time.sleep(0.3)
    r = get(f"/api/rssi?since={seq}")
    start = r["seq"] - len(r["rssi"]) + 1
    series.update((start + k, v) for k, v in enumerate(r["rssi"]))
    seq = r["seq"]
    laps = get("/api/status")["laps"]
    if last_laps is not None and laps > last_laps:
        passes.append((seq, laps - 1))
    last_laps = laps

if not series:
    sys.exit("no data")
values = [series[q] for q in sorted(series)]
floor = sorted(values)[len(values) // 2]
first, last = min(series), max(series)
for block in range(first, last + 1, 4):  # 4 x 25 ms = 100 ms per row
    vals = [series[q] for q in range(block, block + 4) if q in series]
    v = max(vals) if vals else 0
    marks = [f"PASS #{n}" for q, n in passes if block <= q < block + 4]
    if v > floor + 10 or marks:
        print(f"{(block - first) * 0.025:6.1f}s  {v:>4} {'#' * max(0, (v - floor) // 8):<12} {' '.join(marks)}")

above = sum(1 for v in values if v >= config["enterRssi"]) * 25
print(f"\nfloor {floor}, max {max(values)}, enter {config['enterRssi']} / exit {config['exitRssi']}, "
      f"{above} ms at or above enter, passes counted: {len(passes)}")
if OUT:
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ms", "rssi"])
        for q in range(first, last + 1):
            w.writerow([(q - first) * 25, series.get(q, "")])
    print(f"saved {OUT}")
