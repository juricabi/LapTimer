# LapTimer

Slightly modified version of https://github.com/phobos-/PhobosLT

 - With option to turn the buzzer on/off from GUI
 - Pooling instead of SSE
 - Return back the options for using Wi-Fi router
 - Race counter starts on first pass
 - Button to restart device
 - Voice to start/stop race (you need to enable chrome://flags/#unsafely-treat-insecure-origin-as-secure because of HTTP)
 - Announce best lap

## Connecting

**Timer hotspot (default)**
 - WiFi network: `LapTimer_xxxx 192.168.4.1` (xxxx = last 4 characters of the board's MAC address).
   The address to open is right in the network name.
 - Password: `laptimer`
 - Open `http://192.168.4.1` in your browser. Nothing pops up; if the phone says the WiFi has no internet,
   choose to stay connected. If the page doesn't load, turn off mobile data.

**Your own WiFi**
 1. Enter your network name and password under *Setup → Home WiFi*, press *Save configuration*, then *Restart timer*.
 2. The timer joins your network and gets an IP from your router.
 3. Open `http://laptimer.local` (mDNS), or the timer's IP from your router's device list.
    `.local` names work on iOS, macOS, Windows and Linux; support on Android depends on the version and browser.
 4. If the timer can't find or join your WiFi within 60 seconds of powering on, it switches to its own hotspot (above).
    This only depends on the WiFi network being available, not on anyone opening the page.
    Once connected, it stays on your WiFi; if the WiFi drops, it keeps reconnecting instead of switching to hotspot mode.
    To go back to hotspot mode, press *Forget home WiFi*.

## Changes in this fork

Based on [nikbg3/PhobosLT_pooling](https://github.com/nikbg3/PhobosLT_pooling), itself based on PhobosLT.

**Race timing**
 - The timer detects the first gate pass itself; lap 1 is timed from that pass
 - Fixed an out-of-bounds write on the first pass, lap times paired with the wrong lap, and duplicate laps after *Clear* or a page reload
 - Race clock based on elapsed time (stays correct with the screen off)

**Battery and buzzer**
 - Low battery alarm setting back in the UI; off by default (on USB power it would beep constantly)
 - Fixed a race condition that could permanently corrupt the battery reading

**WiFi**
 - Hotspot `LapTimer_xxxx 192.168.4.1`, password `laptimer`; no captive portal
 - Home WiFi: waits 60 s before falling back to the hotspot, and reconnects after dropouts instead of giving up
 - `http://laptimer.local` on the home WiFi, *Forget home WiFi* button
 - Settings are saved before a restart

**Web UI**
 - Redesigned, light and dark theme, contrast checked (WCAG AA), no extra libraries
 - Announcements always in English, using the browser's built-in speech; *Test voice* reports the result
 - Voice commands match whole words and ignore the announcer's own voice
 - Save confirmation, battery voltage, live RSSI, fastest lap highlighted

**Build**
 - Builds with current libraries (`#include <WiFi.h>`, ElegantOTA pinned to 3.1.6)

## Updating

 - Over WiFi (timer on your home WiFi): open `http://laptimer.local/update` and upload
   `.pio/build/PhobosLT/firmware.bin` (Firmware) or `littlefs.bin` (LittleFS / Filesystem).
 - Over USB: `pio run -e PhobosLT -t upload` and `pio run -e PhobosLT -t uploadfs`.
   If the board doesn't enter flash mode, hold BOOT and tap EN.
