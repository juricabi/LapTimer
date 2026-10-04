// JSON API used by the web page (race, pilots, history, profiles, WiFi, device info)
#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <esp_wifi.h>
#include <esp_phy_init.h>

#include "debug.h"
#include "webserver.h"

extern AsyncWebServer server;
extern const char *wifi_hostname;
extern String wifi_ap_ssid;

static void sendOk(AsyncWebServerRequest *request)
{
    request->send(200, "application/json", "{\"status\":\"OK\"}");
}

// Responses are built in memory and sent in one piece. (A response stream is drained one
// byte at a time, O(n^2), and the web task can run on the timing core while it does.)
static void sendJson(AsyncWebServerRequest *request, JsonDocument &doc)
{
    String body;
    serializeJson(doc, body);
    request->send(200, "application/json", body);
}

// Appends "[a,b,c]" of 8-bit values
template <typename F>
static void appendArray(String &out, uint16_t count, F value)
{
    out += '[';
    for (uint16_t i = 0; i < count; i++)
    {
        if (i)
            out += ',';
        out += (unsigned)value(i);
    }
    out += ']';
}

static uint32_t bootId = 0; // random per start, so pages notice a restart

// Diagnostics: the last hotspot events with times, to see where joining a phone is slow
struct ApEvent
{
    uint32_t ms;
    uint8_t type; // 0 joined, 1 address handed out, 2 left, 3 offered, 4 refused (NAK), 5 in use by another device,
                  // 6 send failed (ip = error), 7 leases kept across the restart (ip = count), 8 leases cleared (ip = magic found)
    uint8_t mac[6];
    uint32_t ip;
};
static ApEvent apEvents[24];
static volatile uint32_t apEventCount = 0;
static portMUX_TYPE apEventLock = portMUX_INITIALIZER_UNLOCKED; // written from both cores

static void logApEvent(uint8_t type, const uint8_t *mac, uint32_t ip)
{
    uint32_t ms = millis();
    portENTER_CRITICAL(&apEventLock);
    ApEvent &e = apEvents[apEventCount % 24];
    e.ms = ms;
    e.type = type;
    memcpy(e.mac, mac ? mac : (const uint8_t *)"\0\0\0\0\0\0", 6);
    e.ip = ip;
    apEventCount++;
    portEXIT_CRITICAL(&apEventLock);
}

void logHotspotEvent(uint8_t type, const uint8_t *mac, uint32_t ip)
{
    logApEvent(type, mac, ip);
}
extern volatile uint32_t core0RoundsPerSec;
extern uint32_t phyHopOff; // main.cpp: start without deep sleep (diagnostics)
#if CONFIG_IDF_TARGET_ESP32
extern "C" uint8_t phy_set_most_tpw_disbg; // see webserver.cpp, holdTxGain
extern "C" uint8_t chip7_sleep_params[];
static int txPowerLoopOn() { return phy_set_most_tpw_disbg ? 0 : 1; }
static int txGainByte() { return (int8_t)chip7_sleep_params[184]; }
extern "C" uint32_t tx_rf_ana_gain; // calibrated at the first WiFi start after boot, then held
static uint32_t txAnaGain() { return tx_rf_ana_gain; }
extern uint8_t txAnaCalibrated; // webserver.cpp, holdTxGain
static uint8_t txAnaCal() { return txAnaCalibrated; }
#else
static int txPowerLoopOn() { return -1; } // not handled on this chip
static int txGainByte() { return 0; }
static uint32_t txAnaGain() { return 0; }
static uint8_t txAnaCal() { return 0; }
#endif

static uint32_t paramU32(AsyncWebServerRequest *request, const char *name, uint32_t fallback)
{
    if (!request->hasParam(name))
        return fallback;
    return strtoul(request->getParam(name)->value().c_str(), nullptr, 10);
}

