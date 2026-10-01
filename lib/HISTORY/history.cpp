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

// Writes via a temporary file and a rename, so a reader never sees a half-written file.
// The rename replaces the old file in one step (LittleFS); a reset leaves the old or the new.
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
    if (LittleFS.rename(tmp, path))
        return true;
    LittleFS.remove(path); // in case this LittleFS build refuses to replace
    // if this fails too, the temp file is the only copy: recoverTempFiles() restores it
    return LittleFS.rename(tmp, path);
}

// Reads a whole (small) file, so it is closed again before it is sent
bool RaceHistory::readFile(const String &path, String &out)
{
    File f = LittleFS.open(path, "r");
    if (!f)
        return false;
    out.reserve(f.size() + 1);
    out = f.readString();
    f.close();
    return true;
}

// A reset between writing "x.tmp" and the rename leaves the temp file: keep it only if
// the file it was meant to replace is missing and it is complete (valid JSON)
void RaceHistory::recoverTempFiles(const char *dir)
{
    String names[8];
    size_t count = 0;
    File d = LittleFS.open(dir);
    for (File f = d.openNextFile(); f && count < 8; f = d.openNextFile())
    {
        String name = f.path();
        if (name.endsWith(".tmp"))
            names[count++] = name;
    }
    d.close();
    for (size_t i = 0; i < count; i++)
    {
        String target = names[i].substring(0, names[i].length() - 4);
        bool complete = false;
        if (!LittleFS.exists(target))
        {
            File f = LittleFS.open(names[i], "r");
            JsonDocument doc;
            complete = f && !deserializeJson(doc, f);
            f.close();
        }
        if (complete)
            LittleFS.rename(names[i], target);
        else
            LittleFS.remove(names[i]);
    }
}

// Summary shown in the history list: {id, date, mode, name?, pilots: [{name, laps, best}]}
static void addSummary(JsonArray list, JsonObjectConst race)
{
    JsonObject item = list.add<JsonObject>();
    item["id"] = race["id"];
    item["date"] = race["date"];
    item["mode"] = race["mode"];
    if (!race["name"].isNull())
        item["name"] = race["name"]; // the race's own name (pilots have theirs below)
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

// Loads the summary index. A missing, unreadable or out-of-date index is rebuilt from
// the race files. Call with the lock held.
void RaceHistory::loadIndex(JsonDocument &index)
{
    if (!indexDirty)
    {
        File in = LittleFS.open(INDEX_FILE, "r");
        bool ok = in && !deserializeJson(index, in) && index.is<JsonArray>();
        in.close();
        if (ok)
            return;
    }
    buildIndex(index);
    writeIndex(index);
}

void RaceHistory::buildIndex(JsonDocument &index)
{
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    JsonArray list = index.to<JsonArray>();
    for (size_t i = 0; i < count; i++)
    {
        File f = LittleFS.open(racePath(ids[i]), "r");
        JsonDocument race;
        bool ok = f && !deserializeJson(race, f);
        f.close();
        if (ok)
        {
            race["id"] = ids[i];
            addSummary(list, race.as<JsonObjectConst>());
        }
    }
}

// A failed write (e.g. flash full) marks the index for a rebuild on the next read
void RaceHistory::writeIndex(JsonDocument &index)
{
    indexDirty = !writeJson(INDEX_FILE, index);
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
    recoverTempFiles(RACES_DIR); // first, so a recovered race counts for the next id
    recoverTempFiles("/");
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    uint32_t maxId = 0;
    for (size_t i = 0; i < count; i++)
    {
        if (ids[i] > maxId)
            maxId = ids[i];
    }
    nextId = maxId + 1;
    // rebuild the index on every start: cheap, and repairs anything a reset left behind
    indexDirty = true;
    JsonDocument index;
    loadIndex(index);
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
    if (!LittleFS.remove(racePath(list[oldest]["id"].as<uint32_t>())))
        indexDirty = true; // the file is still there: rebuild the index from the files later
    list.remove(oldest);
    return true;
}

void RaceHistory::save(LapTimer &timer, uint32_t targetLapMs)
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
    if (targetLapMs)
        doc["target"] = targetLapMs; // the pace target this race was flown against

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
    writeIndex(index);
    // only now: a new race would run while these flash writes stall the timing core
    timer.savePending = false;
}

int RaceHistory::editRace(uint32_t id, uint8_t pilot, uint8_t op, int lapIndex, int64_t expect)
{
    HistoryLock lock(mutex);
    String path = racePath(id);
    JsonDocument race;
    File in = LittleFS.open(path, "r");
    bool readOk = in && !deserializeJson(race, in);
    in.close();
    if (!readOk)
        return EDIT_INVALID;

    JsonArray pilots = race["pilots"].as<JsonArray>();
    if (pilot >= pilots.size())
        return EDIT_INVALID;
    JsonArray lapsJson = pilots[pilot]["laps"].as<JsonArray>();
    uint32_t laps[MAX_LAPS];
    int count = 0;
    for (JsonVariant v : lapsJson)
    {
        if (count < MAX_LAPS)
            laps[count++] = v.as<uint32_t>();
    }
    // the page's copy must still match (a double tap or another phone may have edited it)
    if (expect >= 0 && (lapIndex < 0 || lapIndex >= count || laps[lapIndex] != (uint32_t)expect))
        return EDIT_STALE;
    if (!applyLapEdit(laps, count, MAX_LAPS, op, lapIndex))
        return EDIT_INVALID;
    lapsJson.clear();
    for (int i = 0; i < count; i++)
        lapsJson.add(laps[i]);
    if (count < MAX_LAPS)
        pilots[pilot].remove("full");
    if (!writeJson(path, race))
        return EDIT_INVALID;
    updateSummary(id, race.as<JsonObjectConst>());
    return EDIT_OK;
}

