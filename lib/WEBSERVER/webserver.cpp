#include "webserver.h"
#include <ElegantOTA.h>

#include <ESPmDNS.h>
#include <LittleFS.h>
#include <esp_wifi.h>

#include "debug.h"
#include "hotspotdhcp.h"

static IPAddress netMsk(255, 255, 255, 0);
static HotspotDhcp hotspotDhcp;
#if CONFIG_IDF_TARGET_ESP32
// Transmit power (classic ESP32, CLAUDE.md: Transmit power fade). The radio library's power
// loop measures every 5th frame and steps a gain byte (chip7_sleep_params[184], [185]). The
// tuned RX5808 leaks into its power detector on many channels, so the loop keeps stepping
// down; the byte has no lower limit and wraps from -128 to +127: the transmitter fades ~30 dB
// and jumps back every few minutes. So the loop stays off (phy_set_most_tpw_disbg) and the
// byte is set to TX_GAIN_BYTE and applied. The library clears the flag whenever it applies a
// TX power (WiFi start, mode change): holdTxGain() runs again then.
extern "C" uint8_t phy_set_most_tpw_disbg;
extern "C" uint8_t chip7_sleep_params[];
extern "C" uint32_t phy_enter_critical(void);
extern "C" void phy_exit_critical(uint32_t);
extern "C" void tx_gain_table_set(void);
static void holdTxGain(int8_t gain = TX_GAIN_BYTE)
{
    phy_set_most_tpw_disbg = 1;
    uint32_t state = phy_enter_critical();
    chip7_sleep_params[184] = gain;
    chip7_sleep_params[185] = gain;
    tx_gain_table_set();
    phy_exit_critical(state);
}
#else
static void holdTxGain(int8_t gain = TX_GAIN_BYTE) { (void)gain; } // the other chips' radio libraries differ
#endif
void logHotspotEvent(uint8_t type, const uint8_t *mac, uint32_t ip); // api.cpp (diagnostics)
static IPAddress ipAddress;
AsyncWebServer server(80);  // shared with api.cpp

const char *wifi_hostname = "laptimer";
static const char *wifi_ap_ssid_prefix = "LapTimer";
static const char *wifi_ap_password = "laptimer";
// Private address, shown in the hotspot name (e.g. "LapTimer_BD58 192.168.4.1")
static const char *wifi_ap_address = "192.168.4.1";
String wifi_ap_ssid;

void Webserver::init(Config *config, LapTimer *lapTimer, RaceHistory *raceHistory, WifiList *networks, BatteryMonitor *batMonitor, Buzzer *buzzer, Led *l)
{
    history = raceHistory;
    wifiList = networks;

    ipAddress.fromString(wifi_ap_address);

    conf = config;
    timer = lapTimer;
    monitor = batMonitor;
    buz = buzzer;
    led = l;

    wifi_ap_ssid = String(wifi_ap_ssid_prefix) + "_" + WiFi.macAddress().substring(WiFi.macAddress().length() - 6);
    wifi_ap_ssid.replace(":", "");
    // Show the address in the WiFi name, so users know where to open the page
    wifi_ap_ssid += String(" ") + wifi_ap_address;

    WiFi.persistent(false);
    WiFi.disconnect();
    WiFi.mode(WIFI_OFF);
    // radio settings are applied after WiFi has started (see WIFI_AP / WIFI_STA below):
    // before that the ESP32 ignores them
    if (wifiList->count() == 0)
    {
        changeMode = WIFI_AP;
    }
    else
    {
        changeMode = WIFI_STA;
    }
    changeTimeMs = millis();
    lastStatus = WL_DISCONNECTED;
}

