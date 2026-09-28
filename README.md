# LapTimer

A standalone FPV drone lap timer: an ESP32 and one RX5808 5.8 GHz receiver at the gate,
and a phone as the display. Up to **4 pilots**, voice announcements, race modes, race history
and a race screen, all from a web page the timer serves itself. No app, no internet.

Based on [PhobosLT](https://github.com/phobos-/PhobosLT) and
[PhobosLT_pooling](https://github.com/nikbg3/PhobosLT_pooling).

<p align="center">
  <img src="docs/images/setup.png" width="240" alt="Setup: pilots, channels and saved pilots" />
  <img src="docs/images/race.png" width="240" alt="Race: clock and per-pilot stats" />
  <img src="docs/images/race-screen.png" width="240" alt="Race screen: big numbers for the field" />
</p>

## Features

**Racing**
- 1–4 pilots on a single RX5808. The receiver hops between the pilots' channels
  (see [timing precision](#timing-precision)).
- Race modes: **practice** (unlimited), **timed** (each pilot finishes on the first pass after
  the time is up) and **lap race** (first to N laps).
- **Countdown start** (3-2-1-go beeps) or the race starts on the first gate pass.
- **Staggered start**: each pilot's race time starts at their own first pass.
- **Ranking** by most laps, fastest lap, or best 3 consecutive laps.
- Per pilot: last lap, delta to best, best, average, best 3 consecutive, consistency, position.
- **Race screen**: big numbers for a phone or tablet at the field, with a live current-lap timer.

**Voice and sound**
- The phone announces lap times in English, with pilot names, deltas, best laps, finishes and the winner.
- Voice commands: "start", "stop", "best time", "clear time".
- Buzzer and LED on the timer for laps, countdown, time up, race finished and low battery.

**Setup and calibration**
- Band/channel per pilot with warnings for equal or too-close channels.
- **Saved pilots**: named pilots are remembered with their channel and thresholds.
- **Calibration graph** with 25 ms resolution, and optional **auto-calibration** from a few passes.
- **Channel scan** to see which channels are busy before choosing.

**After the race**
- Every race is saved on the timer (last 30) with **CSV export**.
- **Fix laps**: merge two laps split by a false pass, or split a lap where a pass was missed.

**Connection**
- Own hotspot, or up to 5 saved **home WiFi** networks (the strongest in range is used).
- `http://laptimer.local` on your WiFi; firmware updates over WiFi from the page.
- Settings save automatically and stay consistent across several open phones.

<p align="center">
  <img src="docs/images/calibrate.png" width="240" alt="Calibration graph with enter and exit thresholds" />
  <img src="docs/images/channel-scan.png" width="240" alt="Channel scan with the pilots' channels marked" />
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

**Your WiFi**
1. **Setup → WiFi networks**: add your network (Scan helps), then **Restart timer**.
2. Open `http://laptimer.local`, or the timer's IP from your router.
3. If no saved network is in range at power-up, or joining fails within 60 s, the timer starts
   its own hotspot. **Forget all** returns to hotspot mode.

## Use

1. **Setup**: choose the number of pilots, names and channels. Settings save automatically.
2. **Calibrate**: with the quad powered at race distance, set **Enter** just below the peak
   and **Exit** a bit lower, or switch on **Auto-calibrate** and fly 3+ passes. Run a
   **channel scan** first if others are flying.
3. **Race**: press **Start** (or say "start"). Open the **Race screen** for big numbers.
4. **History**: every race is saved. Open one to see all laps, **Fix laps**, or export CSV.

Voice needs a normal browser tab (Chrome, Brave, Safari). Tap **Test voice** once after
opening the page; phones only allow speech after a tap.

## Timing precision

With one pilot the receiver stays on one channel. More pilots share it by hopping between
channels (8 ms to settle, 6 ms to measure per pilot), so each pass is timed a little less precisely:

| Pilots | Precision |
|---|---|
| 1 | full (continuous sampling) |
| 2 | about ±14 ms |
| 3 | about ±21 ms |
| 4 | about ±28 ms |

A pass is timed at the middle of the RSSI peak. With several pilots, a pass only counts while
that pilot's signal clearly beats the others, so a close drone can't trigger a lap on another channel.

## Development

See [CLAUDE.md](CLAUDE.md) for how the project is built, tested and released, and
[`tools/`](tools/) for the simulated timer, WiFi upload, device test and boot log scripts.

## License

MIT, see [LICENSE](LICENSE). Based on PhobosLT by phobos- and PhobosLT_pooling by nikbg3.
