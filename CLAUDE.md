# LapTimer

ESP32 FPV lap timer. Firmware in `src/` + `lib/` (PlatformIO env `PhobosLT`); the web page in
`data/` is served from LittleFS. `main` is the latest stable release (tagged `vX.Y.Z`); work
happens on a feature branch and is merged after it has been tested on a real timer.

## Change loop

Every change goes through all steps; a step is done when its check passes.

1. **Build** — `pio run -e PhobosLT` (firmware) and `pio run -e PhobosLT -t buildfs` (web).
   Done: both print SUCCESS, and every file in `data/` is non-empty.
2. **Look** (web changes) — `python tools/mock_server.py`, open `http://127.0.0.1:8765/` at
   390 px width, check light and dark theme and every tab the change touches. Keep the mock's
   endpoints in step with `lib/WEBSERVER/api.cpp`. Done: no console errors, layout fits.
3. **Deploy** — `python tools/ota_upload.py <timer-ip> fw fs` (firmware first). The IP is much
   faster than `laptimer.local` on Windows. Done: "back online" after each file.
4. **Verify on the timer** — `python tools/device_test.py <timer-ip>`; for boot/WiFi changes
   also `python tools/boot_log.py <port> 25 --reset` over several boots. Done: all checks PASS.
   With a drone, `python tools/rssi_log.py <timer-ip> <seconds>` records the RSSI and the
   counted passes. Report what could not be verified (lap detection needs a drone through the
   gate).
5. **Review** — for larger batches run a code review of `main...<branch>` and fix what holds up.
6. **Commit and push** the branch. A release: merge to `main`, tag, GitHub release with
   `firmware.bin` and `littlefs.bin` attached.

## Rules

- **Settings layout** (`laptimer_config_t`) is append-only: add fields at the end, bump
  `CONFIG_VERSION` and give the new fields defaults in the migration in `Config::load` (like
  `setRaceDefaults()`), so users keep their settings through updates. Versions 1 and 2 were
  multi-pilot development layouts; version 3 keeps their v0 fields only. `fromJson` changes
  only keys that are present, and the page sends only changed settings — two open phones
  rely on this.
- **Race data** changes only on the timing core in `LapTimer::update`. The web server (core 0,
  pinned with `CONFIG_ASYNC_TCP_RUNNING_CORE=0`; unpinned it preempted RSSI sampling) queues
  commands with `requestStart/requestStop/requestClear/requestEdit`.
- **Timing core stalls**: web replies are built in memory (`sendJson`, `String`), never with
  `AsyncResponseStream` (drained byte by byte, O(n^2)). Flash writes stall both cores, so
  settings reach EEPROM only outside a race, saved pilots are refused during a race (409, the
  page sends them afterwards) and a new race starts only after the last one is saved.
- **Settings from the page** are applied to a copy, checked (exit < enter, race limits, UTF-8
  names cut at a whole character) and then published: the timing core reads them at any moment.
- **Multi-device**: `POST /config` replies `{base, rev}`; a page adopts `rev` only if `base` is
  the revision it knew, otherwise it reloads. `/api/status` carries `boot` (random per start)
  and `prof` (saved-pilot revision). Saved pilots change one at a time
  (`/api/profiles/save|remove`); lap fixes carry `expect` and get 409 when stale.
- **Race wins over a channel scan**: starting a race cancels a scan; a scan is refused during
  a race, the countdown or a queued start.
- **Cache busting** is automatic: `tools/stamp_versions.py` runs before every PlatformIO build
  and stamps `?v=<content hash>` on `style.css` / `script.js` in `index.html` and `update.html`.
  Those two pages are served uncached, the CSS/JS cached for a day. Keep new assets in the
  script's `ASSETS` list.
- **Storage**: a web-files (LittleFS) update replaces race history and saved pilots; settings
  (EEPROM) and saved WiFi networks (NVS) survive both kinds of update. Every race/profile
  write goes through `RaceHistory::writeJson` (temp file + rename) under the history lock.
  Files are read into memory before sending: LittleFS can't replace a file that is open.
