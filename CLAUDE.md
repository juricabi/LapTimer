# LapTimer

ESP32 FPV lap timer: an RX5808 receiver measures the drone's video signal and a pass through
the gate counts a lap. Firmware in `src/` + `lib/` (PlatformIO env `PhobosLT`); the web page in
`data/` (plain HTML/CSS/JS) is served from LittleFS to phones at the field. `main` is the latest
release (tagged `vX.Y.Z`); work happens on a feature branch, merged after it was tested on a real
timer. `docs/` has the measurements behind the radio decisions; `README.md` is for users.

## Change loop

Every change goes through all steps; a step is done when its check passes.

1. **Build**: `pio run -e PhobosLT` and `pio run -e PhobosLT -t buildfs`. Both SUCCESS, no
   empty file in `data/`.
2. **Look and test the page** (web changes): `python tools/mock_server.py`, open
   `http://127.0.0.1:8765/` at 390 px, light and dark theme, every tab touched. Then the page
   suite, headless: `node tools/run_page_test.js [sections]`. No console errors, every check PASS.
3. **Deploy**: `python tools/ota_upload.py <timer-ip> fw fs` (firmware first; the IP, not
   `laptimer.local`). "back online" after each file, "web files verified" after `fs`.
4. **Verify on the timer**: `python tools/device_test.py <timer-ip>`; boot/WiFi changes also
   `python tools/boot_log.py <port> 25 --reset` over 20+ boots. Say what couldn't be verified
   (lap detection needs a drone through the gate).
5. **Review** larger batches (`main...<branch>`) and fix what holds up.
6. **Commit and push** the branch. A release: merge to `main`, tag, GitHub release with
   `laptimer-vX.Y.Z-firmware.bin` and `laptimer-vX.Y.Z-littlefs.bin`. After visible UI changes
   `node tools/readme_images.js` retakes the README's screenshots (docs/images) from the mock.

## Design principles

**1. Nothing may stall the timing core.** Core 1 samples the RSSI (6 500-10 600 readings/s) and
is the only place race data changes (`LapTimer::update`). The web server runs on core 0
(`CONFIG_ASYNC_TCP_RUNNING_CORE=0`; unpinned it preempted sampling) and only queues commands
(`requestStart/Stop/Clear/Edit`): shared values are `volatile`, and a request stores its data
before its flag (the compiler reorders plain stores past a volatile one). Flash writes stall
both cores, so during a race the timer refuses everything that writes flash or ends the race
(saved pilots, lap fixes, rename, Delete all, WiFi list, restart: 409 `racing`) and writes
settings to EEPROM only afterwards; the page sends saved pilots after the race. Replies are
built in memory (`sendJson`), never with `AsyncResponseStream` (O(n^2)). All ADC reads stay on
core 1 (`analogRead()` isn't safe across cores: the battery read on core 0 froze every second
boot).

**2. A race owns its settings.** `LapTimer::start` copies mode, time, laps, countdown, minimum
lap, channel, pilot name and pace target; the race reports them (`/api/race`, `/api/status`, the
saved file) and the page shows the race's own (`raceTarget`, `shownRaceSettings`), the settings
only before a race. Changes apply from the next race; Enter/Exit apply live (calibrating during
a race) unless another pilot was picked meanwhile (other name or channel), then the race's own.
Start first sends any settings change still waiting, on its way or failed (`flushSettings`),
sends one start at a time, and is refused with the reason when there is no channel. A new race
starts only after the last one is saved. A race wins over a channel scan: starting one
cancels a scan, and a scan is refused during a race.

**3. The timer is the truth, phones are views.** Several phones may be open. The page sends
only changed settings and `fromJson` changes only keys present; `POST /config` replies
`{base, rev}` and a page adopts `rev` only if `base` is the revision it knew, otherwise it
reloads. `/api/status` carries `boot` (random per start), `cfg` and `prof` (settings and
saved-pilot revisions), so pages notice restarts and other phones. Saved pilots change one at a
time (`/api/profiles/save|remove`), lap fixes carry `expect` (409 when stale), and a race
another phone deleted is said so (`raceGone`). Lists the page shows (WiFi, timer info, History)
load again by themselves once the timer answers.

**4. Check at both ends, within what the page can show.** Values stay inside the page's
controls: race 30-600 s, 1-30 laps, minimum lap 1-20 s, speech rate 0.1-2, alarm 0-4.2 V,
announce type 0-4, Enter 51-255 / Exit 50-254 with exit < enter, target 0 or 3-600 s, names cut
at a whole UTF-8 character (pilot 20 bytes, race 32). The page checks first and says why; the
firmware checks again (another phone, an older page, the API), also for saved pilots. Settings
from the page are applied to a copy, checked, then published (the timing core reads them any
moment). WiFi: with a password the ESP32 joins only WPA2, so passwords are empty, 8-63
characters or 64 hex digits; passwords never leave the timer.

