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

// Race history and pilot profiles, stored as JSON files on LittleFS
class RaceHistory {
   public:
    void init();  // call after LittleFS is mounted

    // Saves the timer's current race
    void save(LapTimer &timer);
    bool lastSaveOk = true;
    uint32_t lastSavedId = 0;      // history id of the newest saved race
    uint32_t lastSavedRaceId = 0;  // the timer's race id it came from

    // Corrects laps of a saved race (see LAP_EDIT_*); updates the history list too
    bool editRace(uint32_t id, uint8_t pilot, uint8_t op, int lapIndex);

    void sendList(AsyncWebServerRequest *request);  // newest-first sorting is done by the page
    void sendRace(AsyncWebServerRequest *request, uint32_t id);
    void clear();

    void sendProfiles(AsyncWebServerRequest *request);
    bool saveProfiles(const uint8_t *data, size_t len);

   private:
    uint32_t nextId = 1;
    bool ready = false;
    SemaphoreHandle_t mutex = nullptr;
    size_t listIds(uint32_t *ids, size_t max);
    void loadIndex(JsonDocument &index);
    void rebuildIndex();
    static bool writeJson(const String &path, JsonDocument &doc);
    bool deleteOldest(JsonDocument &index);
    static String racePath(uint32_t id);
    static bool parseId(const char *name, uint32_t &id);
};
