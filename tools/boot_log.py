"""Shows the timer's serial log over USB, optionally restarting it first.

Usage:
  python tools/boot_log.py <port> [seconds] [--reset]
  e.g. python tools/boot_log.py COM3 20 --reset

--reset pulses RTS to restart the board and capture the boot. Without it the lines are held
low, but opening the port can still restart the board with some USB drivers (the owner's
CH340 on Windows does): expect a restart either way. Needs pyserial (PlatformIO's Python).
"""
import sys, time

import serial

if len(sys.argv) < 2:
    sys.exit(__doc__)
sys.stdout.reconfigure(errors="replace")  # boot noise must not crash a Windows console
port = sys.argv[1]
seconds = float(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2][0].isdigit() else 15
reset = "--reset" in sys.argv

s = serial.Serial()
s.port, s.baudrate, s.timeout = port, 460800, 0.2
s.dtr = False
s.rts = reset
s.open()
if reset:
    time.sleep(0.1)
    s.rts = False
end = time.time() + seconds
while time.time() < end:
    data = s.read(4096)
    if data:
        sys.stdout.write(data.decode("utf-8", "replace"))
        sys.stdout.flush()
s.close()