**5. Stored data survives updates.** The settings layout (`laptimer_config_t`) is append-only:
new fields at the end, `CONFIG_VERSION` bumped, defaults in `Config::load` one step per version
(`if (version < 4) conf.targetLapMs = 0;`), never a step that runs for newer versions
(`setRaceDefaults()` for every older version wiped the v3 race settings at v4). From 1.2.0 a
firmware keeps the fields it knows from a newer layout (`CONFIG_VERSION_NEWEST_KEPT`). Versions
1-2 were multi-pilot development layouts. Settings live in EEPROM and WiFi networks in NVS
(both survive updates); races and saved pilots are files on LittleFS, so a web-files update
clears them. Every race/profile write goes through `RaceHistory::writeJson` (temp file + rename)
under the history lock; files are read into memory before sending (LittleFS can't replace an
open file).

**6. Fail visibly, recover quietly, never lose work silently.** After 5 s without
`/api/status` the page says "No connection to the timer" and "Offline"; the race clock keeps
running. Refusals say why ("After the race", "Not during a race", "Password: 8-63
characters"). Anything that would drop data asks first (a full WiFi list forgets the oldest; ×
on a saved pilot). Recovery needs no button (retries, reachability checks). A timer restart
during a race is reported (`#raceLostNote`). Find and reproduce root causes rather than adding
retries that hide them.

**7. The announcer is current, not complete.** Callouts that would come late are dropped: laps
that arrive together say only the newest, and a lap's callouts not spoken when the next lap
comes are removed (`queueSpeak(text, "lap")`). "Then compare with" is one choice (Nothing / Best
lap / Target, stored as `anDelta`/`anTarget`; `fromJson` keeps only the one switched on). Voice
and voice commands are per phone (localStorage); the announcer settings are on the timer. Web
Speech: `utterance.lang = "en-US"`, on Android no voice object (forcing one makes Chrome/Brave
silent), speech only after a tap.

