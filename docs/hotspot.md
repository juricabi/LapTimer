# The timer's hotspot

How the hotspot works, why it used to fade and how that was fixed. Measured on an ESP32 dev
board with an RX5808, powered from USB, with a PC WiFi adapter 1-2 m away.

## In short

The timer's own hotspot holds steady: -54 to -62 dBm at 1-2 m with the pilot on 5800 MHz, next
to home routers at -50 to -56 dBm on the same adapter. Every version up to v1.1.0 as first
released faded away every few minutes on many pilot channels, because the RX5808 disturbs the
ESP32's transmit power control. The firmware now sets the transmitter's gain itself (classic
ESP32).

## Using the hotspot

With no saved networks the hotspot starts right away. Away from your saved networks the timer
looks for them first, then starts its own hotspot (about 40 s after power-on; a long beep if
the buzzer is on). At power-up the receiver starts once WiFi is up, within a few seconds.

## The fading problem

**Symptom.** Phones dropped from the hotspot after a minute or two, couldn't rejoin for a
while, DHCP and network scans failed, and the range was a few metres. Measured from the PC, the
hotspot's beacons started at about -58 dBm, held for ~90 s, then faded steadily to -87 dBm,
vanished for ~40 s and came back at full strength, every ~4 minutes. The same PC adapter held
the home router at a steady -50 dBm. On the home WiFi the timer worked fine.

**Cause.** The ESP32 keeps its transmit power on target with a closed loop: a detector
measures the output, and Espressif's radio library (`tx_pwctrl_background` in libphy, after
every 5th frame sent) steps a gain value up or down. The tuned RX5808 leaks into that detector
(its oscillator runs at (f - 479) / 2, about 2.65 GHz, next to the WiFi band). The loop reads
its own signal plus the leak, decides the power is too high and turns down; the leak doesn't
shrink, so it keeps turning down. The gain value is a signed byte with no lower limit: past
-128 it wraps to +127, which is the "gone, back at full strength" above. As a station on a
router the radio sleeps between beacons and the loop starts over on every wake-up, so the
fade never builds up there.

**How it was found.** A minimal test firmware (a bare hotspot, nothing else) on the same
board, with the timer's parts switched on one at a time:

| Test firmware | Hotspot beacons |
|---|---|
| Bare hotspot | -56 dBm, steady for 10 min |
| + core 0 busy nonstop (like the timer) | -55 dBm, steady |
| + nonstop `analogRead` on core 1 (like the RSSI sampling) | -55 dBm, steady |
| + RX5808 tuned to 5800 MHz | -73 → -89 dBm, gone, back at -48, fading again |
| + RX5808 tuned, power loop off | -61 dBm, steady for 10 min |

**It depends on the pilot's channel.** With the loop left on, the hotspot faded with the
receiver on 5769, 5800, 5843, 5880 and 5917 MHz, and stayed up on 5658, 5732 and 5865.
Moving the hotspot to WiFi channel 1, 6 or 11 made no difference.

**A second effect at power-up.** The first time WiFi starts after power-up, the radio
calibrates its transmitter (an analog gain, `tx_rf_ana_gain`). The RX5808 disturbs that too:

| RX5808 while WiFi starts | Calibration over several boots | Hotspot |
|---|---|---|
| Tuned to 5800 MHz | differs from boot to boot (0x5a, 0x5f, 0x7a) | level varies |
| Powered down | 0x75 every boot | weak, about -74 dBm |
| Left as after power-up (reset state) | 0x5f every boot | -56 to -62 dBm |

This, and wherever the loop had left the gain byte, is why the first fix (switch the loop off
after a 20 s settle) kept a level that varied from start to start, -60 to -89 dBm.

**What the firmware does** (classic ESP32):
1. At power-up the RX5808 stays in its reset state (`RX5808::init`) and the receiver stays
   untuned until WiFi has started (`LapTimer::enableReceiver`, at most 5 s after power-up), so
   the transmitter calibration comes out the same on every boot.
2. The power loop is switched off with the library's own flag (`phy_set_most_tpw_disbg = 1`)
   and the gain byte is set to 19 and applied (`holdTxGain` in
   `lib/WEBSERVER/webserver.cpp`). 19 is the highest value the loop itself reaches; the
   library's start value 0 is about 4 dB weaker. The library clears the flag whenever it
   applies a transmit power (WiFi start, mode change); the web server then holds the gain
   again.

Result on 5800 MHz: beacons at -54 to -62 dBm at 1-2 m, steady, the same after a short or a
long time as a station first; a PC joins in about 1 s, 4 of 712 pings lost over 3 minutes,
three network scans without a drop, all 22 device tests pass over the hotspot, 10 of 10 boots
fine.

**Trade-off.** Temperature compensation is part of the loop, so with the loop off the power
can drift a little as the board warms up.

**Dead ends.** Switching the loop off after a 20 s settle (varied, see above), a longer
settle, resetting the library's round counter (`tx_pwctrl_track_num`), a full WiFi restart
before the settle (-86 dBm), parking the receiver on 5865 while settling (-64, then -82),
the library's fixed-power mode (`esp_wifi_set_max_tx_power` reaches it only below ~13.5 dBm;
-82 dBm at 8.5 dBm), asking for more power (the radio caps requests at 18 dBm), another WiFi
channel.

**ESP32-C3 / S3.** Their radio libraries don't have these symbols: the fix isn't applied
there and they haven't been measured.

**Checking it.** `GET /api/debug/load` shows `"txLoop":0`, `"txGain":19`, and `txAnaGain`
the same on every boot (ending in `5f` on the test board). `POST /api/debug/hotspot` switches a
timer on your WiFi to its hotspot until the next restart; then run
`python tools/hotspot_signal.py 600 10` on a Windows PC with WiFi (it can stay on another
network) and watch the level for 10 minutes. Windows' "Signal %" is smoothed and hides fading;
the tool reads each beacon's dBm. `POST /api/debug/txgain?k=<gain>` sets another gain byte
until the next WiFi start, to compare levels; without `k` it applies 19 again.

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