// One channel per step, with a pause on the hotspot's channel in between
void Webserver::pageScanStep(uint32_t nowMs)
{
    if (pageScanRequested && !staScanning)
    {
        foundCount = 0;
        pageScanChannel = 1;
        pageScanTry = 0;
        pageScanChannelRunning = false;
        pageScanAtMs = nowMs;
        pageScanActive = true;     // before the request clears: /api/wifi/scan always sees one of them
        pageScanRequested = false;
        WiFi.scanDelete();
    }
    if (!pageScanActive)
        return;
    if (!pageScanChannelRunning)
    {
        if ((int32_t)(nowMs - pageScanAtMs) < 0 || WiFi.scanComplete() == WIFI_SCAN_RUNNING)
            return; // pause on the hotspot's channel, or a scan still finishing
        // started directly: WiFi.scanNetworks() stays at least 100 ms per channel. The
        // library still collects the results (scanComplete / SSID / RSSI) on SCAN_DONE.
        WiFi.scanDelete();
        wifi_scan_config_t config = {};
        config.channel = pageScanChannel;
        if (pageScanChannel >= 12)
        {
            config.scan_type = WIFI_SCAN_TYPE_PASSIVE;
            config.scan_time.passive = WIFI_PAGE_SCAN_PASSIVE_MS;
        }
        else
        {
            config.scan_type = WIFI_SCAN_TYPE_ACTIVE;
            config.scan_time.active.min = 0;
            config.scan_time.active.max = WIFI_PAGE_SCAN_ACTIVE_MS;
        }
        if (esp_wifi_scan_start(&config, false) != ESP_OK)
        {
            // busy (e.g. the station is connecting): this channel again shortly, or skip it
            pageScanAtMs = nowMs + WIFI_PAGE_SCAN_PAUSE_MS;
            if (++pageScanTry >= WIFI_PAGE_SCAN_TRIES)
            {
                pageScanTry = 0;
                if (++pageScanChannel > WIFI_PAGE_SCAN_CHANNELS)
                    pageScanActive = false;
            }
            return;
        }
        pageScanChannelRunning = true;
        pageScanAtMs = nowMs;
        return;
    }
    // started directly, so the library only knows it once SCAN_DONE has arrived (n >= 0)
    int16_t n = WiFi.scanComplete();
    if (n < 0 && nowMs - pageScanAtMs < WIFI_PAGE_SCAN_WAIT_MS)
        return;
    if (n < 0)
        esp_wifi_scan_stop(); // timed out
    if (n < 0 && ++pageScanTry < WIFI_PAGE_SCAN_TRIES)
    {
        // failed or timed out: this channel again after the pause
        WiFi.scanDelete();
        pageScanChannelRunning = false;
        pageScanAtMs = nowMs + WIFI_PAGE_SCAN_PAUSE_MS;
        return;
    }
    pageScanTry = 0;
    for (int16_t i = 0; i < n; i++)
    {
        String ssid = WiFi.SSID(i);
        if (ssid.length() == 0)
            continue;
        int k = 0;
        while (k < foundCount && strcmp(found[k].ssid, ssid.c_str()) != 0)
            k++;
        if (k == foundCount)
        {
            if (foundCount >= WIFI_PAGE_SCAN_MAX)
                continue;
            strlcpy(found[k].ssid, ssid.c_str(), sizeof(found[k].ssid));
            found[k].rssi = -127;
            foundCount++;
        }
        if (WiFi.RSSI(i) > found[k].rssi)
            found[k].rssi = WiFi.RSSI(i);
        found[k].open = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
    }
    WiFi.scanDelete();
    pageScanChannelRunning = false;
    pageScanAtMs = nowMs + WIFI_PAGE_SCAN_PAUSE_MS;
    if (++pageScanChannel > WIFI_PAGE_SCAN_CHANNELS)
        pageScanActive = false; // done: the results are complete before this flag clears
}

