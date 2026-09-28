#include "history.h"

#include <ArduinoJson.h>
#include <LittleFS.h>

#include "debug.h"

// History is changed from two tasks (saving a race in the background task, editing
// and clearing from the web server), so every change holds this lock.
class HistoryLock {
   public:
    explicit HistoryLock(SemaphoreHandle_t m) : mutex(m) { xSemaphoreTake(mutex, portMAX_DELAY); }
    ~HistoryLock() { xSemaphoreGive(mutex); }

   private:
    SemaphoreHandle_t mutex;
};

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

// Writes via a temporary file and a rename, so a reader never sees a half-written file
bool RaceHistory::writeJson(const String &path, JsonDocument &doc)
{
    String tmp = path + ".tmp";
    File f = LittleFS.open(tmp, "w");
    if (!f)
        return false;
    bool ok = serializeJson(doc, f) > 0;
    f.close();
    if (!ok)
    {
        LittleFS.remove(tmp);
        return false;
    }
    LittleFS.remove(path);
    return LittleFS.rename(tmp, path);
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

// Loads the summary index; an unreadable index starts empty
void RaceHistory::loadIndex(JsonDocument &index)
{
    File in = LittleFS.open(INDEX_FILE, "r");
    if (!in || deserializeJson(index, in) || !index.is<JsonArray>())
    {
        index.to<JsonArray>();
    }
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
    writeJson(INDEX_FILE, index);
}

void RaceHistory::init()
{
    if (!mutex)
    {
        mutex = xSemaphoreCreateMutex();
    }
    HistoryLock lock(mutex);
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

void RaceHistory::save(LapTimer &timer)
{
    if (!ready)
    {
        timer.savePending = false;
        return;
    }
    HistoryLock lock(mutex);
    JsonDocument doc;
    timer.raceToJson(doc.to<JsonObject>());
    uint32_t id = nextId++;
    uint32_t raceId = doc["race"];
    doc.remove("race");
    doc.remove("state");
    doc.remove("edits");
    doc["id"] = id;
    timer.savePending = false; // race data copied; the timer may start a new race

    // make room (count and free space), then write race + index
    JsonDocument index;
    loadIndex(index);
    while (index.as<JsonArray>().size() >= MAX_SAVED_RACES && deleteOldest(index))
    {
    }
    while (LittleFS.totalBytes() - LittleFS.usedBytes() < MIN_FREE_BYTES && deleteOldest(index))
    {
    }

    if (writeJson(racePath(id), doc))
    {
        addSummary(index.as<JsonArray>(), doc.as<JsonObjectConst>());
        lastSaveOk = true;
        lastSavedId = id;
        lastSavedRaceId = raceId;
        DEBUG("Race %u saved\n", id);
    }
    else
    {
        lastSaveOk = false;
        DEBUG("Race %u could not be saved\n", id);
    }
    writeJson(INDEX_FILE, index);
}

bool RaceHistory::editRace(uint32_t id, uint8_t pilot, uint8_t op, int lapIndex)
{
    HistoryLock lock(mutex);
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
    if (!writeJson(path, race))
        return false;

    // refresh this race's entry in the history list
    JsonDocument index;
    loadIndex(index);
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
    writeJson(INDEX_FILE, index);
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
    HistoryLock lock(mutex);
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    for (size_t i = 0; i < count; i++)
        LittleFS.remove(racePath(ids[i]));
    LittleFS.remove(INDEX_FILE);
    lastSavedId = 0; // the race on the Race tab is no longer saved
    lastSavedRaceId = 0;
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
    return writeJson(PROFILES_FILE, doc);
}
