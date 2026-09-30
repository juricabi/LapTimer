# The timer's hotspot

How the hotspot works, why it used to fade away within minutes, and how that was fixed.
Measured on an ESP32 dev board with an RX5808 on 5800 MHz, powered from USB, with a PC WiFi
adapter 1-2 m away.

## Using it

With no saved networks the hotspot starts right away. Away from your saved networks the timer
looks for them first, then starts its own hotspot
(about 40 s after power-on; a long beep if the buzzer is on). For the next **20 s the receiver is switched off** while
the hotspot's transmit power settles (see below); the live RSSI shows nothing meanwhile. A race
started in those 20 s gets its receiver back at once. So: switch the timer on, connect the
phone, and it's ready by the time you are.

## The fading problem (every version up to v1.1.0)

**Symptom.** Phones dropped from the hotspot after a minute or two, couldn't rejoin for a
while, DHCP and network scans failed, and the range was a few metres. Measured from the PC,
the hotspot's beacons started at about -58 dBm, held for ~90 s, then faded steadily to
-87 dBm, vanished for ~40 s and came back at full strength, every ~4 minutes. The same PC
adapter held the home router at a steady -50 dBm. On the home WiFi the timer worked fine.

**Cause.** The ESP32 keeps its transmit power on target with a closed loop: a detector
measures the output and a background routine in Espressif's radio library
(`tx_pwctrl_background` in libphy) turns the gain up or down about once a second. The tuned
RX5808 leaks into that detector (its synthesizer runs at half the local oscillator,
(channel - 479 MHz) / 2, around 2.4-2.7 GHz, a few centimetres from the ESP32's antenna). The
loop reads its own signal plus the leak, decides the power is too high and turns down; the leak
doesn't shrink, so it keeps turning down until the hotspot is gone. As a station on a router
the radio sleeps between beacons and the loop starts over on every wake-up, so the fade never
builds up there.

**How it was found.** A minimal test firmware (a bare hotspot, nothing else) on the same
board, with the timer's parts switched on one at a time:

| Test firmware | Hotspot beacons |
|---|---|
| Bare hotspot | -56 dBm, steady for 10 min |
| + core 0 busy nonstop (like the timer) | -55 dBm, steady |
| + nonstop `analogRead` on core 1 (like the RSSI sampling) | -55 dBm, steady |
| + RX5808 tuned to 5800 MHz | -73 → -89 dBm, gone, back at -48, fading again |
| + RX5808 tuned, power loop off | -61 dBm, steady for 10 min |

Also ruled out on the real firmware: the ADC (paused, or kept powered), CPU clock (80 MHz only
slowed the fade), a lower transmit power (15 dBm still faded), a full RF recalibration (still
faded), the idle station interface (plain AP mode faded the same) and the PC adapter.

**Fix** (`txPowerStep` in `lib/WEBSERVER/webserver.cpp`). The loop can't simply be switched off:
it is also what raises the gain after WiFi starts (from a low start value to the target, about
one step a second, ~14 s). Switched off at once, the hotspot stayed at -77..-81 dBm. So when
the hotspot starts:

1. the receiver is switched off (no leak),
2. the loop runs normally for 20 s and brings the transmitter to its target,
3. the loop is switched off with the radio library's own flag `phy_set_most_tpw_disbg = 1`
   (`tx_pwctrl_background` then skips the correction; the transmitter keeps its gain),
4. the receiver is switched back on.

The library clears the flag and resets the gain whenever it applies a transmit power again
(WiFi start, mode change); the timer notices and settles again. A race always keeps its
receiver: if one starts during the 20 s (or the library resets the gain during a race), the
gain as it is gets held and the settling runs after the race. This is for the classic ESP32:
the ESP32-C3/S3 radio libraries don't have this flag, and those boards weren't measured. The public API (`esp_wifi_set_max_tx_power`) never sets this flag in
Arduino-ESP32 2.0.17 / ESP-IDF 4.4; it was found by disassembling the library.

**Result.** Beacons steady at -58..-63 dBm; a client joined and had an address in 2 s, lost 4 of
1424 pings over 6 minutes (single pings, like on the home router) and stayed connected through
network scans; all device tests pass over the hotspot.

**Trade-off.** With the loop off, the transmitter no longer corrects for temperature. Over a
large temperature change that may be a couple of dB, against the 30 dB fade it replaces.

**Checking it.** `GET /api/debug/load` shows `"txLoop":0` once the hotspot has settled.
`POST /api/debug/hotspot` switches a timer on your WiFi to its hotspot until the next restart;
then run `python tools/hotspot_signal.py 600 10` on a Windows PC with WiFi (it can stay on
another network): the hotspot should stay within a few dB for 10 minutes. Windows' "Signal %"
is smoothed and hides fading; the tool reads each beacon's dBm. Check this again after a
framework (Arduino-ESP32 / ESP-IDF) update: the fix relies on a library-internal flag.

## Other hotspot fixes in this release

- **DHCP.** The ESP32's built-in DHCP server broadcasts its replies; WiFi doesn't acknowledge
  or repeat broadcasts, and the first reply after a phone joined was often lost (phones got an
  address after 3-40 s, or Android gave up). The timer runs its own small DHCP server
  (`lib/HOTSPOTDHCP`) that replies directly to the phone (unicast).
- **Network scan from the page.** Scanning used to take the radio away from the hotspot's
  channel for 1.6 s at a time. It now scans one channel at a time and returns to the hotspot's
  channel in between (40-120 ms away at a time, about 4 s in all), with the hotspot running in
  AP+STA mode so a scan never restarts it.
- **Radio settings.** 20 MHz channel width, power save off, maximum transmit power (the ESP32
  rounds 19.5 dBm requests down to 18 dBm, so the default is left alone).
