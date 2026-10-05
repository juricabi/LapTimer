#include <WiFi.h>
#include <ESPAsyncWebServer.h>

#include "battery.h"
#include "ddns.h"
#include "history.h"
#include "laptimer.h"
#include "wifilist.h"

#define FIRMWARE_VERSION "1.2.5"

#define WIFI_CONNECTION_TIMEOUT_MS 60000
#define WIFI_UNSEEN_TIMEOUT_MS 20000  // joining a network the scan didn't see (hidden or starting up)
// The page's network scan goes one channel at a time, back on the hotspot's channel in
// between, so phones on the hotspot miss it for 40-120 ms at a time instead of the 1.6 s of a
// full scan (the library's own scan stays at least 100 ms per channel). ~4 s in all.
#define WIFI_PAGE_SCAN_ACTIVE_MS 40    // channels 1-11: probe; routers answer within a few ms
#define WIFI_PAGE_SCAN_PASSIVE_MS 120  // channels 12-13 (listen only): just over a beacon interval
#define WIFI_PAGE_SCAN_PAUSE_MS 250
#define WIFI_PAGE_SCAN_CHANNELS 13
#define WIFI_PAGE_SCAN_MAX 24
#define WIFI_PAGE_SCAN_TRIES 3     // a channel scan fails now and then (library state): try again
#define WIFI_PAGE_SCAN_WAIT_MS 1000   // per channel
#define WIFI_RECONNECT_TIMEOUT_MS 500
// transmit gain byte held (webserver.cpp, holdTxGain): the radio's own power loop never goes
// above +19; 0 is its value after boot, about 4 dB weaker (measured)
#define TX_GAIN_BYTE 19
#define TX_GAIN_NONE -1000
// weakest analog gain used (low byte of tx_rf_ana_gain, a code of libphy's table, ranked by
// RadioCal::rank): the radio library's own value before calibrating. The owner's board keeps
// it when started cold and calibrates 0x75 (-8.5 dB) when started warm
#define TX_ANA_GAIN_WEAKEST 0x5f

class Webserver {
   public:
    void init(Config *config, LapTimer *lapTimer, RaceHistory *raceHistory, WifiList *networks, BatteryMonitor *batMonitor, Buzzer *buzzer, Led *l, Ddns *internetName);
    void handleWebUpdate(uint32_t currentTimeMs);

   private:
    void startServices();
    void registerApi();

    // the page's network scan (run by handleWebUpdate, read by /api/wifi/scan)
    struct FoundNetwork {
        char ssid[33];
        int8_t rssi;
        bool open;
    };
    FoundNetwork found[WIFI_PAGE_SCAN_MAX];
    uint8_t foundCount = 0;
    volatile bool pageScanRequested = false;
    volatile bool pageScanActive = false;
    bool pageScanChannelRunning = false;
    uint8_t pageScanChannel = 0;
    uint8_t pageScanTry = 0;
    uint32_t pageScanAtMs = 0;
    void pageScanStep(uint32_t nowMs);

    Config *conf;
    LapTimer *timer;
    RaceHistory *history;
    WifiList *wifiList;
    Ddns *ddns;
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
    uint32_t connectTimeoutMs = WIFI_CONNECTION_TIMEOUT_MS;
    // hotspot radio (the diagnostics can change them until the next restart)
    uint8_t apWidthMhz = 20;
    bool apPowerSave = false;
    volatile bool hotspotRequested = false; // /api/debug/hotspot, applied in handleWebUpdate
    volatile int txGainRequest = TX_GAIN_NONE; // /api/debug/txgain, applied in handleWebUpdate
    volatile int txAnaRequest = -1;            // /api/debug/txgain?a=, stored before txGainRequest

};
