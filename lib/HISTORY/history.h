#pragma once

#include <ESPAsyncWebServer.h>

#include "config.h"
#include "laptimer.h"

#define RACES_DIR "/races"
#define MAX_SAVED_RACES 30
#define PROFILES_FILE "/profiles.json"
#define MAX_PROFILES_SIZE 4096

// Race history and pilot profiles, stored as JSON files on LittleFS
class RaceHistory {
   public:
    void init();  // call after LittleFS is mounted

    // Saves the timer's current race (call from one task only)
    void save(LapTimer &timer, Config &config);

    // [{id, date, mode, pilots: [{name, laps, best}]}], newest first
    void sendList(AsyncWebServerRequest *request);
    void sendRace(AsyncWebServerRequest *request, uint32_t id);
    void clear();

    void sendProfiles(AsyncWebServerRequest *request);
    bool saveProfiles(const uint8_t *data, size_t len);

   private:
    uint32_t nextId = 1;
    bool ready = false;
    void prune();
    static String racePath(uint32_t id);
    static bool parseId(const char *name, uint32_t &id);
};