void Webserver::handleWebUpdate(uint32_t currentTimeMs)
{
    if (hotspotRequested)
    {
        // /api/debug/hotspot (applied here, on the core that runs this state machine)
        hotspotRequested = false;
        staScanning = false; // a boot scan still running must not join a network under the hotspot
        changeMode = WIFI_AP;
        changeTimeMs = currentTimeMs; // after WIFI_RECONNECT_TIMEOUT_MS, so the reply goes out first
        wifiMode = WIFI_OFF;
    }
    if (txGainRequest != TX_GAIN_NONE)
    {
        holdTxGain(txGainRequest); // /api/debug/txgain
        txGainRequest = TX_GAIN_NONE;
    }
    pageScanStep(currentTimeMs);
#if CONFIG_IDF_TARGET_ESP32
    if (wifiMode != WIFI_OFF && !phy_set_most_tpw_disbg)
        holdTxGain(); // the library applied a TX power again, which let its loop run
#endif

    // Power-up scan for saved networks: join the strongest one in range, or use the hotspot
    if (staScanning)
    {
        int16_t found = WiFi.scanComplete();
        // The WiFi library reports WIFI_SCAN_FAILED once a scan takes longer than
        // 20 x 300 ms = 6 s, but a full scan here takes ~5.95 s and is a little slower on
        // the first boot after an update. The real result still arrives a moment later,
        // so keep waiting for it (up to 12 s) instead of treating that as a failure.
        if ((found == WIFI_SCAN_RUNNING || found == WIFI_SCAN_FAILED) && (currentTimeMs - scanStartMs) < 12000)
        {
            return;
        }
        staScanning = false;
        DEBUG("WiFi scan result %d after %u ms\n", found, currentTimeMs - scanStartMs);
        int best = found > 0 ? wifiList->pickBest(found) : -1;
        WiFi.scanDelete();
        if (found < 0)
        {
            // The scan itself failed (can happen right after power-up): just try the newest network
            DEBUG("WiFi scan failed, trying the newest saved network\n");
            best = 0;
        }
        else if (best < 0 && ++scanAttempts < 3)
        {
            // Networks sometimes don't show up in the first scan: look again before giving up
            DEBUG("No saved WiFi network found, scanning again\n");
            WiFi.scanNetworks(true);
            staScanning = true;
            scanStartMs = currentTimeMs;
            return;
        }
        connectTimeoutMs = WIFI_CONNECTION_TIMEOUT_MS;
        if (best < 0)
        {
            // Not seen by name: it may be hidden, or still starting up (a phone hotspot
            // switched on with the timer). Try the newest one anyway, briefly, before the
            // hotspot (away from home the hotspot shouldn't take long).
            DEBUG("No saved WiFi network seen, trying the newest one\n");
            best = 0;
            connectTimeoutMs = WIFI_UNSEEN_TIMEOUT_MS;
        }
        if (wifiList->count() == 0)
        {
            // the list was emptied during the scan
            changeMode = WIFI_AP;
            changeTimeMs = currentTimeMs - WIFI_RECONNECT_TIMEOUT_MS - 1; // switch right away
            wifiMode = WIFI_OFF;
            return;
        }
        DEBUG("Joining WiFi %s\n", wifiList->ssid(best));
        WiFi.begin(wifiList->ssid(best), wifiList->password(best));
        changeTimeMs = currentTimeMs;
    }

    wl_status_t status = WiFi.status();

    if (status != lastStatus && wifiMode == WIFI_STA)
    {
        DEBUG("WiFi status = %u\n", status);
        switch (status)
        {
        case WL_NO_SSID_AVAIL:
        case WL_CONNECT_FAILED:
        case WL_CONNECTION_LOST:
        case WL_DISCONNECTED:
            // Don't give up on the first failure: these statuses also show up
            // briefly while the network is still being found. Before the first
            // connection, the timeout below falls back to AP mode; after a
            // dropout, it keeps reconnecting instead of abandoning the network.
            if (wifiConnected)
            {
                changeTimeMs = currentTimeMs;
            }
            break;
        case WL_CONNECTED:
            buz->beep(200);
            led->off();
            wifiConnected = true;
            break;
        default:
            break;
        }
        lastStatus = status;
    }
    if (status != WL_CONNECTED && wifiMode == WIFI_STA && (currentTimeMs - changeTimeMs) > (wifiConnected ? WIFI_CONNECTION_TIMEOUT_MS : connectTimeoutMs))
    {
        changeTimeMs = currentTimeMs;
        if (!wifiConnected)
        {
            changeMode = WIFI_AP; // if we didnt manage to ever connect to wifi network
        }
        else
        {
            DEBUG("WiFi Connection failed, reconnecting\n");
            WiFi.reconnect();
            startServices();
            buz->beep(100);
            led->blink(200);
        }
    }
    if (changeMode != wifiMode && changeMode != WIFI_OFF && (currentTimeMs - changeTimeMs) > WIFI_RECONNECT_TIMEOUT_MS)
    {
        switch (changeMode)
        {
        case WIFI_AP:
            DEBUG("Changing to WiFi AP mode\n");

            WiFi.disconnect();
            wifiMode = WIFI_AP;
            WiFi.setHostname(wifi_hostname); // hostname must be set before the mode is set to STA
            // with the station interface on (idle): a network scan then never switches
            // modes, which restarted the hotspot and dropped its phones
            WiFi.mode(WIFI_AP_STA);
            holdTxGain(); // fixed transmit gain (see its declaration)
            timer->enableReceiver(); // the transmitter is calibrated now
            // 20 MHz: the default 40 MHz in the crowded 2.4 GHz band lost packets (DHCP took
            // up to 40 s, phones gave up). No power save: the hotspot must hear its phones.
            esp_wifi_set_bandwidth(WIFI_IF_AP, apWidthMhz == 40 ? WIFI_BW_HT40 : WIFI_BW_HT20);
            esp_wifi_set_ps(apPowerSave ? WIFI_PS_MIN_MODEM : WIFI_PS_NONE);
            // transmit power: left at the default maximum (asking for 19.5 dBm gives 18 dBm)
            changeTimeMs = currentTimeMs;
            WiFi.softAPConfig(ipAddress, ipAddress, netMsk);
            WiFi.softAP(wifi_ap_ssid.c_str(), wifi_ap_password);
            hotspotDhcp.onEvent = logHotspotEvent;
            hotspotDhcp.begin(ipAddress, netMsk); // replaces the built-in DHCP server (unicast replies)
            startServices();
            buz->beep(1000);
            led->on(1000);
            break;
        case WIFI_STA:
            DEBUG("Connecting to WiFi network\n");
            wifiMode = WIFI_STA;
            WiFi.setHostname(wifi_hostname); // hostname must be set before the mode is set to STA
            WiFi.mode(wifiMode);
            holdTxGain(); // fixed transmit gain (see its declaration)
            timer->enableReceiver(); // the transmitter is calibrated now
            changeTimeMs = currentTimeMs;
            // look for the saved networks first (handled at the top of this function)
            WiFi.scanNetworks(true);
            staScanning = true;
            scanStartMs = currentTimeMs;
            startServices();
            led->blink(200);
        default:
            break;
        }

        changeMode = WIFI_OFF;
    }
}


