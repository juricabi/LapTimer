#include <ArduinoJson.h>
#include <AsyncJson.h>
#include <stdint.h>
#pragma once
/*
## Pinout ##
| ESP32 | RX5808 |
| :------------- |:-------------|
| 33 | RSSI |
| GND | GND |
| 19 | CH1 |
| 22 | CH2 |
| 23 | CH3 |
| 3V3 | VCC |

* **Led** goes to pin 21 and GND
* The optional **Buzzer** goes to pin 27 and GND

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
// v0: v1.0.0. v3: race settings. v4: pace target. (v1 and v2 were multi-pilot development
// builds with another layout after the v0 fields.) Older versions keep the fields they had and
// get defaults for the newer ones (Config::load migrates one version at a time).
#define CONFIG_VERSION 4U

// Pace target: 0 = off, otherwise a lap time in this range
#define TARGET_LAP_MIN_MS 3000U
#define TARGET_LAP_MAX_MS 600000U

#define EEPROM_CHECK_TIME_MS 1000

typedef enum {
    RACE_PRACTICE = 0,  // unlimited laps until stopped
    RACE_TIMED = 1,     // race for raceSeconds, then the pilot finishes on the next pass
    RACE_LAPS = 2       // the pilot finishes after raceLaps laps
} race_mode_e;

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
    // --- v3 ---
    uint8_t raceMode;       // race_mode_e
    uint16_t raceSeconds;
    uint8_t raceLaps;
    bool countdown;         // 3-2-1-go start instead of starting on the first pass
    bool announceDelta;     // announce the difference to the best lap
    // --- v4 ---
    uint32_t targetLapMs;   // pace target, 0 = off (used by the page only)
} laptimer_config_t;

static_assert(sizeof(laptimer_config_t) <= EEPROM_RESERVED_SIZE, "config does not fit the reserved EEPROM size");

// Copies at most size - 1 bytes without cutting a UTF-8 character in half
void copyUtf8(char *dst, const char *src, size_t size);

// 0 stays off; anything else is kept within TARGET_LAP_MIN_MS..TARGET_LAP_MAX_MS
uint32_t clampTargetLapMs(uint32_t ms);

class Config
{
public:
    void init();
    void load();
    void write();
    void toJson(String &destination);
    void toJsonString(char *buf, size_t size);
    void fromJson(JsonObject source);
    void handleEeprom(uint32_t currentTimeMs, bool allowWrite);

    uint16_t getFrequency();
    uint8_t getEnterRssi();
    uint8_t getExitRssi();
    const char *getPilotName();
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
    uint32_t getTargetLapMs();
    uint32_t getRevision() { return revision; }  // changes on every settings change, so pages can reload

private:
    laptimer_config_t conf;
    volatile bool modified;
    volatile uint32_t revision = 1;
    volatile uint32_t checkTimeMs = 0;
    void setDefaults();
    void setRaceDefaults();
    void toJsonDoc(JsonDocument &doc);
};
