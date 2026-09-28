#include <WiFi.h>
#include <ESPAsyncWebServer.h>

#include "battery.h"
#include "history.h"
#include "laptimer.h"

#define FIRMWARE_VERSION "1.1.0-dev"

#define WIFI_CONNECTION_TIMEOUT_MS 60000
#define WIFI_RECONNECT_TIMEOUT_MS 500
#define WEB_RSSI_SEND_TIMEOUT_MS 200

class Webserver {
   public:
    void init(Config *config, LapTimer *lapTimer, RaceHistory *raceHistory, BatteryMonitor *batMonitor, Buzzer *buzzer, Led *l);
    void handleWebUpdate(uint32_t currentTimeMs);

   private:
    void startServices();
    void registerApi();

    Config *conf;
    LapTimer *timer;
    RaceHistory *history;
    BatteryMonitor *monitor;
    Buzzer *buz;
    Led *led;

    wifi_mode_t wifiMode = WIFI_OFF;
    wl_status_t lastStatus = WL_IDLE_STATUS;
    volatile wifi_mode_t changeMode = WIFI_OFF;
    volatile uint32_t changeTimeMs = 0;
    bool servicesStarted = false;
    bool wifiConnected = false;

};
