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

static uint32_t paramU32(AsyncWebServerRequest *request, const char *name, uint32_t fallback)
{
    if (!request->hasParam(name))
        return fallback;
    return strtoul(request->getParam(name)->value().c_str(), nullptr, 10);
}

void Webserver::registerApi()
{
    // Polled by the page: race state and per-pilot RSSI / lap counts
    server.on("/api/status", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        char buf[512];
        uint32_t now = millis();
        int n = snprintf(buf, sizeof(buf),
                         "{\"state\":%d,\"mode\":%d,\"cd\":%d,\"race\":%u,\"elapsed\":%d,\"raceMs\":%u,"
                         "\"raceLaps\":%u,\"timeUp\":%d,\"vbat\":%u,\"pilots\":[",
                         timer->getState(), timer->getMode(), timer->getCountdown(), timer->getRaceId(),
                         timer->getElapsedMs(now), timer->getRaceMs(), timer->getRaceLaps(), timer->isTimeUp(),
                         monitor->getBatteryVoltage());
        // while idle the live pilot settings apply, during/after a race the race's pilots
        uint8_t count = timer->getState() == RACE_IDLE && timer->getLapCount(0) == 0
                            ? conf->getPilotCount()
                            : timer->getPilotCount();
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
        doc["race"] = timer->getRaceId();
        doc["state"] = timer->getState();
        doc["mode"] = timer->getMode();
        doc["cd"] = timer->getCountdown();
        doc["raceMs"] = timer->getRaceMs();
        doc["raceLaps"] = timer->getRaceLaps();
        doc["date"] = timer->getStartEpoch();
        JsonArray pilots = doc["pilots"].to<JsonArray>();
        for (uint8_t i = 0; i < timer->getPilotCount(); i++)
        {
            JsonObject p = pilots.add<JsonObject>();
            p["name"] = conf->getPilotName(i);
            p["freq"] = timer->getRaceFrequency(i);
            p["fin"] = timer->isFinished(i);
            JsonArray laps = p["laps"].to<JsonArray>();
            int count = timer->getLapCount(i); // read once: laps below this index are complete
            for (int l = 0; l < count; l++)
                laps.add(timer->getLap(i, l));
        }
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        serializeJson(doc, *response);
        request->send(response); });

    // RSSI history (max per 25 ms) since a sequence number, for the calibration graph
    server.on("/api/rssi", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        uint32_t seq = timer->getHistorySeq();
        uint32_t since = paramU32(request, "since", 0);
        if (since > seq || seq - since > RSSI_HISTORY - 1)
            since = seq > RSSI_HISTORY - 1 ? seq - (RSSI_HISTORY - 1) : 0;
        uint8_t count = timer->getState() == RACE_IDLE ? conf->getPilotCount() : timer->getPilotCount();
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        response->printf("{\"seq\":%u,\"step\":%u,\"pilots\":[", seq, RSSI_HISTORY_STEP_MS);
        for (uint8_t i = 0; i < count; i++)
        {
            response->print(i ? ",[" : "[");
            for (uint32_t s = since + 1; s <= seq; s++)
                response->printf(s == since + 1 ? "%u" : ",%u", timer->getHistory(i, s));
            response->print("]");
        }
        response->print("]}");
        request->send(response); });

    // Race control; t = browser time (epoch seconds) for the race history
    server.on("/timer/start", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        timer->start(paramU32(request, "t", 0));
        bool armed = timer->getState() != RACE_IDLE && timer->getState() != RACE_FINISHED;
        request->send(armed ? 200 : 409, "application/json",
                      armed ? "{\"status\":\"OK\"}" : "{\"status\":\"busy\"}"); });

    server.on("/timer/stop", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        timer->stop();
        sendOk(request); });

    server.on("/timer/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        timer->clear();
        sendOk(request); });

    // Race history
    server.on("/api/races", HTTP_GET, [this](AsyncWebServerRequest *request)
              {
        if (request->hasParam("id"))
            history->sendRace(request, paramU32(request, "id", 0));
        else
            history->sendList(request); });

    server.on("/api/races/clear", HTTP_POST, [this](AsyncWebServerRequest *request)
              {
        history->clear();
        sendOk(request); });

    // Pilot profiles: a JSON array stored as a file
    server.on("/api/profiles", HTTP_GET, [this](AsyncWebServerRequest *request)
              { history->sendProfiles(request); });

    server.on(
        "/api/profiles", HTTP_POST,
        [](AsyncWebServerRequest *request) {},
        nullptr,
        [this](AsyncWebServerRequest *request, uint8_t *data, size_t len, size_t index, size_t total)
        {
            // collect the body (it can arrive in several chunks)
            static String body;
            if (index == 0)
                body = "";
            body.concat((const char *)data, len);
            if (index + len < total)
                return;
            bool ok = history->saveProfiles((const uint8_t *)body.c_str(), body.length());
            body = "";
            request->send(ok ? 200 : 400, "application/json",
                          ok ? "{\"status\":\"OK\"}" : "{\"status\":\"invalid\"}");
        });

    // WiFi scan for the home WiFi picker. ?start=1 starts a new scan.
    server.on("/api/wifi/scan", HTTP_GET, [](AsyncWebServerRequest *request)
              {
        if (request->hasParam("start"))
        {
            WiFi.scanDelete();
            WiFi.scanNetworks(true);
            request->send(200, "application/json", "{\"scanning\":true}");
            return;
        }
        int16_t n = WiFi.scanComplete();
        if (n == WIFI_SCAN_RUNNING)
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
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        serializeJson(doc, *response);
        request->send(response); });

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
        AsyncResponseStream *response = request->beginResponseStream("application/json");
        serializeJson(doc, *response);
        request->send(response); });
}
