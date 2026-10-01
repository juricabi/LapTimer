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
   faster than `laptimer.local` on Windows. Done: "back online" after each file, and "web files
   verified" after `fs` (the tool fetches every file of `data/` and compares sizes).
4. **Verify on the timer** — `python tools/device_test.py <timer-ip>`; for boot/WiFi changes
   also `python tools/boot_log.py <port> 25 --reset` over several boots. Done: all checks PASS.
   With a drone, `python tools/rssi_log.py <timer-ip> <seconds>` records the RSSI and the
   counted passes. Report what could not be verified (lap detection needs a drone through the
   gate).
5. **Review** — for larger batches run a code review of `main...<branch>` and fix what holds up.
6. **Commit and push** the branch. A release: merge to `main`, tag, GitHub release with
   `laptimer-vX.Y.Z-firmware.bin` and `laptimer-vX.Y.Z-littlefs.bin` attached.

## Rules

- **Settings layout** (`laptimer_config_t`) is append-only: add fields at the end, bump
  `CONFIG_VERSION` and give the new fields defaults in the migration in `Config::load`, one
  step per version (`if (version < 4) conf.targetLapMs = 0;`), so users keep their settings
  through updates. A step's defaults must not run for newer versions: `setRaceDefaults()` for
  every older version would have wiped the v3 race settings at v4. Going back a version, a
  firmware from 1.2.0 on keeps the fields it knows from a newer layout (up to
  `CONFIG_VERSION_NEWEST_KEPT`); 1.1.0 and older reset all settings then. Versions 1 and 2
  were multi-pilot development layouts; version 3 keeps their v0 fields only. `fromJson` changes
  only keys that are present, and the page sends only changed settings — two open phones
  rely on this.
- **Race data** changes only on the timing core in `LapTimer::update`. The web server (core 0,
  pinned with `CONFIG_ASYNC_TCP_RUNNING_CORE=0`; unpinned it preempted RSSI sampling) queues
  commands with `requestStart/requestStop/requestClear/requestEdit`. Values shared between the
  cores are `volatile`, and a request stores its data before its flag (the compiler otherwise
  reorders plain stores past a volatile one; the buzzer once switched a fresh beep off that way).
- **Timing core stalls**: web replies are built in memory (`sendJson`, `String`), never with
  `AsyncResponseStream` (drained byte by byte, O(n^2)). Flash writes stall both cores, so
  settings reach EEPROM only outside a race; saved pilots, lap fixes, clearing the history and
  WiFi list changes are refused during a race (409 `racing`; the page sends saved pilots
  afterwards), and a new race starts only after the last one is saved.
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
  A race file has its own `name` (rename, 32 bytes; `pilots[].name` is the pilot) and the
  pace `target` it started with, both only when set. The history list (`addSummary`)
  has the `name`; the `target` only the race file.
- **Pace target** (`targetLapMs`, `/config` key `target`, 0 = off, 3-600 s): only the page uses
  it (callouts, "vs target", chart); the timing core doesn't. Saved pilots store it when set.
  A race takes it at its start like the other race settings (`LapTimer::start`; owner's
  choice: a change applies from the next race) and reports it in `/api/race` and the saved
  race; the page uses the race's (`raceTarget`), the setting only before any race. Start
  sends a settings change still waiting for its 600 ms save first (`flushSettings`), or the
  race would start with the old value (this holds for all race settings). Its
  callouts have their own switch (`anTarget`, settings v5, on by default), live like the
  other announcer settings; with it on they replace the delta to the best lap.
- **WiFi passwords** stay on the timer; `/config` and `/api/wifi/saved` return names only.
- **UI**: design tokens in `style.css` with contrast ratios noted beside them — text ≥ 4.5:1,
  controls ≥ 3:1, touch targets ≥ 44 px; plain CSS/JS, no new libraries.
- **Lap chart and share image**: `lapChartSvg` builds one SVG string for both. Its colours go
  in `style` attributes (`var()` is ignored in SVG presentation attributes) and are checked on
  the best-3 band too. The share image is a canvas in the dark theme's colours (`SHARE` in
  `script.js`, kept in step with the dark tokens); the chart is drawn on it from a Blob URL
  (no `foreignObject`, no external files, so the canvas stays saveable). On the timer's http
  page `navigator.share`/`clipboard` don't exist (secure contexts only). Like voice commands,
  the feature appears with the insecure-origins flag (or https, or 127.0.0.1): `shareMenu`
  then makes the History button "Share image" and opens the share menu; without it "Save
  image" opens the picture full screen (press and hold: the phone's own share/save menu, plus
  Download) with the flag steps (`secureFlagSteps`, shared with the mic help) on Chromium.
  A share refused because the tap is too old falls back to that screen, which has a Share
  button for a fresh tap. Text is copied with `execCommand("copy")` (`copyText`).
