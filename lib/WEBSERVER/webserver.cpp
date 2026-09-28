#include "webserver.h"
#include <ElegantOTA.h>

#include <ESPmDNS.h>
#include <LittleFS.h>
#include <esp_wifi.h>

#include "debug.h"

static IPAddress netMsk(255, 255, 255, 0);
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
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    esp_wifi_set_protocol(WIFI_IF_STA, WIFI_PROTOCOL_LR);
    esp_wifi_set_protocol(WIFI_IF_AP, WIFI_PROTOCOL_LR);
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

void Webserver::handleWebUpdate(uint32_t currentTimeMs)
{
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
        if (best < 0)
        {
            DEBUG("No saved WiFi network in range\n");
            changeMode = WIFI_AP;
            changeTimeMs = currentTimeMs - WIFI_RECONNECT_TIMEOUT_MS - 1; // switch right away
            wifiMode = WIFI_OFF;
        }
        else
        {
            DEBUG("Joining WiFi %s\n", wifiList->ssid(best));
            WiFi.begin(wifiList->ssid(best), wifiList->password(best));
            changeTimeMs = currentTimeMs;
        }
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
    if (status != WL_CONNECTED && wifiMode == WIFI_STA && (currentTimeMs - changeTimeMs) > WIFI_CONNECTION_TIMEOUT_MS)
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
            WiFi.mode(wifiMode);
            changeTimeMs = currentTimeMs;
            WiFi.softAPConfig(ipAddress, ipAddress, netMsk);
            WiFi.softAP(wifi_ap_ssid.c_str(), wifi_ap_password);
            startServices();
            buz->beep(1000);
            led->on(1000);
            break;
        case WIFI_STA:
            DEBUG("Connecting to WiFi network\n");
            wifiMode = WIFI_STA;
            WiFi.setHostname(wifi_hostname); // hostname must be set before the mode is set to STA
            WiFi.mode(wifiMode);
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
    request->send(LittleFS, "/index.html", "text/html");
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
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        conf->toJson(*response);
        request->send(response);
        led->on(200); });

    AsyncCallbackJsonWebHandler *configJsonHandler = new AsyncCallbackJsonWebHandler("/config", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                                                     {
        JsonObject jsonObj = json.as<JsonObject>();
        conf->fromJson(jsonObj);
        // Older pages send the home WiFi with the settings: keep it in the saved networks
        const char *ssid = jsonObj["ssid"] | "";
        if (ssid[0] != 0 && strcmp(ssid, "undefined") != 0)
            wifiList->add(ssid, jsonObj["pwd"] | "");
        char reply[48];
        snprintf(reply, sizeof(reply), "{\"status\":\"OK\",\"rev\":%u}", conf->getRevision());
        request->send(200, "application/json", reply);
        led->on(200); });


    registerApi();

    server.serveStatic("/", LittleFS, "/").setCacheControl("max-age=600");

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