**8. A phone UI on plain http.** 390 px first, light and dark; design tokens in `style.css`
with contrast noted (text ≥ 4.5:1, controls ≥ 3:1), touch targets ≥ 44 px, plain CSS/JS, no
libraries. Overlays (race screen, race picture) add a history entry so Android's Back closes
them. On http there is no share, clipboard, microphone or wake lock: those features appear when
the page is a secure origin (the Chrome flag `unsafely-treat-insecure-origin-as-secure`, shown
by `secureFlagSteps`), otherwise a fallback (the race picture full screen to press and hold;
copy with `execCommand`). The chart (`lapChartSvg`) is one SVG for the page and the share image;
its colours go in `style` attributes (`var()` doesn't work in SVG presentation attributes); the
share image is a canvas in the dark theme's colours (`SHARE`) with the chart drawn from a Blob
URL (no `foreignObject` or outside files, or the canvas can't be saved). `index.html` and
`update.html` are served uncached and `tools/stamp_versions.py` stamps `?v=<hash>` on the CSS/JS
at every build (cached a day; keep new assets in its `ASSETS`).

## Testing

- **A bug gets a test that fails first**, then the fix. A new page feature gets its checks in
  `tools/page_test.js` (sections: layout, setup, race, raceSettings, raceEdges, calibrate,
  history, historyEdges, connection, voice, update; each starts from `/mock/reset`).
- **The mock** (`tools/mock_server.py`) mirrors `lib/WEBSERVER/api.cpp`, refusals included:
  keep them in step. Helpers under `/mock/` (reset, reboot, offline, fail, slow, busy, passes,
  lap, full, saveerr, info, vbat, oldrace, log) make the states a test needs. Unlike a new
  timer it starts with a channel. `--host 0.0.0.0` serves phones.
- **Writing page tests**: run headless (`run_page_test.js`): a background or covered tab runs
  timers once a second or slower. The runner emulates focus (without it `focus()`/`blur()` fire
  no events). A real tap blurs a focused field before its click: simulate that with `blur()`.
  Read the clock with `clockText()`; after a start wait for `raceData.race === status.race`.
  `T.post()` returns the HTTP status as `code`. Reload the page rather than the test file. Kill a
  leftover headless Chrome with `taskkill /T`. Screenshots at 390 px: headless Chrome with
  `Emulation.setDeviceMetricsOverride` (a desktop window keeps its page zoom).
- **On the timer**: `device_test.py` (API checks, cleans up after itself; its rename checks need
  a saved race). `noise_races.py` records test races from RSSI noise (Enter/Exit just inside the
  noise; `--one` one race, `--thresholds` tests Enter/Exit during a race); when every channel is
  too quiet it records nothing. Record races after the last web-files upload. With a drone:
  `rssi_log.py`. Radio: `hotspot_signal.py` (beacon dBm), `fake_dhcp.py`, `boot_log.py`.

## Hardware and radio facts (measured, don't relearn)

- **RX5808**: after a frequency change it reads nothing until locked (36 ms typical, up to
  45 ms, ~1% over 100 ms): wait `RX_LOCK_MS` (50). Measure with `/api/debug/step`. After a
  reset (register 0xF) it ignores writes for 20-50 ms and stays deaf until the power register
  is written: reset only at start-up; wake with `setupRxModule()`. Frequency 1111 = off (a new
  timer's default).
- **One receiver, one pilot.** Multi-pilot by hopping channels was built and removed: with the
  lock time each pilot is read every 105-210 ms and a fast pass falls between the readings.
- **Channels**: the timer stores MHz only; 5880 is F8 and R7, so the page keeps the band its
  picker shows (`bandChannel(freq, preferBand)`).
- **Transmit power fade** (classic ESP32): the tuned RX5808 disturbs libphy's transmit power
  loop and the first WiFi calibration, so the hotspot faded away every few minutes. Fix: the
  receiver stays untuned until WiFi has started (`enableReceiver()`), and `holdTxGain` turns the
  loop off and sets gain byte 19, again after every WiFi start or mode change
  (`handleWebUpdate`). Trade-off: no temperature compensation. Check `/api/debug/load`
  (`txLoop` 0, `txGain` 19). Measurements and the dead ends tried: `docs/hotspot.md`. ESP32-C3/S3
  not handled.
- **Hotspot**: its own DHCP server (`lib/HOTSPOTDHCP`, unicast replies, leases kept across a
  restart, ARP check before handing out an address): the built-in one lost replies and handed
  out addresses in use (`docs/hotspot.md`). AP+STA mode so a network scan never restarts the
  hotspot; the page's scan goes one channel at a time. Fixed address `192.168.4.1` in the WiFi
  name, no captive portal (its sign-in window has no speech and blocks the browser).
- **WiFi**: radio settings before WiFi has started are ignored. Transmit power stays at its
  maximum (requests are capped at 18 dBm). The async scan reports `WIFI_SCAN_FAILED` after 6 s
  while a full scan takes ~6 s: treat "failed" within 12 s as still running.
- **Sampling**: `analogRead()` takes ~90 µs; the rate depends on where the linker places code
  (padding moved it 11%). Compare builds only A/B on one timer (`docs/sampling.md`; faster
  register reads parked on branch `perf/fast-adc`).
- **Phones**: Android doesn't resolve `laptimer.local` reliably (use the IP). Voice commands
  (Chrome `SpeechRecognition`) need internet (not on the timer's hotspot) and the Chrome flag on
  http; Brave blocks them. Chrome ends a session after silence: reopen at once; after a
  failure the mic turns green only once a session held 5 s.

## Open issues and known gaps

- **Connection dropped near boot**: in the first minute after a boot a request that writes
  flash occasionally gets its connection reset (no crash, no reboot). The page retries; root
  cause not found.
- **Web-files upload**: once two files were missing after an upload that reported success;
  `ota_upload.py` now compares every file (upload again if it complains).
- Not fixed (audit 2026-10-01): a hidden network is tried only if it is the newest saved one;
  the scan keeps 24 results in channel order, not the strongest; the WiFi list is written as
  count then list (a power cut between loses it); settings reach the timing core as a plain
  struct copy (one sample can see new Enter with old Exit), and stored values aren't checked
  at load; a lap fix checks only the tapped lap; a dropped firmware upload can make the next
  fail, and the web-files image has no hash check; no login for restart/update; History
  doesn't show another phone's rename or fix until reopened; no wake lock on the race screen.

## Working here

- USB flashing on the owner's board: hold BOOT and tap EN, `upload_speed = 115200`; prefer
  WiFi updates. Opening the serial port can restart the board (not a crash).
- Edit with scripts written to files: shell heredocs mangle `\n`, quotes and Windows paths.
  Read a file fully before rewriting it (`open(p, "w")` once emptied `data/update.html`).
- A web-files upload clears the timer's saved pilots: save them from `/api/profiles` first and
  send them back with `/api/profiles/save`.

## Owner preferences

- Tests on Android with Brave; UI text and voice in English.
- Automatic and simple: settings auto-save, one buzzer beep per lap, no captive portal, one
  pilot per timer (saved pilots to switch who flies).
- Responsiveness over power saving: both cores at 240 MHz.
- Root causes found and reproduced, not retries that hide them; every bug confirmed by a test.