- **Voice**: Web Speech API in a normal browser tab. Set `utterance.lang = "en-US"`; on Android
  leave the voice object unset (forcing one makes Chrome/Brave silent). Speech starts after a tap.

## Pitfalls already paid for

- **ESP32 async WiFi scan**: the library reports `WIFI_SCAN_FAILED` after 6 s (20 × 300 ms)
  while a full scan takes ~5.95 s, longer on the first boot after an update. Treat "failed"
  within 12 s as still running (the boot scan in `webserver.cpp`).
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
  In its reset state all blocks are on: `init()` leaves it there (`RESET_STATE_FREQ_MHZ`), and
  the first `scan()` after WiFi started tunes it or, with the receiver set to off, powers it down.
- **Channels in two bands**: the timer stores only MHz, and 5880 is both F8 and R7. The page's
  `bandChannel(freq, preferBand)` keeps the band the picker shows, or switching band jumps.
- **Transmit power fade** (classic ESP32): the tuned RX5808 (oscillator at (f-479)/2, ~2.65
  GHz) leaks into the ESP32's transmit power detector. libphy's power loop
  (`tx_pwctrl_background`, every 5th frame sent) reads too much power and steps its gain byte
  (`chip7_sleep_params[184]`, `[185]`, int8) down with no lower limit; it wraps from -128 to
  +127, so the hotspot faded ~30 dB over 2-10 min, vanished and came back full, over and over.
  Pilot channels 5769, 5800, 5843, 5880, 5917 faded; 5658, 5732, 5865 didn't; the WiFi channel
  made no difference. A station hides it (the radio sleeps between beacons). Second effect: the
  first WiFi start after boot calibrates the transmitter (`tx_rf_ana_gain`), and the RX5808
  disturbs that too: tuned to 5800 it came out random (0x5a/0x5f/0x7a), powered down 0x75 and
  weak (-74 dBm), left in its reset state 0x5f every boot. Fix: `RX5808::init` leaves it in
  reset and `LapTimer::scan` keeps it untuned until the web server calls `enableReceiver()`
  after WiFi started (at most `RECEIVER_WAIT_MAX_MS`); `holdTxGain` (webserver.cpp) switches
  the loop off (`phy_set_most_tpw_disbg = 1`) and applies gain byte `TX_GAIN_BYTE` 19 (the
  loop's own maximum; its start value 0 is ~4 dB weaker) with `tx_gain_table_set()`. The
  library clears the flag whenever it applies a TX power (WiFi start, mode change), so
  `handleWebUpdate` holds it again. Result: -54..-62 dBm at 1-2 m, steady (routers -50..-56).
  Trade-off: no temperature compensation (it is part of the loop). Dead ends: holding the
  loop after a 20 s settle (-60..-89, varied with hidden state), longer settles, resetting
  `tx_pwctrl_track_num`, a WiFi restart, parking the receiver on 5865, libphy's fixed-power
  mode (only below ~13.5 dBm), more power (requests cap at 18 dBm). Check `/api/debug/load`
  (`txLoop` 0, `txGain` 19, `txAnaGain` the same every boot), compare levels with
  `POST /api/debug/txgain?k=`, measure with `tools/hotspot_signal.py` (beacon dBm; Windows'
  "Signal %" hides fading); `docs/hotspot.md` has the measurements. The C3/S3 libphy lacks
  these symbols: not handled, not measured.
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
  compiled out here). Second failure: the built-in server forgets its leases on a restart while
  phones keep theirs (2 h), and a phone on a static address is invisible to it, so the next
  device got an address already in use and both got each other's replies (page loads
  sometimes, no live RSSI). `HotspotDhcp` keeps its leases in RTC memory (kept across a
  software restart: the page's Restart, an update; cleared by a power cycle or an EN reset,
  which the classic ESP32 treats as power-on), probes each address with ARP before offering or
  acknowledging it (`inUseByOther`; a used one is set aside for 10 min), tries an address
  derived from the MAC first, and sends every reply, the NAK too, as a frame to the phone's
  MAC. Only the client's own MAC counts as its own in the ARP check (a repeater's shared MAC
  would let two devices behind it share an address; tried and reverted). Test from a PC WiFi adapter on the hotspot: `ipconfig /release` + `/renew` timings,
  `pktmon` for the packets, `/api/debug/aplog` for the timer's side (types: 0 joined,
  1 assigned, 2 left, 3 offered, 4 refused, 5 in use by another device, 6 send failed, 7/8 leases
  kept/cleared at start); `tools/fake_dhcp.py` (a DISCOVER or REQUEST with a made-up MAC)
  shows what the server does with an address a static device holds.
