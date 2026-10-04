#include "debug.h"
#include "history.h"
#include "led.h"
#include "webserver.h"
#include "wifilist.h"
#include <ElegantOTA.h>
#include <esp_sleep.h>

// Radio calibration (classic ESP32, docs/hotspot.md: Stored calibration): the first WiFi start
// after a reset calibrates the transmitter, and a warm board came out up to 12 dB weaker. A
// start that wakes from deep sleep skips that and uses the calibration stored in flash
// (esp_phy_load_cal_and_init), so every start first sleeps 1 ms. /api/debug/phyhop?on=0 starts
// without it until a power cycle (diagnostics).
RTC_NOINIT_ATTR uint32_t phyHopOff;

static RX5808 rx(PIN_RX5808_RSSI, PIN_RX5808_DATA, PIN_RX5808_SELECT, PIN_RX5808_CLOCK);
static Config config;
static Webserver ws;
static Buzzer buzzer;
static Led led;
static LapTimer timer;
static RaceHistory history;
static WifiList wifiList;
static BatteryMonitor monitor;

volatile uint32_t core0RoundsPerSec = 0;  // diagnostics (/api/debug/load): service rounds per second

// Everything except the ADC reads (RSSI and battery, see loop()): on core 0, or between the
// samples on a single-core chip
static void serviceRound(uint32_t currentTimeMs) {
    static uint32_t rounds = 0, roundsStartMs = 0;
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

#if !CONFIG_FREERTOS_UNICORE
static TaskHandle_t xTimerTask = NULL;

static void parallelTask(void *pvArgs) {
    for (;;) {
        serviceRound(millis());
    }
}
#endif

static void initParallelTask() {
    disableCore0WDT();
#if !CONFIG_FREERTOS_UNICORE
    xTaskCreatePinnedToCore(parallelTask, "parallelTask", 8192, NULL, 0, &xTimerTask, 0);
#endif
}

void setup() {
#if CONFIG_IDF_TARGET_ESP32
    if (phyHopOff != PHY_HOP_OFF && esp_reset_reason() != ESP_RST_DEEPSLEEP) {
        esp_sleep_enable_timer_wakeup(1000);
        esp_deep_sleep_start();
    }
#endif
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
#if CONFIG_FREERTOS_UNICORE
    // One core (ESP32-C3): Arduino's loop task leaves lower-priority tasks only 5 ms every
    // 2 s, so a separate service task would starve. The service work runs here instead,
    // once per millisecond between the samples.
    static uint32_t lastServiceMs = 0;
    if (nowMs != lastServiceMs) {
        lastServiceMs = nowMs;
        serviceRound(nowMs);
    }
#endif
    ElegantOTA.loop();
}
