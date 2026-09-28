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
   Report what could not be verified (lap detection needs a drone through the gate).
5. **Review** — for larger batches run a code review of `main...<branch>` and fix what holds up.
6. **Commit and push** the branch. A release: merge to `main`, tag, GitHub release with
   `firmware.bin` and `littlefs.bin` attached.

## Rules

- **Settings layout** (`laptimer_config_t`) is append-only: add fields at the end, bump
  `CONFIG_VERSION`, add a `setVNDefaults()` and a step in `Config::load`, so users keep their
  settings through updates. `fromJson` changes only keys that are present, and the page sends
  only changed settings — two open phones rely on this.
- **Race data** changes only on the timing core in `LapTimer::update`. The web server (core 0,
  pinned with `CONFIG_ASYNC_TCP_RUNNING_CORE=0`; unpinned it preempted RSSI sampling) queues
  commands with `requestStart/requestStop/requestClear/requestEdit`.
- **Timing core stalls**: web replies are built in memory (`sendJson`, `String`), never with
  `AsyncResponseStream` (drained byte by byte, O(n^2)). Flash writes stall both cores, so
  settings reach EEPROM only outside a race.
- **Settings from the page** are applied to a copy, checked (pilot count, exit < enter, UTF-8
  names) and then published: the timing core reads them at any moment.
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
  155 MHz jump, and ~1% don't lock within 100 ms. Hopping and the channel scan wait
  `RX_LOCK_MS` (48); with several pilots two readings below exit end a pass. Measure a module
  with `GET /api/debug/step?from=5740&to=5800` (VTX on 5800; add `&hops=150` for lock-time
  statistics), then `GET /api/debug/step`. The PhobosLT_4ch fork's 8 ms is wrong.
- **RX5808 reset**: after a reset (register 0xF) it ignores writes for 20-50 ms and stays deaf
  until the power register is written again. Reset only at start-up with `RX5808_RESET_MS`
  after it; wake from power down with `setupRxModule()` only. Check the RSSI after a restart.
- **Captive portal**: tried and rejected — the sign-in window has no speech and blocks the
  normal browser. The hotspot uses private `192.168.4.1`, shown in the WiFi name, no DNS redirect.
- **USB flashing** on the owner's board: auto-reset fails, so hold BOOT and tap EN; use
  115200 baud (460800 dropped mid-write). Prefer WiFi updates.
- **Scripted file edits**: write the edit script to a file and run it — shell heredocs mangle
  `\n` escapes and Windows paths. Read a file fully before opening it for writing
  (`open(p, "w")` truncates first; that once emptied `data/update.html`).

## Owner preferences

- Tests on Android with Brave; UI text and voice in English.
- Likes things automatic and simple: settings auto-save, one buzzer beep per lap for every
  pilot (voice tells pilots apart), no captive portal.
- Wants root causes found and reproduced, not retries that hide them.
