"""Sends one DHCP DISCOVER (or REQUEST) with a made-up client MAC, to test the timer's hotspot
DHCP server (lib/HOTSPOTDHCP) from a PC that is on the hotspot.

Usage:
  python tools/fake_dhcp.py <this PC's address on the hotspot> <made-up MAC> [request <ip>]
  e.g. python tools/fake_dhcp.py 192.168.4.10 02:00:00:00:00:03
       python tools/fake_dhcp.py 192.168.4.10 02:00:00:00:00:07 request 192.168.4.5

The reply goes to the made-up MAC, so this PC never sees it: the result is in the timer's
GET /api/debug/aplog (3 offered, 1 assigned, 4 refused, 5 in use by another device).
To test an address held by a device the server doesn't know, give the PC's hotspot adapter
a fixed address first (Windows: netsh interface ip set address "Wi-Fi 2" static 192.168.4.5
255.255.255.0 192.168.4.1; back with: ... set address "Wi-Fi 2" dhcp), then ask for it.
"""
import os
import socket
import sys

if len(sys.argv) < 3:
    sys.exit(__doc__)
src = sys.argv[1]
mac = bytes(int(x, 16) for x in sys.argv[2].split(":"))
request_ip = sys.argv[4] if len(sys.argv) > 4 and sys.argv[3] == "request" else None

msg = bytearray(240)
msg[0] = 1  # BOOTREQUEST
msg[1] = 1  # Ethernet
msg[2] = 6  # MAC length
msg[4:8] = os.urandom(4)  # xid
msg[28:34] = mac
msg[236:240] = bytes([99, 130, 83, 99])  # magic cookie
opts = bytearray()
if request_ip:
    opts += bytes([53, 1, 3])  # REQUEST
    opts += bytes([50, 4]) + socket.inet_aton(request_ip)
else:
    opts += bytes([53, 1, 1])  # DISCOVER
opts += bytes([55, 3, 1, 3, 6, 255])  # parameter list, end
msg += opts
msg += bytes(max(0, 300 - len(msg)))  # BOOTP minimum

s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    s.bind((src, 68))
except OSError:
    s.bind((src, 0))  # the PC's DHCP client holds port 68: any port will do, the server ignores it
s.sendto(bytes(msg), ("255.255.255.255", 67))
print("sent", "REQUEST " + request_ip if request_ip else "DISCOVER", "from", src, "as", sys.argv[2])
