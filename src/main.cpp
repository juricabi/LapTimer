#include "debug.h"
#include "history.h"
#include "led.h"
#include "webserver.h"
#include <ElegantOTA.h>

static RX5808 rx(PIN_RX5808_RSSI, PIN_RX5808_DATA, PIN_RX5808_SELECT, PIN_RX5808_CLOCK);
static Config config;
static Webserver ws;
static Buzzer buzzer;
static Led led;
static LapTimer timer;
static RaceHistory history;
static BatteryMonitor monitor;

static TaskHandle_t xTimerTask = NULL;

// Core 0: everything except RSSI sampling
static void parallelTask(void *pvArgs) {
    for (;;) {
        uint32_t currentTimeMs = millis();
        buzzer.handleBuzzer(currentTimeMs);
        led.handleLed(currentTimeMs);
        ws.handleWebUpdate(currentTimeMs);
        config.handleEeprom(currentTimeMs);
        monitor.checkBatteryState(currentTimeMs, config.getAlarmThreshold());
        if (timer.savePending) {
            history.save(timer, config);
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
    ws.init(&config, &timer, &history, &monitor, &buzzer, &led);
    led.on(400);
    buzzer.beep(200);
    initParallelTask();
}

// Core 1: RSSI sampling, receiver hopping and lap detection
void loop() {
    timer.update(millis());
    ElegantOTA.loop();
}