// No captive portal: phones just see a WiFi without internet, and the page is
// opened in the normal browser at the address shown in the WiFi name.
static void handleRoot(AsyncWebServerRequest *request)
{
    // always fresh, so it points to the current ?v= of style.css / script.js
    AsyncWebServerResponse *response = request->beginResponse(LittleFS, "/index.html", "text/html");
    if (!response)
    {
        // web files missing (only the firmware was flashed, or the file system is damaged)
        request->send(500, "text/plain", "LapTimer: the web files are missing. Upload the web files (littlefs.bin) on the update page.");
        return;
    }
    response->addHeader("Cache-Control", "no-cache");
    request->send(response);
}

static void handleNotFound(AsyncWebServerRequest *request)
{
    String message = F("File Not Found\n\n");
    message += F("URI: ");
    message += request->url();
    message += F("\nMethod: ");
    message += request->method();
    message += F("\nArguments: ");
    message += request->args();
    message += F("\n");

    for (uint8_t i = 0; i < request->args(); i++)
    {
        message += String(F(" ")) + request->argName(i) + F(": ") + request->arg(i) + F("\n");
    }
    AsyncWebServerResponse *response = request->beginResponse(404, "text/plain", message);
    response->addHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    response->addHeader("Pragma", "no-cache");
    response->addHeader("Expires", "-1");
    request->send(response);
}

static bool startLittleFS()
{
    if (!LittleFS.begin())
    {
        DEBUG("LittleFS mount failed\n");
        return false;
    }
    DEBUG("LittleFS mounted sucessfully\n");
    return true;
}

// Task used to delay and then restart the ESP
static void restart_task(void *pvParameters)
{
    uint32_t delayMs = (uint32_t)(uintptr_t)pvParameters;
    vTaskDelay(pdMS_TO_TICKS(delayMs));
    ESP.restart();
    vTaskDelete(NULL);
}

static void startMDNS()
{
    if (!MDNS.begin(wifi_hostname))
    {
        DEBUG("Error starting mDNS\n");
        return;
    }

    String instance = String(wifi_hostname) + "_" + WiFi.macAddress();
    instance.replace(":", "");
    MDNS.setInstanceName(instance);
    MDNS.addService("http", "tcp", 80);
}