- **WiFi passwords** stay on the timer; `/config` and `/api/wifi/saved` return names only.
- **UI**: design tokens in `style.css` with contrast ratios noted beside them — text ≥ 4.5:1,
  controls ≥ 3:1, touch targets ≥ 44 px; plain CSS/JS, no new libraries.
- **Voice**: Web Speech API in a normal browser tab. Set `utterance.lang = "en-US"`; on Android
  leave the voice object unset (forcing one makes Chrome/Brave silent). Speech starts after a tap.

## Pitfalls already paid for

- **ESP32 async WiFi scan**: the library reports `WIFI_SCAN_FAILED` after 6 s (20 × 300 ms)
  while a full scan takes ~5.95 s, longer on the first boot after an update. Treat "failed"
  within 12 s as still running (`webserver.cpp`, `api.cpp`).
- **RX5808 lock time**: after every frequency change it reads nothing until locked, then the
  full RSSI at once: 36 ms typically, up to 44.5 ms over 150 switches, the same for a 5 or
  155 MHz jump, and ~1% don't lock within 100 ms. Channel changes and the channel scan wait
  `RX_LOCK_MS` (50). Measure a module with `GET /api/debug/step?from=5740&to=5800` (VTX on
  5800; add `&hops=60` for lock-time statistics), then `GET /api/debug/step`.
- **Multi-pilot on one RX5808** was built (1-4 pilots hopping channels) and removed: with the
  lock time each pilot is read only every ~105 ms (2 pilots) to ~210 ms (4), and a fast whoop
  pass falls between the readings. The PhobosLT_4ch fork waits 8 ms, which reads an unlocked
  receiver. Several pilots need a receiver each.
- **RX5808 reset**: after a reset (register 0xF) it ignores writes for 20-50 ms and stays deaf
  until the power register is written again. Reset only at start-up with `RX5808_RESET_MS`
  after it; wake from power down with `setupRxModule()` only. Check the RSSI after a restart.
- **Channels in two bands**: the timer stores only MHz, and 5880 is both F8 and R7. The page's
  `bandChannel(freq, preferBand)` keeps the band the picker shows, or switching band jumps.
- **Hotspot fading** (every version up to v1.1.0): the tuned RX5808 (its synthesizer runs at
  (f - 479) / 2, ~2.6-2.7 GHz) leaks into the ESP32's transmit power detector, and the PHY's
  background power loop (`tx_pwctrl_background` in libphy) keeps turning the transmitter down:
  ~30 dB over 2-10 minutes until the hotspot vanishes, then it recovers and fades again. Phones
  drop, DHCP and scans fail, range is a few metres. Bisected with a bare softAP firmware on the
  timer: steady alone, with the busy cores and nonstop ADC too; fading once the RX5808 is tuned;
  steady again with the loop off. But the loop is also what raises the gain after a start
  (~1 step/s, ~14 s): switched off at once the hotspot stays at -77..-81 dBm instead of ~-60.
  So `txPowerStep` (webserver.cpp), when the hotspot starts: receiver off (`holdReceiver`),
  loop on for `TX_POWER_SETTLE_MS` (20 s), then libphy's own flag `phy_set_most_tpw_disbg = 1`
  (the gain holds) and the receiver back on. A race keeps its receiver: the gain so far is held
  and the settling runs again after the race.
  The PHY clears the flag whenever it applies a TX power (and resets the gain), which starts
  the settling again; `esp_wifi_set_max_tx_power` never sets it in this core, and libphy's
  `tx_pwctrl_track_num` only counts to 20 once per boot (no use as a settle signal).
  `/api/debug/load` `txLoop` shows the loop (0 = off). A station hides the fade (the radio
  sleeps between beacons, which starts the loop over). Measure with `tools/hotspot_signal.py`
  (beacon dBm per scan); Windows' "Signal %" is smoothed and misleads.