void Webserver::registerApi()
{
    if (bootId == 0)
    {
        bootId = (esp_random() & 0x7FFFFFFF) | 1;
        WiFi.onEvent([](WiFiEvent_t event, WiFiEventInfo_t info)
                     {
            if (event == ARDUINO_EVENT_WIFI_AP_STACONNECTED)
                logApEvent(0, info.wifi_ap_staconnected.mac, 0);
            else if (event == ARDUINO_EVENT_WIFI_AP_STADISCONNECTED)
                logApEvent(2, info.wifi_ap_stadisconnected.mac, 0); });
    }

    server.on("/api/debug/aplog", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        String body = String("{\"now\":") + millis() + ",\"events\":[";
        uint32_t n = apEventCount;
        for (uint32_t k = n > 24 ? n - 24 : 0; k < n; k++)
        {
            portENTER_CRITICAL(&apEventLock);
            ApEvent e = apEvents[k % 24];
            portEXIT_CRITICAL(&apEventLock);
            char item[96];
            snprintf(item, sizeof(item), "%s[%u,%u,\"%02x:%02x:%02x:%02x:%02x:%02x\",\"%u.%u.%u.%u\"]",
                     body.endsWith("[") ? "" : ",", e.ms, e.type, e.mac[0], e.mac[1], e.mac[2], e.mac[3], e.mac[4], e.mac[5],
                     e.ip & 255, (e.ip >> 8) & 255, (e.ip >> 16) & 255, e.ip >> 24);
            body += item;
        }
        body += "]}";
        request->send(200, "application/json", body); });

    // Polled by the page: race state, RSSI and lap count
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        char buf[512];
        uint32_t now = millis();
        snprintf(buf, sizeof(buf),
                 "{\"state\":%d,\"mode\":%d,\"cd\":%d,\"race\":%u,\"elapsed\":%d,\"raceMs\":%u,"
                 "\"raceLaps\":%u,\"timeUp\":%d,\"vbat\":%u,\"saveErr\":%d,"
                 "\"savedId\":%u,\"savedRace\":%u,\"spectrum\":%d,\"edits\":%u,\"cfg\":%u,"
                 "\"boot\":%u,\"prof\":%u,\"rssi\":%u,\"laps\":%d,\"fin\":%d}",
                 timer->getState(), timer->getMode(), timer->getCountdown(), timer->getRaceId(),
                 timer->getElapsedMs(now), timer->getRaceMs(), timer->getRaceLaps(), timer->isTimeUp(),
                 monitor->getBatteryVoltage(), !history->lastSaveOk,
                 history->lastSavedId, history->lastSavedRaceId, timer->isSpectrumRunning(),
                 timer->getEditCount(), conf->getRevision(), bootId, history->profilesRevision,
                 timer->getRssi(), timer->getLapCount(), timer->isFinished());
        request->send(200, "application/json", buf); });

    // Full lap data of the current (or last) race
    server.on("/api/race", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        timer->raceToJson(doc.to<JsonObject>());
        sendJson(request, doc); });

    // RSSI history (max per 25 ms) since a sequence number, for the calibration graph
    server.on("/api/rssi", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        uint32_t seq = timer->getHistorySeq();
        uint32_t since = paramU32(request, "since", 0);
        if (since > seq || seq - since > RSSI_HISTORY - 1)
            since = seq > RSSI_HISTORY - 1 ? seq - (RSSI_HISTORY - 1) : 0;
        String body;
        body.reserve(48 + (seq - since) * 4);
        body += "{\"seq\":";
        body += seq;
        body += ",\"step\":";
        body += RSSI_HISTORY_STEP_MS;
        body += ",\"rssi\":";
        appendArray(body, seq - since, [&](uint16_t k) { return timer->getHistory(since + 1 + k); });
        body += '}';
        request->send(200, "application/json", body); });

    // Race control; t = browser time (epoch seconds) for the race history
    server.on("/timer/start", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        // busy = already racing, or the previous race is still being saved (the page retries)
        bool queued = timer->requestStart(paramU32(request, "t", 0));
        request->send(queued ? 200 : 409, "application/json",
                      queued ? "{\"status\":\"OK\"}" : "{\"status\":\"busy\"}"); });

    server.on("/timer/stop", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        timer->requestStop();
        sendOk(request); });

    server.on("/timer/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        bool queued = timer->requestClear();
        request->send(queued ? 200 : 409, "application/json",
                      queued ? "{\"status\":\"OK\"}" : "{\"status\":\"busy\"}"); });

    // Race history
    server.on("/api/races", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("id"))
            history->sendRace(request, paramU32(request, "id", 0));
        else
            history->sendList(request); });

    // Lap correction: {id, pilot, op: 0 merge with next / 1 split, lap, expect}.
    // expect = the lap's value as the page shows it; 409 stale if the race changed meanwhile.
    // Not during a race (409 racing): it rewrites files, and a flash write stalls RSSI sampling.
    server.addHandler(new AsyncCallbackJsonWebHandler("/api/races/edit", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        uint32_t id = json["id"] | 0;
        uint8_t pilot = json["pilot"] | 0;
        uint8_t op = json["op"] | 255;
        int lap = json["lap"] | -1;
        int64_t expect = json["expect"].isNull() ? -1 : json["expect"].as<int64_t>();
        int result = history->editRace(id, pilot, op, lap, expect);
        // the race still shown on the Race tab gets the same correction, on the timing core
        if (result == EDIT_OK && pilot == 0 && id == history->lastSavedId && timer->getRaceId() == history->lastSavedRaceId)
        {
            for (int i = 0; i < 50 && !timer->requestEdit(op, lap); i++)
                delay(1); // the previous edit is applied within a loop pass
        }
        if (result == EDIT_OK)
            sendOk(request);
        else if (result == EDIT_STALE)
            request->send(409, "application/json", "{\"status\":\"stale\"}");
        else
            request->send(400, "application/json", "{\"status\":\"invalid\"}"); }));

    // Spectrum scan: ?start=1 starts a scan (not during a race)
    server.on("/api/spectrum", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("start"))
        {
            bool ok = timer->requestSpectrum();
            request->send(ok ? 200 : 409, "application/json",
                          ok ? "{\"status\":\"OK\"}" : "{\"status\":\"busy\"}");
            return;
        }
        char head[128];
        snprintf(head, sizeof(head), "{\"running\":%d,\"done\":%u,\"total\":%u,\"start\":%u,\"step\":%u,\"rssi\":",
                 timer->isSpectrumRunning(), timer->getSpectrumProgress(), SPECTRUM_POINTS * SPECTRUM_SWEEPS,
                 SPECTRUM_START_MHZ, SPECTRUM_STEP_MHZ);
        String body = head;
        appendArray(body, SPECTRUM_POINTS, [this](uint16_t i) { return timer->getSpectrumRssi(i); });
        body += '}';
        request->send(200, "application/json", body); });

    // Diagnostics: load and radio. No temperature: temperatureRead() drives the ADC's sensor
    // block from this core, and all ADC use stays on the timing core (CLAUDE.md, Boot freeze).
    server.on("/api/debug/load", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        // what the radio really uses (settings made before WiFi starts are ignored)
        wifi_mode_t mode = WIFI_MODE_NULL;
        int8_t txPower = 0;
        uint8_t protoAp = 0, protoSta = 0;
        wifi_bandwidth_t bwAp = WIFI_BW_HT20;
        wifi_ps_type_t ps = WIFI_PS_NONE;
        esp_wifi_get_mode(&mode);
        esp_wifi_get_max_tx_power(&txPower);
        esp_wifi_get_protocol(WIFI_IF_AP, &protoAp);
        esp_wifi_get_protocol(WIFI_IF_STA, &protoSta);
        esp_wifi_get_bandwidth(WIFI_IF_AP, &bwAp);
        esp_wifi_get_ps(&ps);
        char buf[384];
        snprintf(buf, sizeof(buf),
                 "{\"samplesPerSec\":%u,\"core0RoundsPerSec\":%u,\"cpuMhz\":%u,"
                 "\"wifiMode\":%d,\"txPowerDbm\":%.2f,\"protoAp\":%u,\"protoSta\":%u,\"bwAp\":%d,\"ps\":%d,"
                 "\"channel\":%d,\"apClients\":%d,\"txLoop\":%d,\"txGain\":%d,\"txAnaGain\":\"%08x\",\"txAnaCal\":\"%02x\",\"rst\":%d}",
                 timer->getSamplesPerSec(), core0RoundsPerSec, getCpuFrequencyMhz(),
                 mode, txPower * 0.25f, protoAp, protoSta, bwAp, ps, WiFi.channel(), WiFi.softAPgetStationNum(), txPowerLoopOn(), txGainByte(), txAnaGain(), txAnaCal(), (int)esp_reset_reason());
        request->send(200, "application/json", buf); });

    // Diagnostics: apply the held transmit gain again, or another value (?k=, until the next
    // WiFi start), to compare levels (/api/debug/load shows txGain). ?a=<code> sets the analog
    // gain too, one of the calibration's codes (webserver.cpp, TX_ANA_CODES; txAnaGain, its
    // start-up calibration is txAnaCal)
    server.on("/api/debug/txgain", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        int ana = request->hasParam("a") ? strtol(request->getParam("a")->value().c_str(), nullptr, 0) : -1;
        if (request->hasParam("a") && !isTxAnaCode(ana))
        {
            request->send(400, "application/json", "{\"status\":\"a: not a calibration code\"}");
            return;
        }
        txAnaRequest = ana;
        txGainRequest = request->hasParam("k") ? constrain(atoi(request->getParam("k")->value().c_str()), -60, 30) : TX_GAIN_BYTE;
        sendOk(request); });

    // Diagnostics: ?on=0 makes the next starts (until a power cycle) calibrate the radio instead
    // of using the stored calibration (main.cpp, phyHopOff), to compare. phyerase: the next
    // start calibrates from scratch and stores that for good, so only on a cold timer
    // (docs/hotspot.md: Stored calibration); not during a race (409 racing): it writes flash
    server.on("/api/debug/phyhop", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        phyHopOff = paramU32(request, "on", 1) ? 0 : PHY_HOP_OFF;
        sendOk(request); });
    server.on("/api/debug/phyerase", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        esp_err_t err = esp_phy_erase_cal_data_in_nvs();
        request->send(200, "application/json", String("{\"status\":\"OK\",\"err\":") + (int)err + "}"); });

    // Diagnostics: switch to the timer's own hotspot until the next restart (saved networks stay).
    // bw=20|40 and ps=0|1 override its channel width and power save, for comparisons.
    server.on("/api/debug/hotspot", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        apWidthMhz = paramU32(request, "bw", 20) == 40 ? 40 : 20;
        apPowerSave = paramU32(request, "ps", 0) != 0;
        sendOk(request);
        hotspotRequested = true; });

    // Diagnostics: receiver response when switching frequency.
    // ?from=5880&to=5800 starts a test; without parameters returns {done, intervalUs, rise, fall}
    server.on("/api/debug/step", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("to"))
        {
            bool ok = timer->requestStepTest(paramU32(request, "from", 5880), paramU32(request, "to", 5800),
                                             paramU32(request, "hops", 0));
            request->send(ok ? 200 : 409, "application/json", ok ? "{\"status\":\"OK\"}" : "{\"status\":\"busy\"}");
            return;
        }
        String body = String("{\"done\":") + (timer->isStepTestDone() ? 1 : 0) +
                      ",\"intervalUs\":" + STEP_TEST_INTERVAL_US + ",\"rise\":";
        appendArray(body, STEP_TEST_HALF, [this](uint16_t i) { return timer->getStepTestSample(i); });
        body += ",\"fall\":";
        appendArray(body, STEP_TEST_HALF, [this](uint16_t i) { return timer->getStepTestSample(STEP_TEST_HALF + i); });
        body += '}';
        request->send(200, "application/json", body); });

    server.on("/api/races/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        history->clear();
        sendOk(request); });

    // A race's own name: {id, name}; an empty name removes it. Two phones: the last rename wins.
    // Not during a race (409 racing): a flash write stalls RSSI sampling.
    server.addHandler(new AsyncCallbackJsonWebHandler("/api/races/rename", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        int result = history->renameRace(json["id"] | 0, json["name"] | "");
        if (result == EDIT_OK)
            sendOk(request);
        else
            request->send(400, "application/json", "{\"status\":\"invalid\"}"); }));

    // Saved pilots: a JSON array [{name, freq, enter, exit, target?}], changed one pilot at a time
    server.on("/api/profiles", HTTP_GET, [this](AsyncWebServerRequest *request)
              { history->sendProfiles(request); });

    // {name, freq, enter, exit, target, prev}: add or update (prev = old name after a rename)
    // Not during a race: a flash write stalls RSSI sampling (the page sends it afterwards)
    server.addHandler(new AsyncCallbackJsonWebHandler("/api/profiles/save", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        // a channel in the 5.8 GHz band; thresholds clamped before they become bytes (400 was 144)
        int freq = json["freq"] | 0;
        if (freq < 5000 || freq > 5999)
        {
            request->send(400, "application/json", "{\"status\":\"invalid\"}");
            return;
        }
        int code = history->saveProfile(json["name"] | "", json["prev"] | "", freq,
                                        constrain(json["enter"] | 0, 0, 255), constrain(json["exit"] | 0, 0, 255),
                                        json["target"] | 0U);
        request->send(code, "application/json",
                      code == 200 ? "{\"status\":\"OK\"}" : code == 507 ? "{\"status\":\"full\"}" : "{\"status\":\"invalid\"}"); }));

    server.addHandler(new AsyncCallbackJsonWebHandler("/api/profiles/remove", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        const char *name = json["name"] | "";
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        if (!name[0])
        {
            request->send(400, "application/json", "{\"status\":\"invalid\"}");
            return;
        }
        bool ok = history->removeProfile(name);
        request->send(ok ? 200 : 507, "application/json", ok ? "{\"status\":\"OK\"}" : "{\"status\":\"full\"}"); }));

    // Saved WiFi networks (names only; passwords never leave the timer). Changes are refused
    // during a race (409 racing): they are written to flash.
    server.on("/api/wifi/saved", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        JsonArray list = doc["networks"].to<JsonArray>();
        for (uint8_t i = 0; i < wifiList->count(); i++)
            list.add(wifiList->ssid(i));
        doc["connected"] = wifiMode == WIFI_STA && WiFi.status() == WL_CONNECTED ? WiFi.SSID() : String("");
        doc["max"] = MAX_WIFI_NETWORKS;
        sendJson(request, doc); });

    server.addHandler(new AsyncCallbackJsonWebHandler("/api/wifi/saved/add", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        bool ok = wifiList->add(json["ssid"] | "", json["pwd"] | "");
        request->send(ok ? 200 : 400, "application/json",
                      ok ? "{\"status\":\"OK\"}" : "{\"status\":\"invalid\"}"); }));

    server.addHandler(new AsyncCallbackJsonWebHandler("/api/wifi/saved/remove", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        wifiList->remove(json["ssid"] | "");
        sendOk(request); }));

    server.on("/api/wifi/saved/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        if (timer->isRacing())
        {
            request->send(409, "application/json", "{\"status\":\"racing\"}");
            return;
        }
        wifiList->clear();
        sendOk(request); });

    // Network scan for the WiFi picker. ?start=1 starts one; it runs one channel at a time in
    // handleWebUpdate (see WIFI_PAGE_SCAN_*), so phones on the hotspot keep their connection.
    server.on("/api/wifi/scan", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("start") && !pageScanActive)
            pageScanRequested = true;
        if (pageScanRequested || pageScanActive)
        {
            request->send(200, "application/json", "{\"scanning\":true}");
            return;
        }
        JsonDocument doc;
        doc["scanning"] = false;
        JsonArray list = doc["networks"].to<JsonArray>();
        for (uint8_t i = 0; i < foundCount; i++)
        {
            JsonObject e = list.add<JsonObject>();
            e["ssid"] = found[i].ssid;
            e["rssi"] = found[i].rssi;
            e["open"] = found[i].open;
        }
        sendJson(request, doc); });

    // Device info for the Setup page
    server.on("/api/info", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        JsonDocument doc;
        bool ap = wifiMode == WIFI_AP;
        doc["version"] = FIRMWARE_VERSION;
        doc["mode"] = ap ? "hotspot" : "wifi";
        doc["ip"] = ap ? WiFi.softAPIP().toString() : WiFi.localIP().toString();
        doc["ssid"] = ap ? wifi_ap_ssid : WiFi.SSID();
        doc["host"] = String(wifi_hostname) + ".local";
        if (!ap)
            doc["signal"] = WiFi.RSSI();
        sendJson(request, doc); });
}
