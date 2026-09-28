#pragma once

#include <stdint.h>

#include "config.h"

#define MAX_WIFI_NETWORKS 5

struct WifiNetwork {
    char ssid[33];
    char pass[65];
};

// Saved WiFi networks, newest first, kept in NVS (survives firmware and web page updates).
// On power-up the timer joins the strongest saved network in range.
class WifiList {
   public:
    // Loads the list; the network from the old single-network settings is moved into it
    void init(Config *config);

    uint8_t count() { return n; }
    const char *ssid(uint8_t i) { return nets[i].ssid; }
    const char *password(uint8_t i) { return nets[i].pass; }

    bool add(const char *ssid, const char *pass);  // adds or updates, moves to the top
    bool remove(const char *ssid);
    void clear();

    // After a WiFi scan with `found` results: index of the strongest saved network in range, or -1
    int pickBest(int16_t found);

   private:
    WifiNetwork nets[MAX_WIFI_NETWORKS];
    volatile uint8_t n = 0;
    void save();
};
