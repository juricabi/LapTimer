// JSON API used by the web page (race, pilots, history, profiles, WiFi, device info)
#include <ArduinoJson.h>
#include <AsyncJson.h>

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

static uint32_t paramU32(AsyncWebServerRequest *request, const char *name, uint32_t fallback)
{
    if (!request->hasParam(name))
        return fallback;
    return strtoul(request->getParam(name)->value().c_str(), nullptr, 10);
}

void Webserver::registerApi()
{
    if (bootId == 0)
        bootId = (esp_random() & 0x7FFFFFFF) | 1;

    // Polled by the page: race state and per-pilot RSSI / lap counts
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        char buf[640];
        uint32_t now = millis();
        int n = snprintf(buf, sizeof(buf),
                         "{\"state\":%d,\"mode\":%d,\"cd\":%d,\"race\":%u,\"elapsed\":%d,\"raceMs\":%u,"
                         "\"raceLaps\":%u,\"timeUp\":%d,\"stag\":%d,\"vbat\":%u,\"saveErr\":%d,"
                         "\"savedId\":%u,\"savedRace\":%u,\"spectrum\":%d,\"edits\":%u,\"cfg\":%u,"
                         "\"boot\":%u,\"prof\":%u,\"pilots\":[",
                         timer->getState(), timer->getMode(), timer->getCountdown(), timer->getRaceId(),
                         timer->getElapsedMs(now), timer->getRaceMs(), timer->getRaceLaps(), timer->isTimeUp(),
                         timer->getStaggered(), monitor->getBatteryVoltage(), !history->lastSaveOk,
                         history->lastSavedId, history->lastSavedRaceId, timer->isSpectrumRunning(),
                         timer->getEditCount(), conf->getRevision(), bootId, history->profilesRevision);
        // configured pilots (live RSSI) and the race's pilots (laps), whichever is more
        uint8_t count = conf->getPilotCount();
        if ((timer->isRacing() || timer->hasRaceData()) && timer->getPilotCount() > count)
            count = timer->getPilotCount();
        for (uint8_t i = 0; i < count && n < (int)sizeof(buf) - 64; i++)
        {
            n += snprintf(buf + n, sizeof(buf) - n, "%s{\"rssi\":%u,\"laps\":%d,\"fin\":%d}",
                          i ? "," : "", timer->getRssi(i), timer->getLapCount(i), timer->isFinished(i));
        }
        snprintf(buf + n, sizeof(buf) - n, "]}");
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
        uint8_t count = timer->isRacing() ? timer->getPilotCount() : conf->getPilotCount();
        String body;
        body.reserve(48 + count * ((seq - since) * 4 + 3));
        body += "{\"seq\":";
        body += seq;
        body += ",\"step\":";
        body += RSSI_HISTORY_STEP_MS;
        body += ",\"pilots\":[";
        for (uint8_t i = 0; i < count; i++)
        {
            if (i)
                body += ',';
            appendArray(body, seq - since, [&](uint16_t k) { return timer->getHistory(i, since + 1 + k); });
        }
        body += "]}";
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
    // expect = the lap's value as the page shows it; 409 if the race changed meanwhile.
    server.addHandler(new AsyncCallbackJsonWebHandler("/api/races/edit", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        uint32_t id = json["id"] | 0;
        uint8_t pilot = json["pilot"] | 0;
        uint8_t op = json["op"] | 255;
        int lap = json["lap"] | -1;
        int64_t expect = json["expect"].isNull() ? -1 : json["expect"].as<int64_t>();
        int result = history->editRace(id, pilot, op, lap, expect);
        // the race still shown on the Race tab gets the same correction, on the timing core
        if (result == EDIT_OK && id == history->lastSavedId && timer->getRaceId() == history->lastSavedRaceId)
        {
            for (int i = 0; i < 50 && !timer->requestEdit(pilot, op, lap); i++)
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

    // Diagnostics: receiver response when switching frequency.
    // ?from=5880&to=5800 starts a test; without parameters returns {done, intervalUs, rise, fall}
    server.on("/api/debug/step", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("to"))
        {
            bool ok = timer->requestStepTest(paramU32(request, "from", 5880), paramU32(request, "to", 5800));
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
        history->clear();
        sendOk(request); });

    // Saved pilots: a JSON array [{name, freq, enter, exit}], changed one pilot at a time
    server.on("/api/profiles", HTTP_GET, [this](AsyncWebServerRequest *request)
              { history->sendProfiles(request); });

    // {name, freq, enter, exit, prev}: add or update (prev = old name after a rename)
    server.addHandler(new AsyncCallbackJsonWebHandler("/api/profiles/save", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        int code = history->saveProfile(json["name"] | "", json["prev"] | "", json["freq"] | 0,
                                        json["enter"] | 0, json["exit"] | 0);
        request->send(code, "application/json",
                      code == 200 ? "{\"status\":\"OK\"}" : code == 507 ? "{\"status\":\"full\"}" : "{\"status\":\"invalid\"}"); }));

    server.addHandler(new AsyncCallbackJsonWebHandler("/api/profiles/remove", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        bool ok = history->removeProfile(json["name"] | "");
        request->send(ok ? 200 : 507, "application/json", ok ? "{\"status\":\"OK\"}" : "{\"status\":\"full\"}"); }));

    // Saved WiFi networks (names only; passwords never leave the timer)
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
        bool ok = wifiList->add(json["ssid"] | "", json["pwd"] | "");
        request->send(ok ? 200 : 400, "application/json",
                      ok ? "{\"status\":\"OK\"}" : "{\"status\":\"invalid\"}"); }));

    server.addHandler(new AsyncCallbackJsonWebHandler("/api/wifi/saved/remove", [this](AsyncWebServerRequest *request, JsonVariant &json)
                                                      {
        wifiList->remove(json["ssid"] | "");
        sendOk(request); }));

    server.on("/api/wifi/saved/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        wifiList->clear();
        sendOk(request); });

    // WiFi scan for the home WiFi picker. ?start=1 starts a new scan.
    server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        static uint32_t scanStartMs = 0;
        if (request->hasParam("start"))
        {
            WiFi.scanDelete();
            WiFi.scanNetworks(true);
            scanStartMs = millis();
            request->send(200, "application/json", "{\"scanning\":true}");
            return;
        }
        int16_t n = WiFi.scanComplete();
        // the library reports a scan longer than 6 s as failed although it finishes shortly after
        if (n == WIFI_SCAN_RUNNING || (n == WIFI_SCAN_FAILED && millis() - scanStartMs < 12000))
        {
            request->send(200, "application/json", "{\"scanning\":true}");
            return;
        }
        JsonDocument doc;
        doc["scanning"] = false;
        JsonArray list = doc["networks"].to<JsonArray>();
        for (int16_t i = 0; i < n; i++)
        {
            String ssid = WiFi.SSID(i);
            if (ssid.length() == 0)
                continue;
            bool duplicate = false;
            for (JsonObject e : list)
            {
                if (ssid == e["ssid"].as<const char *>())
                    duplicate = true;
            }
            if (duplicate)
                continue;
            JsonObject e = list.add<JsonObject>();
            e["ssid"] = ssid;
            e["rssi"] = WiFi.RSSI(i);
            e["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
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
        doc["maxPilots"] = MAX_PILOTS;
        sendJson(request, doc); });
}
