#include "battery.h"

#include <Arduino.h>

#include "debug.h"

void BatteryMonitor::init(uint8_t pin, uint8_t batScale, uint8_t batAdd, Buzzer *buzzer, Led *l) {
    buz = buzzer;
    led = l;
    vbatPin = pin;
    scale = batScale;
    add = batAdd;
    state = ALARM_OFF;
    memset(measurements, 0, sizeof(measurements));
    measurementIndex = 0;
    lastCheckTimeMs = millis();
    lastSampleTimeMs = lastCheckTimeMs;
    pinMode(vbatPin, INPUT);

    for (int i = 0; i < AVERAGING_SIZE; i++) {
        sample();  // fill the averaging window
    }
}

// Reads the ADC and updates the cached average. Only called from the task
// running checkBatteryState(), so the sample buffer is never shared.
void BatteryMonitor::sample() {
    // 0-3.3V maps to 0-4095, battery voltage ranges from 4.2V to 3.0V, but the voltage is divided, so 2.1V - 1.5V
    measurements[measurementIndex] = analogRead(vbatPin);
    measurementIndex = (measurementIndex + 1) % AVERAGING_SIZE;

    uint32_t sum = 0;
    for (int i = 0; i < AVERAGING_SIZE; i++) {
        sum += measurements[i];
    }
    voltage = map(sum / AVERAGING_SIZE, 0, 4095, 0, 33 * scale) + add;  // 3.3v ref accuracy, divider + voltage drop
}

uint8_t BatteryMonitor::getBatteryVoltage() {
    return voltage;
}

void BatteryMonitor::checkBatteryState(uint32_t currentTimeMs, uint8_t alarmThreshold) {
    if ((currentTimeMs - lastSampleTimeMs) >= MONITOR_SAMPLE_TIME_MS) {
        lastSampleTimeMs = currentTimeMs;
        sample();
    }

    switch (state) {
        case ALARM_OFF:
            if ((alarmThreshold > 0) && ((currentTimeMs - lastCheckTimeMs) > MONITOR_CHECK_TIME_MS)) {
                lastCheckTimeMs = currentTimeMs;
                if (voltage <= alarmThreshold) {
                    DEBUG("Battery alarm: %u <= %u\n", voltage, alarmThreshold);
                    state = ALARM_BEEPING;
                    buz->beep(MONITOR_BEEP_TIME_MS);
                    led->blink(MONITOR_BEEP_TIME_MS);
                }
            }
            break;
        case ALARM_BEEPING:
            if ((currentTimeMs - lastCheckTimeMs) > MONITOR_BEEP_TIME_MS) {
                lastCheckTimeMs = currentTimeMs;
                state = ALARM_IDLE;
            }
            break;
        case ALARM_IDLE:
            if ((currentTimeMs - lastCheckTimeMs) > MONITOR_BEEP_TIME_MS) {
                lastCheckTimeMs = currentTimeMs;
                // alarmThreshold 0 = alarm switched off; +1 adds 0.1V of hysteresis
                if (alarmThreshold > 0 && voltage <= alarmThreshold + 1) {
                    state = ALARM_BEEPING;
                    buz->beep(MONITOR_BEEP_TIME_MS);
                } else {
                    led->off();
                    state = ALARM_OFF;
                }
            }
            break;
        default:
            break;
    }
}