void Webserver::startServices()
{
    if (servicesStarted)
    {
        MDNS.end();
        startMDNS();
        return;
    }

    startLittleFS();
    history->init();

    server.on("/", handleRoot);


    server.on("/status", [this](AsyncWebServerRequest *request)
              {
        static char buf[2048];
        static char configBuf[1024];
        conf->toJsonString(configBuf, sizeof(configBuf));
        float voltage = (float)monitor->getBatteryVoltage() / 10;
        const char *format =
            "\
Heap:\n\
\tFree:\t%i\n\
\tMin:\t%i\n\
\tSize:\t%i\n\
\tAlloc:\t%i\n\
LittleFS:\n\
\tUsed:\t%i\n\
\tTotal:\t%i\n\
Chip:\n\
\tModel:\t%s Rev %i, %i Cores, SDK %s\n\
\tFlashSize:\t%i\n\
\tFlashSpeed:\t%iMHz\n\
\tCPU Speed:\t%iMHz\n\
Network:\n\
\tIP:\t%s\n\
\tMAC:\t%s\n\
EEPROM:\n\
%s\n\
Battery Voltage:\t%0.1fv";

        snprintf(buf, sizeof(buf), format,
                 ESP.getFreeHeap(), ESP.getMinFreeHeap(), ESP.getHeapSize(), ESP.getMaxAllocHeap(), LittleFS.usedBytes(), LittleFS.totalBytes(),
                 ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(), ESP.getSdkVersion(), ESP.getFlashChipSize(), ESP.getFlashChipSpeed() / 1000000, getCpuFrequencyMhz(),
                 WiFi.localIP().toString().c_str(), WiFi.macAddress().c_str(), configBuf, voltage);
        request->send(200, "text/plain", buf);
        led->on(200); });

    server.on("/restart", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        // Save pending settings now: they are normally written up to 1 s later,
        // so a restart right after Save could otherwise lose them
        conf->write();
        // reply OK and then schedule a short delayed restart so response is sent
        request->send(200, "application/json", "{\"status\": \"OK\"}");
        led->on(200);
        // create a small task to restart after 500ms to allow response to be transmitted
        const uint32_t delayMs = 500;
        xTaskCreatePinnedToCore(restart_task, "restart_task", 2048, (void *)(uintptr_t)delayMs, 1, NULL, 1);
    });

    server.on("/config", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        String body;
        conf->toJson(body);
        request->send(200, "application/json", body);
        led->on(200); });

    AsyncCallbackJsonWebHandler *configJsonHandler = new AsyncCallbackJsonWebHandler("/config", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                                                     {
        JsonObject jsonObj = json.as<JsonObject>();
        // base = revision before this change: if the page's known revision differs,
        // another device changed settings in between and the page reloads them
        uint32_t base = conf->getRevision();
        conf->fromJson(jsonObj);
        // Older pages send the home WiFi with the settings: keep it in the saved networks
        const char *ssid = jsonObj["ssid"] | "";
        if (ssid[0] != 0 && strcmp(ssid, "undefined") != 0 && !timer->isRacing()) // a flash write
            wifiList->add(ssid, jsonObj["pwd"] | "");
        char reply[64];
        snprintf(reply, sizeof(reply), "{\"status\":\"OK\",\"base\":%u,\"rev\":%u}", base, conf->getRevision());
        request->send(200, "application/json", reply);
        led->on(200); });


    registerApi();

    // The pages are always fetched fresh; they load style.css/script.js with ?v=<content hash>
    // (stamped at build time by tools/stamp_versions.py), so those can be cached for a day.
    server.serveStatic("/update.html", LittleFS, "/update.html").setCacheControl("no-cache");
    server.serveStatic("/index.html", LittleFS, "/index.html").setCacheControl("no-cache");
    server.serveStatic("/", LittleFS, "/").setCacheControl("max-age=86400");

    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Origin", "*");
    DefaultHeaders::Instance().addHeader("Access-Control-Max-Age", "600");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Methods", "POST,GET,OPTIONS");
    DefaultHeaders::Instance().addHeader("Access-Control-Allow-Headers", "*");

    server.onNotFound(handleNotFound);

    server.addHandler(configJsonHandler);

    ElegantOTA.setAutoReboot(true);
    ElegantOTA.begin(&server);

    server.begin();



    startMDNS();

    servicesStarted = true;


}
