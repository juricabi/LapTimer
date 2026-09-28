"""Records every pilot's RSSI (25 ms steps) and the passes the timer counts, for tuning.

Usage: python tools/rssi_log.py <host> <seconds> [out.csv]

Prints the signal while any pilot is above its noise floor (one row per 100 ms, the highest
value in it) with the passes marked, then a summary per pilot. The CSV has every 25 ms value.
"""
import csv, json, sys, time, urllib.request

if len(sys.argv) < 3:
    sys.exit(__doc__)
HOST, SECONDS = sys.argv[1], float(sys.argv[2])
OUT = sys.argv[3] if len(sys.argv) > 3 else None


def get(path):
    return json.loads(urllib.request.urlopen(f"http://{HOST}{path}", timeout=4).read())


config = get("/config")
names = [p["name"] or f"Pilot {i + 1}" for i, p in enumerate(config["p"])]
series = None  # per pilot: list of (seq, value)
passes = []    # (seq, pilot, lap number)
seq = get("/api/rssi?since=0")["seq"]
last_counts = None
end = time.time() + SECONDS
while time.time() < end:
    time.sleep(0.3)
    r = get(f"/api/rssi?since={seq}")
    if series is None:
        series = [[] for _ in r["pilots"]]
    for i, values in enumerate(r["pilots"][: len(series)]):
        start = r["seq"] - len(values) + 1
        series[i].extend((start + k, v) for k, v in enumerate(values))
    seq = r["seq"]
    counts = [p["laps"] for p in get("/api/status")["pilots"]]
    if last_counts is not None:
        for i, (a, b) in enumerate(zip(last_counts, counts)):
            if b > a:
                passes.append((seq, i, b - 1))
    last_counts = counts

enter = [p["enter"] for p in config["p"]]
exit_ = [p["exit"] for p in config["p"]]
n = len(series)
floor = [sorted(v for _, v in s)[len(s) // 2] if s else 0 for s in series]
first = min(s[0][0] for s in series if s)
last = max(s[-1][0] for s in series if s)
by_seq = [dict(s) for s in series]

print("time    " + "  ".join(f"{names[i][:10]:>10}" for i in range(n)))
for block in range(first, last + 1, 4):  # 4 x 25 ms = 100 ms per row
    row = []
    loud = False
    for i in range(n):
        vals = [by_seq[i][q] for q in range(block, block + 4) if q in by_seq[i]]
        v = max(vals) if vals else 0
        loud |= v > floor[i] + 10
        row.append(v)
    marks = [f"PASS {names[i]} #{lap}" for q, i, lap in passes if block <= q < block + 4]
    if loud or marks:
        t = (block - first) * 0.025
        cells = "  ".join(f"{v:>4} {'#' * max(0, (v - floor[i]) // 8):<6}" for i, v in enumerate(row))
        print(f"{t:6.1f}s  {cells}  {' '.join(marks)}")

print()
for i in range(n):
    vals = [v for _, v in series[i]]
    above = sum(1 for v in vals if v >= enter[i]) * 25
    print(f"{names[i]}: floor {floor[i]}, max {max(vals)}, enter {enter[i]} / exit {exit_[i]}, "
          f"{above} ms at or above enter, passes counted: {sum(1 for p in passes if p[1] == i)}")
if OUT:
    with open(OUT, "w", newline="") as f:
        w = csv.writer(f)
        w.writerow(["ms"] + names[:n])
        for q in range(first, last + 1):
            w.writerow([(q - first) * 25] + [by_seq[i].get(q, "") for i in range(n)])
    print(f"saved {OUT}")