- **WiFi radio settings** are ignored before WiFi has started (`WiFi.setTxPower`,
  `esp_wifi_set_protocol` in `init()` never applied). Leave the transmit power at its default
  maximum: asking for 19.5 dBm gives 18 dBm (the ESP32 rounds down to fixed steps). The
  hotspot runs at 20 MHz with power save off, in AP+STA mode so a network scan never switches
  modes (that restarts the hotspot and drops phones), and the page's scan goes one channel at
  a time. Link tests made before the transmit power fix (above) are unreliable: its dropouts looked
  like scan, bandwidth or DHCP trouble. `/api/debug/load` shows the real radio settings;
  `/api/debug/hotspot` switches to the hotspot until the next restart.
- **Voice commands** (Chrome's `SpeechRecognition`): recognition runs on Google's servers, so
  the phone needs internet on the timer's network — none on the timer's own hotspot, and
  mobile data doesn't help (Android then loses the timer); they work on home WiFi or with the
  timer on the phone's hotspot. Brave blocks the service (`navigator.brave`). On plain http
  Chrome refuses the microphone until the page's address is in
  `chrome://flags/#unsafely-treat-insecure-origin-as-secure` (a page can't open chrome://
  links: the mic card shows it to copy). Chrome ends a session after silence (`no-speech`,
  then `end`): reopen at once, the short gap is Chrome's. A doomed session fires `start`
  before its error, which made the icon blink red and green: after a failure it turns green
  only once a session has held 5 s. Recovery is silent (reachability fetch, `online`
  event), no retry button. Voice and Voice commands are per phone (localStorage), in
  Setup → This phone; the announcer settings are on the timer.
- **Android and `.local`**: Android doesn't resolve mDNS names reliably, least of all on its
  own hotspot. `laptimer.local` works on laptops and iPhones; on Android use the IP.
- **Sampling rate**: `analogRead()` takes ~90 us per RSSI reading (setup repeated on every
  call, code run from flash), so 6 500-10 600 samples/s depending on where the linker places
  code (padding alone moved it 11%), not on heat, WiFi or the transmit gain. Enough for lap
  detection. Compare builds only A/B on the same timer (`/api/debug/load` samplesPerSec).
  `docs/sampling.md` has the measurements and a parked faster option (register reads from
  IRAM averaged into a fixed 100 us filter step; branch `perf/fast-adc`, not flown).
- **Captive portal**: tried and rejected — the sign-in window has no speech and blocks the
  normal browser. The hotspot uses private `192.168.4.1`, shown in the WiFi name, no DNS redirect.
- **Connection dropped near boot (open)**: in the first minute after a boot, a request that
  writes flash (saved pilot, settings) occasionally gets its connection closed or reset
  (`device_test.py` failed ~3 in 30 runs near boot, 0 in 10 runs later; no reboot, no
  crash in the serial log; the previous release: 0 in 8 near boot, not conclusive). The page
  retries saved-pilot and settings saves, so users see no effect. Root cause not found.
- **Web-files upload can leave files missing**: once, after `ota_upload.py fs` reported the
  timer back online, `style.css` and `update.html` answered 404 while the other four files
  were fine (cause not found; the image was accepted and the MD5 checked). The tool now
  fetches every file of `data/` after an upload and compares sizes: upload again if it
  complains. A page without its stylesheet or the update page's 404 means exactly this.
- **USB flashing** on the owner's board: auto-reset fails, so hold BOOT and tap EN; set
  `upload_speed = 115200` in `targets/PhobosLT.ini` (its 460800 dropped mid-write). Prefer WiFi updates. Opening the serial port (e.g.
  `boot_log.py` without `--reset`) can still restart the board: don't mistake that for a crash.
- **Browser tests**: a background tab runs timers about once a second, so scripted tests there
  look slow or "frozen". Screenshots of a background tab can show a stale frame. Chrome keeps a
  page zoom per address, so resizing the window didn't give a 390 px page: load the app in a
  390 × 844 `<iframe>` on the same origin (e.g. over `/mock/log`). The console tool doesn't see
  the iframe's messages: collect `error`/`unhandledrejection` with listeners. Light theme with
  a dark OS: delete the `prefers-color-scheme` rule from the stylesheet via CSSOM. Screenshots
  timed out about every second call: retry. `mock_server.py --host 0.0.0.0` serves phones.
- **A saved race without a drone**: with Enter/Exit just inside the RSSI noise (floor 50-53:
  52/51) noise counts passes; start, wait ~25 s, stop, restore the thresholds, and clear the
  history afterwards if it was empty. `device_test.py` needs a saved race for its rename checks.
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
