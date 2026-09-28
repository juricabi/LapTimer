#include <WiFi.h>
#include <ESPAsyncWebServer.h>

#include "battery.h"
#include "history.h"
#include "laptimer.h"
#include "wifilist.h"

#define FIRMWARE_VERSION "1.1.0-dev"

#define WIFI_CONNECTION_TIMEOUT_MS 60000
#define WIFI_RECONNECT_TIMEOUT_MS 500

class Webserver {
   public:
    void init(Config *config, LapTimer *lapTimer, RaceHistory *raceHistory, WifiList *networks, BatteryMonitor *batMonitor, Buzzer *buzzer, Led *l);
    void handleWebUpdate(uint32_t currentTimeMs);

   private:
    void startServices();
    void registerApi();

    Config *conf;
    LapTimer *timer;
    RaceHistory *history;
    WifiList *wifiList;
    BatteryMonitor *monitor;
    Buzzer *buz;
    Led *led;

    wifi_mode_t wifiMode = WIFI_OFF;
    wl_status_t lastStatus = WL_IDLE_STATUS;
    volatile wifi_mode_t changeMode = WIFI_OFF;
    volatile uint32_t changeTimeMs = 0;
    bool servicesStarted = false;
    bool wifiConnected = false;
    bool staScanning = false;
    uint32_t scanStartMs = 0;
    uint8_t scanAttempts = 0;

};