- **Boot freeze**: `analogRead()` reconfigures the ADC on every call (pin mux, attenuation,
  touch) without a lock across cores. With the battery read on core 0 during the RSSI
  sampling on core 1, about every second boot froze silently (both cores stuck, no WiFi,
  serial output cut mid-line); receiver off at boot or any added print/watchdog hid it
  (timing). All ADC reads stay on core 1: `BatteryMonitor::sampleAdc` runs in `loop()`, and
  `/api/debug/load` has no `temperatureRead()`. Test boots in bulk: `boot_log.py --reset`
  20+ times and count those reaching "Connecting to WiFi network".
- **Hotspot DHCP**: the ESP32's built-in DHCP server (ESP-IDF 4.4) broadcasts its OFFER/ACK;
  WiFi doesn't acknowledge or retry broadcasts, and the first one after a phone joined was
  often lost (packet capture: address after 3-40 s or never; Android gives up). The hotspot
  uses `lib/HOTSPOTDHCP` instead, which replies by unicast to the phone's MAC through
  `esp_wifi_internal_tx` (Espressif's later fix, esp-idf #12580, needs static ARP entries,
  compiled out here). Test from a PC WiFi adapter on the hotspot: `ipconfig /release` +
  `/renew` timings, `pktmon` for the packets, `/api/debug/aplog` for the timer's side.
- **WiFi radio settings** are ignored before WiFi has started (`WiFi.setTxPower`,
  `esp_wifi_set_protocol` in `init()` never applied). Leave the transmit power at its default
  maximum: asking for 19.5 dBm gives 18 dBm (the ESP32 rounds down to fixed steps). The
  hotspot runs at 20 MHz with power save off, in AP+STA mode so a network scan never switches
  modes (that restarts the hotspot and drops phones), and the page's scan goes one channel at
  a time. Link tests made before the fading fix (above) are unreliable: its dropouts looked
  like scan, bandwidth or DHCP trouble. `/api/debug/load` shows the real radio settings;
  `/api/debug/hotspot` switches to the hotspot until the next restart.
- **Android and `.local`**: Android doesn't resolve mDNS names reliably, least of all on its
  own hotspot. `laptimer.local` works on laptops and iPhones; on Android use the IP.
- **Sampling rate** is set by the ADC: one RSSI reading takes ~85-125 us depending on the WiFi
  state, so ~7 000-10 000 samples/s. Compare firmware versions only A/B on the same timer
  under the same conditions (`/api/debug/load` samplesPerSec); single readings mislead.
- **Captive portal**: tried and rejected — the sign-in window has no speech and blocks the
  normal browser. The hotspot uses private `192.168.4.1`, shown in the WiFi name, no DNS redirect.
- **USB flashing** on the owner's board: auto-reset fails, so hold BOOT and tap EN; use
  115200 baud (460800 dropped mid-write). Prefer WiFi updates. Opening the serial port (e.g.
  `boot_log.py` without `--reset`) can still restart the board: don't mistake that for a crash.
- **Browser tests**: a background tab runs timers about once a second, so scripted tests there
  look slow or "frozen". Screenshots of a background tab can show a stale frame.
- **Scripted file edits**: write the edit script to a file and run it — shell heredocs mangle
  `\n` escapes and Windows paths. Read a file fully before opening it for writing
  (`open(p, "w")` truncates first; that once emptied `data/update.html`).

## Owner preferences

- Tests on Android with Brave; UI text and voice in English.
- Likes things automatic and simple: settings auto-save, one buzzer beep per lap, no captive
  portal, one pilot per timer (saved pilots to switch who flies).
- Responsiveness over power saving: both cores run flat out at 240 MHz (resting a core or a
  lower clock were tried and dropped).
- Wants root causes found and reproduced, not retries that hide them.
