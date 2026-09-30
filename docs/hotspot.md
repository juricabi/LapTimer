# The timer's hotspot

How the hotspot works, why its range can be short, and what is known and done about it.
Measured on an ESP32 dev board with an RX5808, powered from USB, with a PC WiFi adapter 1-2 m
away.

## In short

On some pilot channels (5800 MHz among them) the RX5808 disturbs the ESP32's transmitter and
the hotspot's range is short or unreliable. **At the field, let the timer join your phone's
hotspot** (Setup → WiFi networks, then open the timer's IP): as a station the timer isn't
affected. The timer's own hotspot is fine for setting up near the timer.

## Using the hotspot

With no saved networks the hotspot starts right away. Away from your saved networks the timer
looks for them first, then starts its own hotspot (about 40 s after power-on; a long beep if
the buzzer is on). For the next **20 s the receiver is switched off** while the hotspot's
transmit power settles (see below); the live RSSI shows nothing meanwhile. A race started in
those 20 s gets its receiver back at once.

## The fading problem

**Symptom** (every version up to v1.1.0 as first released). Phones dropped from the hotspot after
a minute or two, couldn't rejoin for a while, DHCP and network scans failed, and the range was a
few metres. Measured from the PC, the hotspot's beacons started at about -58 dBm, held for
~90 s, then faded steadily to -87 dBm, vanished for ~40 s and came back at full strength,
every ~4 minutes. The same PC adapter held the home router at a steady -50 dBm. On the home
WiFi the timer worked fine.

**Cause.** The ESP32 keeps its transmit power on target with a closed loop: a detector
measures the output and a background routine in Espressif's radio library
(`tx_pwctrl_background` in libphy) turns the gain up or down about once a second. The tuned
RX5808 leaks into that detector; the loop reads its own signal plus the leak, decides the power
is too high and turns down, and the leak doesn't shrink, so it keeps turning down until the
hotspot is gone. As a station on a router the radio sleeps between beacons and the loop starts
over on every wake-up, so the fade never builds up there.

**How it was found.** A minimal test firmware (a bare hotspot, nothing else) on the same
board, with the timer's parts switched on one at a time:

| Test firmware | Hotspot beacons |
|---|---|
| Bare hotspot | -56 dBm, steady for 10 min |
| + core 0 busy nonstop (like the timer) | -55 dBm, steady |
| + nonstop `analogRead` on core 1 (like the RSSI sampling) | -55 dBm, steady |
| + RX5808 tuned to 5800 MHz | -73 → -89 dBm, gone, back at -48, fading again |
| + RX5808 tuned, power loop off | -61 dBm, steady for 10 min |

**It depends on the pilot's channel.** With the real firmware and the power loop left on: with
the receiver on 5800 the hotspot fades on WiFi channels 1, 6 and 11 alike; on 5865 it doesn't
fade at all (it rises to about -60 dBm); powered down after 5800 it stays at about -77 dBm.
Other pilot channels haven't been measured.

**What the firmware does** (`txPowerStep` in `lib/WEBSERVER/webserver.cpp`, classic ESP32
only): when the hotspot starts, the receiver is off for 20 s while the loop runs, then the loop
is switched off with the radio library's own flag (`phy_set_most_tpw_disbg = 1`) and the
receiver comes back. The hotspot then no longer fades, **but the level it keeps varies from
start to start: between -60 and -89 dBm** at 1-2 m. The loop keeps state inside the closed
library that the 20 s don't undo (it depends on how long the timer ran as a station before).
Tried without a reliable result: a longer settle, resetting the library's round counter
(`tx_pwctrl_track_num`), a full WiFi restart before the settle (worse: -86 dBm), parking the
receiver on 5865 while settling (-64 once, -82 the next time), and the library's fixed-power
mode (only below 13.5 dBm, and weak: -82 dBm at 8.5 dBm). Work continues; a physical fix
(more distance or shielding between the RX5808 and the ESP32's antenna) would likely solve it
for good.

**Checking it.** `GET /api/debug/load` shows `"txLoop":0` once the hotspot has settled.
`POST /api/debug/hotspot` switches a timer on your WiFi to its hotspot until the next restart;
then run `python tools/hotspot_signal.py 600 10` on a Windows PC with WiFi (it can stay on
another network) and watch the level for 10 minutes. Windows' "Signal %" is smoothed and hides
fading; the tool reads each beacon's dBm.

## Other hotspot fixes (v1.1.0 re-release)

- **DHCP.** The ESP32's built-in DHCP server broadcasts its replies; WiFi doesn't acknowledge
  or repeat broadcasts, and the first reply after a phone joined was often lost (phones got an
  address after 3-40 s, or Android gave up). The timer runs its own small DHCP server
  (`lib/HOTSPOTDHCP`) that replies directly to the phone (unicast): an address in ~0.6 s.
- **Network scan from the page.** Scanning used to take the radio away from the hotspot's
  channel for 1.6 s at a time. It now scans one channel at a time and returns to the hotspot's
  channel in between (40-120 ms away at a time, about 4 s in all), with the hotspot running in
  AP+STA mode so a scan never restarts it.
- **Radio settings.** 20 MHz channel width, power save off, maximum transmit power (the radio
  caps requests at its highest target, 18 dBm).
