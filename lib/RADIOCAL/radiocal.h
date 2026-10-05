#pragma once
#include <stdint.h>

// The radio calibration, kept at its best (classic ESP32; docs/hotspot.md, "Warm starts").
// The ESP32 calibrates its transmitter at the first WiFi start after a reset, from its own
// power detector, and on the test board a warm board came out up to 12 dB weaker. The
// calibration picks an analog gain code from the radio library's table, so that code says how
// a calibration came out and ranks them.
// - A power-on calibrates in full (the stored calibration is erased first, so the library
//   stores the new one itself) and the result is compared with the best kept. Stronger: it
//   becomes the best. Weaker: the best is put back and the timer restarts through deep sleep,
//   which loads it without calibrating. The same: nothing to do.
// - Every other start (restart, update, watchdog) goes through 1 ms of deep sleep for the same
//   reason: the stored best is used as it is.
// The calibration data itself (1894 bytes) is never interpreted, only copied between the
// library's NVS namespace and ours. The other chips' radio libraries differ: nothing is done.
namespace RadioCal {
int rank(int code);                   // place of an analog gain code in the table, strongest first; -1 if none
bool isCode(int code);
void beginBoot();                     // setup(), first of all: decides, may sleep and restart
void afterWifiStart(uint8_t anaCode); // after the first WiFi start, with the code the calibration chose
uint8_t bestCode();                   // 0 = none kept yet
const char *lastEvent();              // what this start did (/api/debug/load: cal)
int resetReason();                    // esp_reset_reason_t of the reset before the deep-sleep hop (which hides it)
bool forget();                        // erase the stored calibration and the best: the next start calibrates
bool setBestCode(int code);           // diagnostics: only the recorded code, to force the next power-on's outcome
void setHop(bool on);                 // diagnostics: off = starts calibrate as the library does, until a power cycle
}  // namespace RadioCal
