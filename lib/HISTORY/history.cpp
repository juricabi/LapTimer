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

// Summary shown in the history list: {id, date, mode, pilots: [{name, laps, best}]}
static void addSummary(JsonArray list, JsonObjectConst race)
{
    JsonObject item = list.add<JsonObject>();
    item["id"] = race["id"];
    item["date"] = race["date"];
    item["mode"] = race["mode"];
    JsonArray pilots = item["pilots"].to<JsonArray>();
    for (JsonObjectConst p : race["pilots"].as<JsonArrayConst>())
    {
        uint32_t best = 0;
        int n = 0;
        for (JsonVariantConst lap : p["laps"].as<JsonArrayConst>())
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

size_t RaceHistory::listIds(uint32_t *ids, size_t max)
{
    size_t count = 0;
    File dir = LittleFS.open(RACES_DIR);
    for (File f = dir.openNextFile(); f; f = dir.openNextFile())
    {
        uint32_t id;
        if (parseId(f.name(), id) && count < max)
            ids[count++] = id;
    }
    return count;
}

// Rebuilds the summary index from the race files (only needed if it is missing)
void RaceHistory::rebuildIndex()
{
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    JsonDocument index;
    JsonArray list = index.to<JsonArray>();
    for (size_t i = 0; i < count; i++)
    {
        File f = LittleFS.open(racePath(ids[i]), "r");
        JsonDocument race;
        if (f && !deserializeJson(race, f))
        {
            race["id"] = ids[i];
            addSummary(list, race.as<JsonObjectConst>());
        }
    }
    writeIndex(index);
}

void RaceHistory::writeIndex(JsonDocument &index)
{
    File f = LittleFS.open(INDEX_FILE, "w");
    if (f)
    {
        serializeJson(index, f);
        f.close();
    }
}

void RaceHistory::init()
{
    if (!LittleFS.exists(RACES_DIR))
    {
        LittleFS.mkdir(RACES_DIR);
    }
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    uint32_t maxId = 0;
    for (size_t i = 0; i < count; i++)
    {
        if (ids[i] > maxId)
            maxId = ids[i];
    }
    nextId = maxId + 1;
    if (!LittleFS.exists(INDEX_FILE))
    {
        rebuildIndex();
    }
    ready = true;
    DEBUG("Race history ready, next id %u\n", nextId);
}

// Deletes the oldest race (file and index entry)
bool RaceHistory::deleteOldest(JsonDocument &index)
{
    JsonArray list = index.as<JsonArray>();
    if (list.size() == 0)
        return false;
    size_t oldest = 0;
    for (size_t i = 1; i < list.size(); i++)
    {
        if (list[i]["id"].as<uint32_t>() < list[oldest]["id"].as<uint32_t>())
            oldest = i;
    }
    LittleFS.remove(racePath(list[oldest]["id"].as<uint32_t>()));
    list.remove(oldest);
    return true;
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
    doc["stagger"] = timer.getStaggered();
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
    uint32_t raceId = timer.getRaceId();
    timer.savePending = false; // race data copied; the timer may start a new race

    // Load the index, make room (count and free space), then write race + index
    JsonDocument index;
    File in = LittleFS.open(INDEX_FILE, "r");
    if (!in || deserializeJson(index, in) || !index.is<JsonArray>())
    {
        index.to<JsonArray>();
    }
    if (in)
        in.close();
    while (index.as<JsonArray>().size() >= MAX_SAVED_RACES && deleteOldest(index))
    {
    }
    while (LittleFS.totalBytes() - LittleFS.usedBytes() < MIN_FREE_BYTES && deleteOldest(index))
    {
    }

    File f = LittleFS.open(racePath(id), "w");
    bool ok = f && serializeJson(doc, f) > 0;
    if (f)
        f.close();
    if (ok)
    {
        addSummary(index.as<JsonArray>(), doc.as<JsonObjectConst>());
        lastSaveOk = true;
        lastSavedId = id;
        lastSavedRaceId = raceId;
        DEBUG("Race %u saved\n", id);
    }
    else
    {
        LittleFS.remove(racePath(id));
        lastSaveOk = false;
        DEBUG("Race %u could not be saved\n", id);
    }
    writeIndex(index);
}

bool RaceHistory::editRace(uint32_t id, uint8_t pilot, uint8_t op, int lapIndex)
{
    String path = racePath(id);
    JsonDocument race;
    File in = LittleFS.open(path, "r");
    if (!in || deserializeJson(race, in))
        return false;
    in.close();

    JsonArray pilots = race["pilots"].as<JsonArray>();
    if (pilot >= pilots.size())
        return false;
    JsonArray lapsJson = pilots[pilot]["laps"].as<JsonArray>();
    uint32_t laps[MAX_LAPS];
    int count = 0;
    for (JsonVariant v : lapsJson)
    {
        if (count < MAX_LAPS)
            laps[count++] = v.as<uint32_t>();
    }
    if (!applyLapEdit(laps, count, MAX_LAPS, op, lapIndex))
        return false;
    lapsJson.clear();
    for (int i = 0; i < count; i++)
        lapsJson.add(laps[i]);

    File out = LittleFS.open(path, "w");
    if (!out)
        return false;
    serializeJson(race, out);
    out.close();

    // refresh this race's entry in the history list
    JsonDocument index;
    File idx = LittleFS.open(INDEX_FILE, "r");
    if (!idx || deserializeJson(index, idx) || !index.is<JsonArray>())
        index.to<JsonArray>();
    if (idx)
        idx.close();
    JsonArray list = index.as<JsonArray>();
    for (size_t i = 0; i < list.size(); i++)
    {
        if (list[i]["id"].as<uint32_t>() == id)
        {
            list.remove(i);
            break;
        }
    }
    addSummary(list, race.as<JsonObjectConst>());
    writeIndex(index);
    return true;
}

void RaceHistory::sendList(AsyncWebServerRequest *request)
{
    if (!LittleFS.exists(INDEX_FILE))
    {
        request->send(200, "application/json", "[]");
        return;
    }
    request->send(LittleFS, INDEX_FILE, "application/json");
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
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    for (size_t i = 0; i < count; i++)
        LittleFS.remove(racePath(ids[i]));
    LittleFS.remove(INDEX_FILE);
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
