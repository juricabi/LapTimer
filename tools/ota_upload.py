"""Uploads firmware and/or web files to a LapTimer over WiFi (ElegantOTA), then waits for it to restart.

Usage:
  python tools/ota_upload.py <host> fw      # .pio/build/PhobosLT/firmware.bin
  python tools/ota_upload.py <host> fs      # .pio/build/PhobosLT/littlefs.bin (clears race history and saved pilots)
  python tools/ota_upload.py <host> fw fs   # both, firmware first

<host> is the timer's IP (fastest) or laptimer.local. Build first:
  pio run -e PhobosLT            (firmware)
  pio run -e PhobosLT -t buildfs (web files)
"""
import hashlib, os, sys, time, urllib.error, urllib.request, uuid

BUILD = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".pio", "build", "PhobosLT")
FILES = {"fw": ("fr", "firmware.bin"), "fs": ("fs", "littlefs.bin")}


def upload(host, kind):
    mode, name = FILES[kind]
    data = open(os.path.join(BUILD, name), "rb").read()
    md5 = hashlib.md5(data).hexdigest()  # the timer rejects a corrupted upload
    urllib.request.urlopen(f"http://{host}/ota/start?mode={mode}&hash={md5}", timeout=10).read()
    boundary = uuid.uuid4().hex
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{name}\"\r\n"
            "Content-Type: application/octet-stream\r\n\r\n").encode() + data + f"\r\n--{boundary}--\r\n".encode()
    req = urllib.request.Request(f"http://{host}/ota/upload", data=body, method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={boundary}"})
    try:
        answer = urllib.request.urlopen(req, timeout=180).read().decode()
    except urllib.error.HTTPError as e:
        sys.exit(f"{name}: rejected ({e.code}) {e.read().decode()} - upload again")
    print(f"{name}: {answer} ({len(data)} bytes)")


def wait_for(host, seconds=90):
    time.sleep(4)
    end = time.time() + seconds
    while time.time() < end:
        try:
            urllib.request.urlopen(f"http://{host}/api/info", timeout=3).read()
            return True
        except Exception:
            time.sleep(2)
    return False


if __name__ == "__main__":
    if len(sys.argv) < 3 or any(k not in FILES for k in sys.argv[2:]):
        sys.exit(__doc__)
    host = sys.argv[1]
    for kind in sys.argv[2:]:
        upload(host, kind)
        if not wait_for(host):
            sys.exit(f"The timer did not come back at {host}. It may have started its own hotspot; see tools/boot_log.py.")
        print("  back online")
