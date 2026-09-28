#include "history.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

#include "debug.h"

String RaceHistory::racePath(uint32_t id)
{
    return String(RACES_DIR) + "/r" + id + ".json";
}

// File names are "r<id>.json"
bool RaceHistory::parseId(const char *name, uint32_t &id)
{
    const char *slash = strrchr(name, '/');
    if (slash)
        name = slash + 1;
    if (name[0] != 'r')
        return false;
    char *end = nullptr;
    unsigned long value = strtoul(name + 1, &end, 10);
    if (end == name + 1 || strcmp(end, ".json") != 0)
        return false;
    id = value;
    return true;
}

void RaceHistory::init()
{
    if (!LittleFS.exists(RACES_DIR))
    {
        LittleFS.mkdir(RACES_DIR);
    }
    File dir = LittleFS.open(RACES_DIR);
    uint32_t maxId = 0;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
        uint32_t id;
        if (parseId(f.name(), id) && id > maxId)
            maxId = id;
    }
    nextId = maxId + 1;
    ready = true;
    DEBUG("Race history ready, next id %u\n", nextId);
}

void RaceHistory::save(LapTimer &timer, Config &config)
{
    if (!ready)
    {
        timer.savePending = false;
        return;
    }
    JsonDocument doc;
    uint32_t id = nextId++;
    doc["id"] = id;
    doc["date"] = timer.getStartEpoch();
    doc["mode"] = timer.getMode();
    doc["raceMs"] = timer.getRaceMs();
    doc["raceLaps"] = timer.getRaceLaps();
    doc["countdown"] = timer.getCountdown();
    JsonArray pilots = doc["pilots"].to<JsonArray>();
    for (uint8_t i = 0; i < timer.getPilotCount(); i++)
    {
        JsonObject p = pilots.add<JsonObject>();
        p["name"] = config.getPilotName(i);
        p["freq"] = timer.getRaceFrequency(i);
        p["fin"] = timer.isFinished(i);
        JsonArray laps = p["laps"].to<JsonArray>();
        int count = timer.getLapCount(i);
        for (int l = 0; l < count; l++)
            laps.add(timer.getLap(i, l));
    }

    File f = LittleFS.open(racePath(id), "w");
    if (f)
    {
        serializeJson(doc, f);
        f.close();
        DEBUG("Race %u saved\n", id);
    }
    else
    {
        DEBUG("Race %u could not be saved\n", id);
    }
    timer.savePending = false;
    prune();
}

// Keeps the newest MAX_SAVED_RACES races
void RaceHistory::prune()
{
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = 0;
    File dir = LittleFS.open(RACES_DIR);
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
        uint32_t id;
        if (parseId(f.name(), id) && count < sizeof(ids) / sizeof(ids[0]))
            ids[count++] = id;
    }
    while (count > MAX_SAVED_RACES)
    {
        size_t oldest = 0;
        for (size_t i = 1; i < count; i++)
        {
            if (ids[i] < ids[oldest])
                oldest = i;
        }
        LittleFS.remove(racePath(ids[oldest]));
        ids[oldest] = ids[--count];
    }
}

void RaceHistory::sendList(AsyncWebServerRequest *request)
{
    JsonDocument out;
    JsonArray list = out.to<JsonArray>();
    File dir = LittleFS.open(RACES_DIR);
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
        uint32_t id;
        if (!parseId(f.name(), id))
            continue;
        JsonDocument race;
        if (deserializeJson(race, f))
            continue;
        JsonObject item = list.add<JsonObject>();
        item["id"] = id;
        item["date"] = race["date"];
        item["mode"] = race["mode"];
        JsonArray pilots = item["pilots"].to<JsonArray>();
        for (JsonObject p : race["pilots"].as<JsonArray>())
        {
            JsonArray laps = p["laps"].as<JsonArray>();
            uint32_t best = 0;
            int n = 0;
            for (JsonVariant lap : laps)
            {
                if (n++ == 0)
                    continue; // start pass is not a lap
                uint32_t t = lap.as<uint32_t>();
                if (best == 0 || t < best)
                    best = t;
            }
            JsonObject s = pilots.add<JsonObject>();
            s["name"] = p["name"];
            s["laps"] = n > 0 ? n - 1 : 0;
            s["best"] = best;
        }
    }
    AsyncResponseStream *response = request->beginResponseStream("application/json");
    serializeJson(out, *response);
    request->send(response);
}

void RaceHistory::sendRace(AsyncWebServerRequest *request, uint32_t id)
{
    String path = racePath(id);
    if (!LittleFS.exists(path))
    {
        request->send(404, "application/json", "{\"error\":\"not found\"}");
        return;
    }
    request->send(LittleFS, path, "application/json");
}

void RaceHistory::clear()
{
    File dir = LittleFS.open(RACES_DIR);
    String paths[MAX_SAVED_RACES + 8];
    size_t count = 0;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
        uint32_t id;
        if (parseId(f.name(), id) && count < sizeof(paths) / sizeof(paths[0]))
            paths[count++] = racePath(id);
    }
    dir.close();
    for (size_t i = 0; i < count; i++)
        LittleFS.remove(paths[i]);
}

void RaceHistory::sendProfiles(AsyncWebServerRequest *request)
{
    if (!LittleFS.exists(PROFILES_FILE))
    {
        request->send(200, "application/json", "[]");
        return;
    }
    request->send(LittleFS, PROFILES_FILE, "application/json");
}

bool RaceHistory::saveProfiles(const uint8_t *data, size_t len)
{
    if (len > MAX_PROFILES_SIZE)
        return false;
    JsonDocument doc;
    if (deserializeJson(doc, data, len) || !doc.is<JsonArray>())
        return false;
    File f = LittleFS.open(PROFILES_FILE, "w");
    if (!f)
        return false;
    serializeJson(doc, f);
    f.close();
    return true;
}
