# RSSI sampling rate

How fast the timer reads the receiver, what sets that rate, and a faster option kept for later.
Measured on an ESP32 dev board with an RX5808, powered from USB.

## Today (v1.1.0)

The timing core reads the RX5808's RSSI with Arduino's `analogRead()` in a loop and feeds every
reading through a Kalman filter. One `analogRead()` takes about 90 µs: most of it is setup
repeated on every call (pin mode, attenuation, locks) and code run from flash through the
ESP32's cache. So the timer takes 6 500-10 600 readings per second, and which depends on the
build: where the linker places the code decides how often the cache misses.

Same timer, same conditions (`/api/debug/load` → `samplesPerSec`):

| Build | Samples/s |
|---|---|
| v1.1.0, re-release of the morning of 2026-09-30 (`ae181de`) | 8 400-8 750 |
| v1.1.0 (`4ee4de8`) | 6 390-6 540 |
| the same code with a few lines of diagnostics added | 10 600 |
| that build with 2 000 unused instructions added (padding) | 9 420 |

Not the cause: heat (the same rate right after power-up and after running a while), the WiFi
mode, or the hotspot's transmit gain (switching the power loop on and off while running
changed nothing).

It is enough: 6 500/s is still 6-7 readings per millisecond, and a pass lasts tens of
milliseconds. The filter smooths over about 70 readings, so its time constant is ~7 ms at
10 600/s and ~11 ms at 6 500/s; a pass is timed at the middle of its peak either way. Compare
firmware versions only A/B on the same timer.

## Kept for later: fast reads, fixed filter step

On branch `perf/fast-adc` (commit `6dc7bd9`), bench-tested, not flown. Not merged because
6 500-10 000 samples/s is enough. Worth it if the filter's timing should be the same in every
build, or the RSSI should be less noisy.

1. `RX5808::readRssiAdc()` starts the conversion through the ADC's registers, from IRAM
   (classic ESP32, ADC1 pins): ~13 µs, ~78 000 readings/s. `init()` sets the pin, attenuation
   and width up with one `analogRead()` and keeps the ADC powered (`adc_power_acquire()`).
2. `LapTimer::scan()` reads until the next filter step is due and filters the average: one
   step every 100 µs (10 000/s) in every build, each the average of ~8 readings.

```cpp
// RX5808.cpp, classic ESP32 (#include "driver/adc.h" and "soc/sens_struct.h")
uint16_t IRAM_ATTR RX5808::readRssiAdc() {
    SENS.sar_read_ctrl.sar1_dig_force = 0;       // RTC controller, started by software
    SENS.sar_meas_start1.meas1_start_force = 1;
    SENS.sar_meas_start1.sar1_en_pad_force = 1;
    SENS.sar_meas_start1.sar1_en_pad = 1 << adcChannel;
    SENS.sar_meas_start1.meas1_start_sar = 0;
    SENS.sar_meas_start1.meas1_start_sar = 1;
    while (!SENS.sar_meas_start1.meas1_done_sar) {
    }
    return SENS.sar_meas_start1.meas1_data_sar;
}

// LapTimer::scan(): one Kalman step every RSSI_STEP_US (100)
uint32_t sum = 0, n = 0;
do {
    uint16_t raw = rx->readRssiAdc();
    sum += raw > 2047 ? 2047 : raw;
    n++;
} while ((int32_t)(ESP.getCycleCount() - stepDueCycles) < 0);
uint32_t now = ESP.getCycleCount();
stepDueCycles += stepCycles;                    // RSSI_STEP_US * CPU MHz
if ((int32_t)(now - stepDueCycles) >= 0)
    stepDueCycles = now + stepCycles;           // after a pause: start again from now
sample(round(filter.filter((sum / n) >> 3, 0)), nowMs);
```

**Bench results:** 10 000 steps/s and 77 800-77 950 readings/s with 0, 1 000 or 2 000
instructions of padding; the RSSI on the same scale as with `analogRead()` (noise floor 50);
spectrum scan and step test work; device test 22/22; 10/10 boots; hotspot unchanged (-59 to
-63 dBm); all five targets build. C3/S3 keep `analogRead()` with the same 100 µs step: their
ADCs differ, and they haven't been tested.

**Before using it:** add a timeout to the conversion wait (fall back to `analogRead()`, which
sets the ADC up again); fly passes and compare lap detection with the current build
(`tools/rssi_log.py`); check Enter/Exit, as the RSSI is less noisy.
