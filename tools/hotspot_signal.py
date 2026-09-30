"""Logs the timer's hotspot beacon strength (dBm) from a Windows PC's WiFi adapter.

Usage:
  python tools/hotspot_signal.py [seconds] [period] [adapter]
  e.g. python tools/hotspot_signal.py 900 10 "AR9287"

Every <period> seconds it asks the adapter for a fresh scan (WlanScan) and prints the RSSI of
the LapTimer hotspot and of the other networks it heard, as a reference. "gone" means the
hotspot wasn't heard in that scan. The adapter can stay connected to another network, so the
hotspot is measured without a client. Windows' "Signal %" is smoothed and hides fading; this
reads the dBm of each beacon. <adapter> is part of the adapter's description (default: first).
"""
import ctypes
import ctypes.wintypes as wt
import sys
import time

wlan = ctypes.windll.wlanapi


class GUID(ctypes.Structure):
    _fields_ = [("d1", wt.DWORD), ("d2", wt.WORD), ("d3", wt.WORD), ("d4", ctypes.c_ubyte * 8)]


class IFACE_INFO(ctypes.Structure):
    _fields_ = [("guid", GUID), ("desc", ctypes.c_wchar * 256), ("state", ctypes.c_int)]


class IFACE_LIST(ctypes.Structure):
    _fields_ = [("n", wt.DWORD), ("idx", wt.DWORD), ("items", IFACE_INFO * 8)]


class SSID(ctypes.Structure):
    _fields_ = [("len", wt.ULONG), ("ssid", ctypes.c_ubyte * 32)]


class RATESET(ctypes.Structure):
    _fields_ = [("len", wt.ULONG), ("rates", wt.USHORT * 126)]


class BSS(ctypes.Structure):
    _fields_ = [("ssid", SSID), ("phyId", wt.ULONG), ("bssid", ctypes.c_ubyte * 6), ("bssType", ctypes.c_int),
                ("phyType", ctypes.c_int), ("rssi", wt.LONG), ("quality", wt.ULONG), ("inReg", ctypes.c_ubyte),
                ("beaconPeriod", wt.USHORT), ("ts", ctypes.c_ulonglong), ("hostTs", ctypes.c_ulonglong),
                ("cap", wt.USHORT), ("freq", wt.ULONG), ("rates", RATESET), ("ieOff", wt.ULONG), ("ieSize", wt.ULONG)]


class BSS_LIST(ctypes.Structure):
    _fields_ = [("size", wt.DWORD), ("n", wt.DWORD), ("items", BSS * 64)]


def filetime_now():
    ft = wt.FILETIME()
    ctypes.windll.kernel32.GetSystemTimeAsFileTime(ctypes.byref(ft))
    return (ft.dwHighDateTime << 32) | ft.dwLowDateTime


def main():
    seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 600
    period = max(5.0, float(sys.argv[2])) if len(sys.argv) > 2 else 10
    want = sys.argv[3] if len(sys.argv) > 3 else ""

    handle, version = wt.HANDLE(), wt.DWORD()
    if wlan.WlanOpenHandle(2, None, ctypes.byref(version), ctypes.byref(handle)) != 0:
        sys.exit("No WLAN service")
    ifaces = ctypes.POINTER(IFACE_LIST)()
    wlan.WlanEnumInterfaces(handle, None, ctypes.byref(ifaces))
    guid = None
    for i in range(ifaces.contents.n):
        item = ifaces.contents.items[i]
        if want.lower() in item.desc.lower():
            guid, name = item.guid, item.desc
            break
    if guid is None:
        sys.exit(f"No WiFi adapter matching '{want}'")
    print(f"adapter: {name}")

    start = time.time()
    while time.time() - start < seconds:
        asked = filetime_now()
        wlan.WlanScan(handle, ctypes.byref(guid), None, None, None)
        time.sleep(4)  # a scan takes ~3 s
        found = ctypes.POINTER(BSS_LIST)()
        timer, others = None, []
        if wlan.WlanGetNetworkBssList(handle, ctypes.byref(guid), None, 3, False, None, ctypes.byref(found)) == 0:
            for i in range(min(found.contents.n, 64)):
                bss = found.contents.items[i]
                if bss.hostTs < asked:
                    continue  # not heard in this scan
                ssid = bytes(bss.ssid.ssid[:bss.ssid.len]).decode("utf-8", "replace")
                if ssid.startswith("LapTimer"):
                    timer = bss.rssi if timer is None else max(timer, bss.rssi)
                else:
                    others.append(bss.rssi)
            wlan.WlanFreeMemory(found)
        ref = f"strongest other {max(others)} dBm" if others else "no other network"
        shown = f"{timer} dBm" if timer is not None else "gone"
        print(f"{time.time() - start:6.0f}s {time.strftime('%H:%M:%S')}  hotspot {shown:>8}  ({ref})", flush=True)
        time.sleep(max(0.0, period - 4))


if __name__ == "__main__":
    main()
