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
after a 20 s settle) kept a level that varied from start to start, -60 to -89 dBm. 0x5f is also
the library's value before calibrating, and the board's temperature turned out to matter more
than the receiver (see "Warm starts and the stored calibration" below).

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
3. The calibration is kept at its best (`lib/RADIOCAL`, below): a power-on calibrates in full
   and the result is kept only if it ranks stronger than the best so far, otherwise the best is
   put back; every other start first sleeps 1 ms, because a start that wakes from deep sleep
   uses the stored calibration instead of calibrating again, which a warm board did up to
   12 dB weaker.
4. The analog gain is kept at 0x5f or stronger (`TX_ANA_GAIN_WEAKEST`, also in `holdTxGain`),
   and held again whenever the library puts the calibrated one back: as a station in modem
   sleep it did at every wake-up, so station mode runs without power save too (v1.2.4; the
   page's polls went from 106 ms to 17 ms with it).

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

**Warm starts and the stored calibration (2026-10-04, v1.2.1).** Range dropped to a few
metres after some starts and was 10 m through several walls after others. The first WiFi start
after a reset calibrates the transmitter (`register_chipv7_phy`, partial mode: it starts from a
calibration stored in flash, NVS namespace `phy`, and measures again), and on the test board
the result depends on the board's temperature. One visible part is the analog gain
(`tx_rf_ana_gain`, low byte, set by `cal_rf_ana_gain` from the power detector). It is a code
from a table in libphy (`correct_rf_ana_gain_new`), strongest first, gains relative to 0x5f in
~0.25 dB steps; the number says nothing about strength:

| Code | 7f | 6f | 5f | 7a | 5a | 69 | 75 | 55 | 74 | 54 | 44 | 60 | 40 | 20 | 10 | 00 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Gain | +10 | +5 | 0 | -8 | -18 | -25 | -34 | -44 | -55 | -65 | -71 | -84 | -96 | -113 | -127 | -151 |

| Start | Analog gain | Beacons at 1 m |
|---|---|---|
| Cold (unplugged, cooled with a fan) | 0x5f | -59 to -73 dBm |
| After 5-10 minutes of running | 0x5a | -61 to -67 dBm |
| Warm (restart, update, or power cycle of a warm board), 14 of 14 starts | 0x75 | -71 to -81 dBm |

A warm start comes after an update, a restart from the page, a swapped power bank, or a timer
in the sun. Not the cause: the RX5808 at start-up (reset as now, untouched, reset and woken,
powered down: 0x75 in all, two starts each), a restart vs a power cycle. Setting only the
analog gain on a warm start gets part of it back (same start: 0x75 -76 dBm, 0x5f -68, 0x55
-77, 0x7f about +1.5 dB over 0x5f); the rest of a warm calibration stays weaker.

What works is not calibrating again: a start that wakes from deep sleep loads the stored
calibration and skips the measurement (`esp_phy_load_cal_and_init`, reset reason 5), so every
start sleeps 1 ms first. Same board, same place, A/B:

| Start | Analog gain (calibrated → used) | Beacons at 1 m |
|---|---|---|
| Stored calibration (through deep sleep) | 5a → 5f | -54 to -57 dBm |
| Calibrating on a warm board | 75 → 5f | -66 to -67 dBm |
| Calibrating on a warm board, v1.2.0 (no hold) | 75 | -71 to -81 dBm |

The fastest data rate (72.2 Mbps) and no ping loss in all of them; device test 42/42; 22 of 22
starts clean (`boot_log.py --reset`); the time until a PC is back on the hotspot is the same
(18-23 s, the PC's own reconnect).

- Trade-off: the start-up calibration no longer follows the temperature (on this board it went
  the wrong way). `POST /api/debug/phyhop?on=0` makes the next starts calibrate as the library
  does, until a power cycle, to compare.
- Codes outside the table (0x45 tried first: +10 dB on beacons) make the library look up a
  gain it doesn't have and compute from a register that was never set: `/api/debug/txgain`
  refuses them.

**ESP32-C3 / S3.** Their radio libraries don't have these symbols: the fix isn't applied
there and they haven't been measured.

**Kept at its best (2026-10-05, v1.2.2).** In v1.2.1 which calibration got stored was chance:
the first start with none in flash, cold or warm (a library experiment stored a warm one, and
v1.2.1 reused it at -70 dBm until a cold start redid it by hand). Now the firmware keeps the
best (`lib/RADIOCAL`). The analog gain code a calibration picks comes from the same
power-detector measurement as the rest of it, so it ranks calibrations (table above). At a
power-on the stored calibration is erased first, so the library calibrates in full and stores
the result itself; the firmware compares the code with the best kept (NVS namespace `phybest`,
the library's three entries copied as they are, never interpreted): stronger becomes the best,
weaker is replaced by the best (copied back) and the timer restarts through deep sleep (about
2 s), the same code changes nothing. Every other start (restart, update, watchdog) sleeps 1 ms
first and reuses the stored best. So the first cold power-on sets a strong best by itself and
it only ever gets better. `POST /api/debug/phyerase` forgets both; the next start calibrates
and keeps its result.

`tools/cal_test.py <port> <host>` forces both outcomes on a warm board: the recorded code of
the best set to 0x00 and to 0x7f (`/api/debug/calbest`), a power-on through the serial port's
RTS line each time ("better", then "restored" with reset reason 8), a plain power-on, a
restart ("reused").

**Checking it.** `GET /api/debug/load` shows `"txLoop":0`, `"txGain":19`, `txAnaGain` ending
in `7f`, `6f` or `5f` (the analog gain in use), `txAnaCal` (the code this start calibrated or
loaded), `calBest` (the best's code; the two are equal after every start) and `cal`, what this
start did: `reused` (the best, without calibrating), `restored` (calibrated weaker, the best put
back), `adopted` (the first best), `better` (a new best), `same`; `plain` with `phyhop?on=0`,
`none` on other chips. `POST /api/debug/hotspot` switches a
timer on your WiFi to its hotspot until the next restart; then run
`python tools/hotspot_signal.py 600 10` on a Windows PC with WiFi (it can stay on another
network) and watch the level for 10 minutes. Windows' "Signal %" is smoothed and hides fading;
the tool reads each beacon's dBm. `POST /api/debug/txgain?k=<gain>&a=<code>` sets another
gain byte and analog gain (a code from the table) until the next WiFi start, to compare levels;
without parameters it applies the held values again.

## Other hotspot fixes (v1.1.0 re-release)

- **DHCP.** The ESP32's built-in DHCP server broadcasts its replies; WiFi doesn't acknowledge
  or repeat broadcasts, and the first reply after a phone joined was often lost (phones got an
  address after 3-40 s, or Android gave up). The timer runs its own small DHCP server
  (`lib/HOTSPOTDHCP`) that replies directly to the phone (unicast): an address in ~0.6 s.
- **Two devices on one address.** The built-in server forgot its leases when the timer
  restarted, while phones keep theirs for two hours, and a phone set to a fixed address is
  invisible to it: the next device to join was given an address already in use, and the
  timer's replies went to whichever of the two had spoken last (the page loaded sometimes,
  no live RSSI, refresh hung). The timer's server keeps its leases across a restart, asks on
  the network (ARP) whether an address is in use before handing it out, and gives a device
  the same address back when it can.
- **Network scan from the page.** Scanning used to take the radio away from the hotspot's
  channel for 1.6 s at a time. It now scans one channel at a time and returns to the hotspot's
  channel in between (40-120 ms away at a time, about 4 s in all), with the hotspot running in
  AP+STA mode so a scan never restarts it.
- **Radio settings.** 20 MHz channel width, power save off, maximum transmit power (the radio
  caps requests at its highest target, 18 dBm).

## For developers: the DHCP server (`lib/HOTSPOTDHCP`)

- Replies (OFFER, ACK and NAK) go as frames to the phone's MAC through `esp_wifi_internal_tx`.
  Espressif's later fix for the broadcast problem (esp-idf #12580) needs static ARP entries
  and is compiled out of this framework.
- Leases are kept in RTC memory: they survive a software restart (the page's Restart, an
  update) and are cleared by a power cycle or an EN reset, which the classic ESP32 treats as
  power-on.
- Before offering or acknowledging an address it asks with ARP whether another device uses it
  (`inUseByOther`); a used address is set aside for 10 min. It tries an address derived from
  the phone's MAC first. Only the client's own MAC counts as its own in the ARP check: taking
  the radio's MAC too (a repeater answers for the devices behind it) would let two of them
  share an address (tried and reverted).
- Testing from a PC WiFi adapter on the hotspot: `ipconfig /release` + `/renew` for timings,
  `pktmon` for the packets, `GET /api/debug/aplog` for the timer's side (types: 0 joined,
  1 assigned, 2 left, 3 offered, 4 refused, 5 in use by another device, 6 send failed, 7/8
  leases kept/cleared at start). `tools/fake_dhcp.py` sends a DISCOVER or REQUEST with a
  made-up MAC, to see what the server does with an address a device with a fixed address holds.
