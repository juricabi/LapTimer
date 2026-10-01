# To do

## Lap times in the goggles (HDZero, ExpressLRS backpack)

Send the lap, delta and finish straight to the pilot's goggles from the timer's own ESP32,
no extra hardware.

**What is possible (checked October 2026)**
- Only HDZero goggles show text from a race timer (Goggle 1, Goggle 2, BoxPro: their built-in
  ESP32 runs the ELRS VRx backpack). ELRS Backpack 1.5.0 added the race timer; no later
  release adds OSD text for another headset.
- The craft-name route over the ELRS link (TX backpack → TX module → receiver → Betaflight
  craft name, for analog/DJI/Walksnail) was rejected by ELRS: ExpressLRS#2504 and Backpack#123
  closed unmerged (telemetry halves the packet rate; race mode has no telemetry). Don't use it.

**How the goggles listen** (ELRS Backpack `src/Vrx_main.cpp`, `src/Timer_main.cpp`)
- ESP-NOW on WiFi channel 1: the VRx backpack runs in station mode and never sets a channel.
- It accepts a packet only if the sender MAC equals its UID (from the bind phrase), unless it
  is in binding mode. The official timer backpack sets its own STA MAC to the pilot's UID
  before sending (`Timer_main.cpp`, `esp_wifi_set_mac`).
- UID = first 6 bytes of MD5(`-DMY_BINDING_PHRASE="<phrase>"`), first byte with bit 0
  cleared (unicast).
- Text: MSP `MSP_ELRS_SET_OSD` (clear, write string at row/column, display) wrapped in an
  ESP-NOW packet.

**Plan for the main ESP32**
1. Bench test first: build an ESP-NOW vendor action frame by hand (sender and receiver =
   pilot UID) and send it with `esp_wifi_80211_tx()` on channel 1. Check that IDF 4.4
   accepts the frame and that "TEST" shows in the goggles. This keeps the timer's own MAC, so
   the hotspot and home WiFi are untouched and switching pilot costs nothing.
   Fallback if refused: change the STA MAC to the UID like the timer backpack (needs a WiFi
   restart on every pilot switch, drops phones), or a separate small ESP as a timer backpack
   on a UART.
2. Bind phrase per saved pilot. It stays on the timer like WiFi passwords: the page shows only
   whether one is set.
3. Messages: countdown 3-2-1-GO, lap number and time, delta (to best, or to the pace target),
   best lap, finish with a short summary. HDZero shows text of any length at any position.
4. Send on core 0 (web/WiFi core), never on the timing core; repeat each message 2-3 times
   (no acknowledgement).
5. Channel limit: the ESP32 has one radio and can't change channel while connected. Works on
   the timer's hotspot pinned to channel 1 (while goggle messages are on) or a network on
   channel 1; otherwise the page says "Goggle messages need channel 1: your network is on
   channel N".
6. Extra transmitting next to the hotspot: re-measure with `tools/hotspot_signal.py` and
   check `/api/debug/load` (see "Transmit power fade" in CLAUDE.md).
7. Test with HDZero goggles: delay after the pass, lost messages, range at the gate.
