#include "debug.h"
#include "history.h"
#include "led.h"
#include "webserver.h"
#include "wifilist.h"
#include <ElegantOTA.h>

static RX5808 rx(PIN_RX5808_RSSI, PIN_RX5808_DATA, PIN_RX5808_SELECT, PIN_RX5808_CLOCK);
static Config config;
static Webserver ws;
static Buzzer buzzer;
static Led led;
static LapTimer timer;
static RaceHistory history;
static WifiList wifiList;
static BatteryMonitor monitor;

static TaskHandle_t xTimerTask = NULL;

volatile uint32_t core0RoundsPerSec = 0;  // diagnostics (/api/debug/load)

// Core 0: everything except the ADC reads (RSSI and battery, see loop())
static void parallelTask(void *pvArgs) {
    uint32_t rounds = 0, roundsStartMs = 0;
    for (;;) {
        uint32_t currentTimeMs = millis();
        if (++rounds, currentTimeMs - roundsStartMs >= 1000) {
            core0RoundsPerSec = rounds;
            rounds = 0;
            roundsStartMs = currentTimeMs;
        }
        buzzer.handleBuzzer(currentTimeMs);
        led.handleLed(currentTimeMs);
        ws.handleWebUpdate(currentTimeMs);
        config.handleEeprom(currentTimeMs, !timer.isRacing());
        monitor.checkBatteryState(currentTimeMs, config.getAlarmThreshold());
        if (timer.savePending) {
            history.save(timer);
        }
        buzzer.handleBuzzer(currentTimeMs);
        led.handleLed(currentTimeMs);
    }
}

static void initParallelTask() {
    disableCore0WDT();
    xTaskCreatePinnedToCore(parallelTask, "parallelTask", 8192, NULL, 0, &xTimerTask, 0);
}

void setup() {
    DEBUG_INIT;
    config.init();
    rx.init();
    buzzer.init(&config, PIN_BUZZER, BUZZER_INVERTED);
    led.init(PIN_LED, false);
    timer.init(&config, &rx, &buzzer, &led);
    monitor.init(PIN_VBAT, VBAT_SCALE, VBAT_ADD, &buzzer, &led);
    wifiList.init(&config);
    ws.init(&config, &timer, &history, &wifiList, &monitor, &buzzer, &led);
    led.on(400);
    buzzer.beep(200);
    initParallelTask();
}

// Core 1: RSSI sampling, receiver hopping and lap detection, and every other ADC read:
// analogRead() reconfigures the ADC without a lock, and the battery read on core 0 during
// the RSSI sampling here froze about every second boot (CLAUDE.md, Boot freeze)
void loop() {
    uint32_t nowMs = millis();
    timer.update(nowMs);
    monitor.sampleAdc(nowMs);
    ElegantOTA.loop();
}