int RaceHistory::renameRace(uint32_t id, const char *name)
{
    char clean[RACE_NAME_MAX_BYTES + 1];
    copyUtf8(clean, name ? name : "", sizeof(clean));
    HistoryLock lock(mutex);
    String path = racePath(id);
    JsonDocument race;
    File in = LittleFS.open(path, "r");
    bool readOk = in && !deserializeJson(race, in);
    in.close();
    if (!readOk)
        return EDIT_INVALID;
    if (clean[0])
        race["name"] = clean;
    else
        race.remove("name"); // back to the date
    if (!writeJson(path, race))
        return EDIT_INVALID;
    updateSummary(id, race.as<JsonObjectConst>());
    return EDIT_OK;
}

// Replaces one race's entry in the history list. Call with the lock held.
void RaceHistory::updateSummary(uint32_t id, JsonObjectConst race)
{
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
    addSummary(list, race);
    writeIndex(index);
}

void RaceHistory::sendList(AsyncWebServerRequest *request)
{
    String body;
    {
        HistoryLock lock(mutex);
        JsonDocument index;
        loadIndex(index);
        serializeJson(index, body);
    }
    request->send(200, "application/json", body);
}

void RaceHistory::sendRace(AsyncWebServerRequest *request, uint32_t id)
{
    String body;
    bool found;
    {
        HistoryLock lock(mutex);
        found = readFile(racePath(id), body);
    }
    if (!found)
    {
        request->send(404, "application/json", "{\"error\":\"not found\"}");
        return;
    }
    request->send(200, "application/json", body);
}

void RaceHistory::clear()
{
    HistoryLock lock(mutex);
    uint32_t ids[MAX_SAVED_RACES + 8];
    size_t count = listIds(ids, sizeof(ids) / sizeof(ids[0]));
    for (size_t i = 0; i < count; i++)
        LittleFS.remove(racePath(ids[i]));
    LittleFS.remove(INDEX_FILE);
    indexDirty = true; // rebuilt (from whatever could not be deleted) on the next read
    lastSavedId = 0; // the race on the Race tab is no longer saved
    lastSavedRaceId = 0;
}

void RaceHistory::sendProfiles(AsyncWebServerRequest *request)
{
    String body;
    {
        HistoryLock lock(mutex);
        JsonDocument doc;
        loadProfiles(doc);
        serializeJson(doc, body);
    }
    request->send(200, "application/json", body);
}

// An unreadable file starts an empty list. Call with the lock held.
void RaceHistory::loadProfiles(JsonDocument &doc)
{
    File in = LittleFS.open(PROFILES_FILE, "r");
    bool ok = in && !deserializeJson(doc, in) && doc.is<JsonArray>();
    in.close();
    if (!ok)
        doc.to<JsonArray>();
}

// Adds or updates one saved pilot (names match without case). prevName: the pilot's old
// name after a rename, that entry is replaced. A pace target is stored only when set
// (pilots saved before it existed have none: off).
int RaceHistory::saveProfile(const char *name, const char *prevName, uint16_t freq, uint8_t enter, uint8_t exit,
                             uint32_t targetLapMs)
{
    char clean[21];
    copyUtf8(clean, name ? name : "", sizeof(clean));
    if (clean[0] == 0)
        return 400;
    if (enter < 1)
        enter = 1;
    if (exit >= enter)
        exit = enter - 1;
    HistoryLock lock(mutex);
    JsonDocument doc;
    loadProfiles(doc);
    JsonArray list = doc.as<JsonArray>();
    for (size_t i = list.size(); i-- > 0;)
    {
        const char *n = list[i]["name"] | "";
        if (strcasecmp(n, clean) == 0 || (prevName && prevName[0] && strcasecmp(n, prevName) == 0))
            list.remove(i);
    }
    JsonObject p = list.add<JsonObject>();
    p["name"] = clean;
    p["freq"] = freq;
    p["enter"] = enter;
    p["exit"] = exit;
    targetLapMs = clampTargetLapMs(targetLapMs);
    if (targetLapMs)
        p["target"] = targetLapMs;
    if (measureJson(doc) > MAX_PROFILES_SIZE)
        return 507;
    if (!writeJson(PROFILES_FILE, doc))
        return 507;
    profilesRevision++;
    return 200;
}

bool RaceHistory::removeProfile(const char *name)
{
    if (!name || !name[0])
        return false;
    HistoryLock lock(mutex);
    JsonDocument doc;
    loadProfiles(doc);
    JsonArray list = doc.as<JsonArray>();
    bool found = false;
    for (size_t i = list.size(); i-- > 0;)
    {
        if (strcasecmp(list[i]["name"] | "", name) == 0)
        {
            list.remove(i);
            found = true;
        }
    }
    if (!found)
        return true; // already gone (another phone removed it)
    if (!writeJson(PROFILES_FILE, doc))
        return false;
    profilesRevision++;
    return true;
}
