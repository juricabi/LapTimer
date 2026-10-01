# LapTimer

A standalone FPV drone lap timer: an ESP32 and one RX5808 5.8 GHz receiver at the gate,
and a phone as the display. Voice announcements, race modes, race history, saved pilots
and a race screen, all from a web page the timer serves itself. No app, no internet.

Based on [PhobosLT](https://github.com/phobos-/PhobosLT) and
[PhobosLT_pooling](https://github.com/nikbg3/PhobosLT_pooling).

<p align="center">
  <img src="docs/images/setup.png" width="240" alt="Setup: pilot, channel and saved pilots" />
  <img src="docs/images/race.png" width="240" alt="Race: clock and lap stats" />
  <img src="docs/images/race-screen.png" width="240" alt="Race screen: big numbers for the field" />
</p>

## Features

**Racing**
- One pilot per timer, sampled continuously for full precision (see [timing precision](#timing-precision)).
- Race modes: **practice** (unlimited), **timed** (finish on the first pass after the time is
  up) and **lap race** (finish after N laps).
- **Countdown start** (3-2-1-go beeps) or the race starts on the first gate pass
  (see [Starting a race](#starting-a-race)).
- Last lap, delta to best, best, average, consistency, best 2 and best 3 consecutive, total.
- **Lap-time chart**: every lap at a glance, scaled to your laps so 0.3 s shows; the best lap,
  the best 3 in a row and your target marked, a crash lap kept off the scale. Tap a lap to read it.
- **Pace target**: a target lap time per pilot, mainly for practice; each race keeps the one it
  started with. Laps are announced against it ("plus 0.40", "On target"; a switch of its own),
  and the Race tab, race screen, chart and race image show it.
- **Race screen**: big numbers for a phone or tablet at the field, with a live current-lap timer.

**Voice and sound**
- The phone announces lap times in English, with deltas, best laps and the finish; each
  phone chooses whether it speaks.
- **Voice commands** in Chrome: "start", "stop", "best time", "clear time"; the phone
  answers (see [Voice](#voice)).
- Buzzer and LED on the timer for laps, countdown, time up, race finished and low battery.

**Setup and calibration**
- **Saved pilots**: every named pilot is remembered with their channel and thresholds;
  one tap switches who is flying.
- Band and channel picker: A, B, E, F, R and L. L band (5362-5621 MHz) is below the RX5808's
  specified range, so reception there isn't guaranteed.
- **Calibration graph** with 25 ms resolution, and **auto-calibration**: fly 3+ passes and it
  suggests Enter/Exit from the real passes (the peaks that stand out, at least a minimum lap
  apart) and the signal level between them, or says what to change when they don't stand out.
- **Channel scan** to see which channels are busy before choosing.

**After the race**
- Every race with a pass is saved on the timer (last 30) with **CSV export**.
- **Rename** a race ("Club night heat 2"); unnamed races show their date.
- **Share image**: a picture of the race (stats, chart, target, every lap against your best)
  to share or save, or **Copy as text**.
- **Fix laps**: merge two laps split by a false pass, or split a lap where a pass was missed.

**Connection**
- Own hotspot, or up to 5 saved **WiFi networks** (the strongest in range is used), such as
  your home WiFi or your phone's hotspot at the field.
- `http://laptimer.local` on your WiFi; firmware updates over WiFi from the page.
- Settings save automatically and stay consistent across several open phones.

<p align="center">
  <img src="docs/images/calibrate.png" width="240" alt="Calibration graph with enter and exit thresholds" />
  <img src="docs/images/channel-scan.png" width="240" alt="Channel scan with the pilot's channel marked" />
  <img src="docs/images/fix-laps.png" width="240" alt="Fixing laps in the race history" />
</p>

## Hardware

- ESP32 dev board (classic ESP32; ESP32-C3 and ESP32-S3 targets are also in `targets/`)
- RX5808 5.8 GHz receiver module (SPI-modded)
- Optional: buzzer, LED, 1S LiPo with a 1:2 voltage divider for the battery reading

| ESP32 | Connects to |
|---|---|
| 33 | RX5808 RSSI |
| 19 | RX5808 CH1 (data) |
| 22 | RX5808 CH2 (select) |
| 23 | RX5808 CH3 (clock) |
| 3V3 / GND | RX5808 power |
| 21 | LED (+ resistor) to GND |
| 27 | Buzzer to GND |
| 35 | Battery voltage through a 1:2 divider |

![Connection diagram](assets/connection_diagram.png)

A 3D-printable case for the LilyGO T-Energy board is in [`stl/`](stl/).

**Power**: the timer draws about 0.10-0.15 A at 5 V (measured with a USB meter; the upper end
on its own hotspot, whose radio can't rest between beacons). A 5 600 mAh power bank (3.7 V
cells, about 20 Wh) runs it for about a day. Some power banks switch off below 50-100 mA as
if a phone were full: leave it running on the bank for 15 minutes at home first, or use the
bank's always-on or low-current mode.

## Install

1. Install [PlatformIO](https://platformio.org/) (VS Code extension or CLI).
2. Build and flash the firmware and the web pages:
   ```
   pio run -e PhobosLT -t upload
   pio run -e PhobosLT -t uploadfs
   ```
   If the board doesn't enter flash mode, hold **BOOT**, tap **EN**, then release BOOT.

Later updates can go over WiFi: open **Setup → Timer → Firmware update**, or run
`python tools/ota_upload.py <timer-ip> fw fs`.

<p align="center">
  <img src="docs/images/update.png" width="240" alt="Firmware update page" />
</p>

## Connect

**Timer hotspot** (default)
- WiFi network `LapTimer_xxxx 192.168.4.1`, password `laptimer`. The address is in the name.
- Open `http://192.168.4.1`. If the phone says the WiFi has no internet, stay connected;
  if the page doesn't load, turn off mobile data.
- There is no internet on it, so no voice commands (announcements work). Earlier versions'
  hotspot faded away on many pilot channels; why and how it was fixed:
  [docs/hotspot.md](docs/hotspot.md).

**Your WiFi, or your phone's hotspot**
1. **Setup → WiFi networks**: add the network (Scan helps), then **Restart timer**.
2. Open `http://laptimer.local`, or the timer's IP (**Setup → Timer** shows it; so do your
   router and the phone's hotspot settings). Android often doesn't resolve `laptimer.local`:
   use the IP there.
3. At power-up it joins the strongest saved network in range (60 s to connect). If none is
   seen, it tries the newest one for 20 s (a hidden network, or a phone hotspot still starting),
   then starts its own hotspot.

- Changes to the list, also removing the network in use, take effect at the next restart.
  **Forget all** restarts into the hotspot.
- If the connected network goes away, the timer keeps timing and saving races and rejoins it
  when it's back (a short beep every minute until then). For its own hotspot instead, switch
  it off and on.
- At the field, the timer on your phone's hotspot gives voice commands: the phone shares its
  mobile data. The phone needs signal.

## Use

1. **Setup**: enter the pilot's name and channel, or tap a saved pilot. Settings save automatically.
   Optionally a **Target lap** in seconds for the next races (empty = off); it is saved with the pilot.
2. **Calibrate** at the gate: switch on **Auto-calibrate** and fly 3+ passes, then **Apply**.
   By hand: **Enter** below the peaks of your passes and above what the timer reads with the
   drone on the pad, **Exit** just above the level while the drone is away (a pass ends when
   the signal drops below Exit). Run a **channel scan** first if others are flying.
3. **Race**: press **Start** (or say "start"). Open the **Race screen** for big numbers.
4. **History**: every race with a pass is saved. Open one to see its chart and all laps,
   **Fix laps**, **Rename** it, **Share image** or export CSV. The timer's page is plain
   `http://`, where phones offer no share button to web pages: the picture opens full screen,
   **press and hold it** for the phone's own menu (Android: Share image / Download image;
   iPhone: Share… / Save to Photos), or tap Download. With the timer's address added to
   `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (as for voice commands) Chrome
   also shows a **Share** button that opens the share menu directly.

### Starting a race

- **Countdown** (Setup → Race → Countdown start): 3-2-1-go beeps. The race starts at GO, and
  the first pass after it is the start pass. A drone waiting on the pad during the countdown
  gets its start pass when it takes off.
- **First pass**: after Start the timer waits, and the race begins at the first pass through
  the gate. With Enter above the pad level this is simply the first gate crossing.
- **Drone on the pad above Enter** (a pad close to the timer): after about 10 s with a steady
  signal the timer treats it as parked, and the take-off through the gate starts the race,
  provided the gate reads clearly stronger than the pad (5 or more above the pad level on the
  calibration graph). A take-off within those 10 s counts the time on the pad as the start
  pass, so lap 1 comes out too long; each rise of the signal on the pad (VTX warming up, the
  drone moved) starts the 10 s again. Arm, set it down, wait a moment, then fly; or set Enter
  above the pad level, which avoids all of this.

### Voice

- **Announcer** (Setup → Announcer, saved on the timer): what to announce (lap time, 2 or 3
  consecutive laps, a beep on the phone, or nothing), the delta to your best lap, and the
  speech rate. **Announce target** (on by default): with a target lap set (Setup → Pilot),
  every lap is compared with the target instead of your best: "plus 0.40", "minus 0.30", or
  "On target" within 0.05 s; "Best lap" still comes. Every phone with Voice on speaks it. The timer's own buzzer is separate
  (Setup → Alerts).
- **This phone** (Setup → This phone, for each phone, not saved on the timer): **Voice**
  (speaks lap times, race events and the answers to voice commands), **Voice commands**, and
  **Test voice**. Phones allow speech only after a tap: tap Test voice once after opening the
  page. Voice works in any normal browser tab (Chrome, Brave, Safari).
- **Voice commands**: say "start" (or "go"), "stop", "best time" or "clear time". The
  phone answers ("Race stopped", "Times cleared", "Nothing to clear", ...), the same as
  when you press the buttons. They need:
  - **Chrome**: Brave blocks the speech service.
  - **Internet on the timer's network**: Chrome's speech recognition runs on Google's servers.
    Your home WiFi, or the timer on your phone's hotspot; not the timer's own hotspot (mobile
    data doesn't help: Android then stops reaching the timer).
  - **The microphone allowed**: the page is plain `http://` (the timer has no certificate),
    and Chrome gives the microphone only to trusted sites. Add the timer's address once in
    `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (for example
    `http://192.168.4.1`; add every address you use), relaunch Chrome and allow the
    microphone when asked.
- **Mic icon** in the top bar: green is listening, red is a problem, grey is off or starting.
  Tap it for the reason and what to do, with the addresses to copy. It recovers by itself
  (back online, microphone back). Chrome closes a listening session after a few seconds of
  silence and it reopens at once: a word said in that short gap is missed, so say it again.

## Timing precision

The receiver stays on the pilot's channel and reads the signal thousands of times per second.
A pass is timed at the middle of the signal peak (a drone that stays in range of the timer
for more than 10 s is parked, not passing: see [Starting a race](#starting-a-race)), so the
timer itself adds about a millisecond. What remains is how sharp the peak is: put the timer
right at the gate, keep the drone far away for the rest of the lap, and calibrate Enter/Exit
from real passes.
How fast it reads, and a faster option kept for later: [docs/sampling.md](docs/sampling.md).

Why one pilot: after every channel change the RX5808 needs 36-45 ms to lock (measured), so a
receiver shared between pilots reads each of them only every 100-200 ms, and a fast whoop
pass falls between the readings. Racing several pilots needs a receiver per pilot, as in
RotorHazard.

## Development

See [CLAUDE.md](CLAUDE.md) for how the project is built, tested and released, and
[`tools/`](tools/) for the simulated timer, WiFi upload, device test, RSSI/pass logger, boot
log and hotspot signal scripts.

## License

MIT, see [LICENSE](LICENSE). Based on PhobosLT by phobos- and PhobosLT_pooling by nikbg3.
