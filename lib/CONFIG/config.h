#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <stdint.h>
#pragma once
/*
## Pinout ##
| ESP32 | RX5880 |
| :------------- |:-------------|
| 33 | RSSI |
| GND | GND |
| 19 | CH1 |
| 22 | CH2 |
| 23 | CH3 |
| 3V3 | +5V |

* **Led** goes to pin 21 and GND
* The optional **Buzzer** goes to pin 25 or 27 and GND

*/

// ESP23-C3
#if defined(ESP32C3)

#define PIN_LED 1
#define PIN_VBAT 0
#define VBAT_SCALE 2
#define VBAT_ADD 2
#define PIN_RX5808_RSSI 3
#define PIN_RX5808_DATA 6   // CH1
#define PIN_RX5808_SELECT 7 // CH2
#define PIN_RX5808_CLOCK 4  // CH3
#define PIN_BUZZER 5
#define BUZZER_INVERTED false

// ESP32-S3
#elif defined(ESP32S3)

#define PIN_LED 2
#define PIN_VBAT 1
#define VBAT_SCALE 2
#define VBAT_ADD 2
#define PIN_RX5808_RSSI 13
#define PIN_RX5808_DATA 11   // CH1
#define PIN_RX5808_SELECT 10 // CH2
#define PIN_RX5808_CLOCK 12  // CH3
#define PIN_BUZZER 3
#define BUZZER_INVERTED false

// ESP32
#else

#define PIN_LED 21
#define PIN_VBAT 35
#define VBAT_SCALE 2
#define VBAT_ADD 2
#define PIN_RX5808_RSSI 33
#define PIN_RX5808_DATA 19   // CH1
#define PIN_RX5808_SELECT 22 // CH2
#define PIN_RX5808_CLOCK 23  // CH3
#define PIN_BUZZER 27
#define BUZZER_INVERTED false

#endif

#define EEPROM_RESERVED_SIZE 256
#define CONFIG_MAGIC_MASK (0b11U << 30)
#define CONFIG_MAGIC (0b01U << 30)
#define CONFIG_VERSION 2U  // v1: pilots 2-4 and race settings, v2: ranking and staggered start (older versions are migrated)

#define EEPROM_CHECK_TIME_MS 1000

#define MAX_PILOTS 4

typedef enum {
    RACE_PRACTICE = 0,  // unlimited laps until stopped
    RACE_TIMED = 1,     // race for raceSeconds, then each pilot finishes on the next pass
    RACE_LAPS = 2       // each pilot finishes after raceLaps laps
} race_mode_e;

// Pilots 2-4 (pilot 1 uses the v0 fields)
typedef enum {
    RANK_MOST_LAPS = 0,     // most laps, then the lowest total time (first to finish wins)
    RANK_FASTEST_LAP = 1,   // fastest single lap
    RANK_FASTEST_3 = 2      // fastest 3 consecutive laps
} rank_by_e;

typedef struct
{
    uint16_t frequency;
    uint8_t enterRssi;
    uint8_t exitRssi;
    char name[21];
} extra_pilot_t;

typedef struct
{
    // --- v0 (layout must not change) ---
    uint32_t version;
    uint16_t frequency;
    uint8_t minLap;
    uint8_t alarm;
    uint8_t announcerType;
    uint8_t announcerRate;
    uint8_t enterRssi;
    uint8_t exitRssi;
    char pilotName[21];
    char ssid[33];
    char password[33];
    bool buzzerOn;
    // --- v1 ---
    uint8_t pilotCount;     // 1-4 pilots on the one RX5808
    extra_pilot_t extraPilots[MAX_PILOTS - 1];
    uint8_t raceMode;       // race_mode_e
    uint16_t raceSeconds;
    uint8_t raceLaps;
    bool countdown;         // 3-2-1-go start instead of starting on the first pass
    bool announceDelta;     // announce the difference to the best lap
    // --- v2 ---
    uint8_t rankBy;         // rank_by_e
    bool staggered;         // each pilot's race time starts at their own first gate pass
} laptimer_config_t;

static_assert(sizeof(laptimer_config_t) <= EEPROM_RESERVED_SIZE, "config does not fit the reserved EEPROM size");

class Config
{
public:
    void init();
    void load();
    void write();
    void toJson(AsyncResponseStream &destination);
    void toJsonString(char *buf, size_t size);
    void fromJson(JsonObject source);
    void handleEeprom(uint32_t currentTimeMs);

    // getters; pilot index 0 .. MAX_PILOTS - 1
    uint8_t getPilotCount();
    uint16_t getFrequency(uint8_t pilot = 0);
    uint8_t getEnterRssi(uint8_t pilot = 0);
    uint8_t getExitRssi(uint8_t pilot = 0);
    const char *getPilotName(uint8_t pilot = 0);
    uint32_t getMinLapMs();
    uint8_t getAlarmThreshold();
    char *getSsid();
    char *getPassword();
    void clearWifi();
    bool getBuzzerOn();
    race_mode_e getRaceMode();
    uint32_t getRaceMs();
    uint8_t getRaceLaps();
    bool getCountdown();
    rank_by_e getRankBy();
    bool getStaggered();
    uint32_t getRevision() { return revision; }  // changes on every settings change, so pages can reload

private:
    laptimer_config_t conf;
    volatile bool modified;
    volatile uint32_t revision = 1;
    volatile uint32_t checkTimeMs = 0;
    void setDefaults();
    void setV1Defaults();
    void setV2Defaults();
    void toJsonDoc(JsonDocument &doc);
};
