#pragma once

#include <ArduinoJson.h>
#include <ESPAsyncWebServer.h>

#include "config.h"
#include "laptimer.h"

#define RACES_DIR "/races"
#define INDEX_FILE "/races/index.json"   // summaries for the history list
#define MAX_SAVED_RACES 30
#define MIN_FREE_BYTES (64 * 1024)       // delete old races rather than fill the flash
#define PROFILES_FILE "/profiles.json"
#define MAX_PROFILES_SIZE 4096
#define RACE_NAME_MAX_BYTES 32           // a race's own name (UTF-8, cut at a whole character)

enum { EDIT_OK, EDIT_INVALID, EDIT_STALE };

// Race history and pilot profiles, stored as JSON files on LittleFS
class RaceHistory {
   public:
    void init();  // call after LittleFS is mounted

    // Saves the timer's current race with the pace target in use (0 = none)
    void save(LapTimer &timer, uint32_t targetLapMs);
    bool lastSaveOk = true;
    uint32_t lastSavedId = 0;      // history id of the newest saved race
    uint32_t lastSavedRaceId = 0;  // the timer's race id it came from

    // Corrects laps of a saved race (see LAP_EDIT_*); updates the history list too.
    // expect >= 0: the lap's current value as the page shows it (EDIT_STALE if it differs).
    int editRace(uint32_t id, uint8_t pilot, uint8_t op, int lapIndex, int64_t expect);

    // Names a saved race (an empty name removes it: the page shows the date). EDIT_OK or EDIT_INVALID.
    int renameRace(uint32_t id, const char *name);

    // Files are sent from memory, so no file stays open while a phone downloads it
    // (an open file can't be replaced, which made saves fail)
    void sendList(AsyncWebServerRequest *request);  // newest-first sorting is done by the page
    void sendRace(AsyncWebServerRequest *request, uint32_t id);
    void clear();

    // Saved pilots, changed one at a time so two phones can't overwrite each other's list
    void sendProfiles(AsyncWebServerRequest *request);
    int saveProfile(const char *name, const char *prevName, uint16_t freq, uint8_t enter, uint8_t exit,
                    uint32_t targetLapMs);  // 200, 400, 507
    bool removeProfile(const char *name);
    volatile uint32_t profilesRevision = 1;  // changes with every saved-pilot change

   private:
    uint32_t nextId = 1;
    bool ready = false;
    bool indexDirty = false;  // index.json is out of date: rebuild it from the race files
    SemaphoreHandle_t mutex = nullptr;
    size_t listIds(uint32_t *ids, size_t max);
    void loadIndex(JsonDocument &index);
    void buildIndex(JsonDocument &index);
    void writeIndex(JsonDocument &index);
    void updateSummary(uint32_t id, JsonObjectConst race);
    void recoverTempFiles(const char *dir);
    bool readFile(const String &path, String &out);
    void loadProfiles(JsonDocument &doc);
    static bool writeJson(const String &path, JsonDocument &doc);
    bool deleteOldest(JsonDocument &index);
    static String racePath(uint32_t id);
    static bool parseId(const char *name, uint32_t &id);
};
