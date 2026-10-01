#include "config.h"

#include "RX5808.h" // POWER_DOWN_FREQ_MHZ

#include <EEPROM.h>

#include "debug.h"

void Config::init(void)
{
    if (sizeof(laptimer_config_t) > EEPROM_RESERVED_SIZE)
    {
        DEBUG("Config size too big, adjust reserved EEPROM size\n");
        return;
    }

    EEPROM.begin(EEPROM_RESERVED_SIZE); // Size of EEPROM
    load();                             // Override default settings from EEPROM

    checkTimeMs = millis();

    DEBUG("EEPROM Init Successful\n");
}

void Config::load(void)
{
    modified = false;
    EEPROM.get(0, conf);

    uint32_t version = 0xFFFFFFFF;
    if ((conf.version & CONFIG_MAGIC_MASK) == CONFIG_MAGIC)
    {
        version = conf.version & ~CONFIG_MAGIC_MASK;
    }

    if (version < CONFIG_VERSION)
    {
        // older layout: keep the fields it had, give the newer ones their defaults
        DEBUG("Migrating config v%u -> v%u\n", version, CONFIG_VERSION);
        if (version < 3)
            setRaceDefaults(); // v0 (and the v1/v2 development layouts): v0 fields only
        if (version < 4)
            conf.targetLapMs = 0;
        if (version < 5)
            conf.announceTarget = false; // laps keep being compared as before (best lap or not at all)
        conf.version = CONFIG_VERSION | CONFIG_MAGIC;
        modified = true;
        write();
    }
    else if (version > CONFIG_VERSION && version <= CONFIG_VERSION_NEWEST_KEPT)
    {
        // saved by a newer firmware (going back a version): the layout is append-only, so the
        // fields this one knows are valid. The version stays, and so do the newer fields beyond
        // this struct (a write covers only sizeof(conf)): updating again finds them unchanged.
        DEBUG("Config v%u from a newer firmware: keeping the v%u fields\n", version, CONFIG_VERSION);
    }
    else if (version != CONFIG_VERSION)
    {
        setDefaults();
    }
}

void Config::write(void)
{
    if (!modified)
        return;

    DEBUG("Writing to EEPROM\n");

    // cleared first: a change arriving during the commit is written next time
    modified = false;
    EEPROM.put(0, conf);
    EEPROM.commit();

    DEBUG("Writing to EEPROM done\n");
}

void Config::toJsonDoc(JsonDocument &config)
{
    config["rev"] = revision; // first: values read after it are at least this new
    config["freq"] = conf.frequency;
    config["minLap"] = conf.minLap;
    config["alarm"] = conf.alarm;
    config["anType"] = conf.announcerType;
    config["anRate"] = conf.announcerRate;
    config["anDelta"] = conf.announceDelta;
    config["anTarget"] = conf.announceTarget;
    config["buzzerOn"] = conf.buzzerOn;
    config["enterRssi"] = conf.enterRssi;
    config["exitRssi"] = conf.exitRssi;
    config["name"] = conf.pilotName;
    config["raceMode"] = conf.raceMode;
    config["raceSec"] = conf.raceSeconds;
    config["raceLaps"] = conf.raceLaps;
    config["countdown"] = conf.countdown;
    config["target"] = conf.targetLapMs;
    // WiFi networks (with passwords) are managed by WifiList and never sent back to the page
}

void Config::toJson(String &destination)
{
    JsonDocument config;
    toJsonDoc(config);
    serializeJson(config, destination);
}

void Config::toJsonString(char *buf, size_t size)
{
    JsonDocument config;
    toJsonDoc(config);
    serializeJsonPretty(config, buf, size);
}

// Only fields present in the request are changed, so partial updates are safe
template <typename T>
static bool updateField(JsonObject source, const char *key, T &field)
{
    JsonVariant value = source[key];
    if (value.isNull())
        return false;
    T newValue = value.as<T>();
    if (newValue == field)
        return false;
    field = newValue;
    return true;
}

// Copies at most size - 1 bytes without cutting a UTF-8 character in half
void copyUtf8(char *dst, const char *src, size_t size)
{
    size_t n = strnlen(src, size - 1);
    if (src[n] != 0)
    {
        while (n > 0 && (src[n] & 0xC0) == 0x80)
            n--; // src[n] continues a character that doesn't fit: drop the whole character
    }
    memcpy(dst, src, n);
    dst[n] = 0;
}

static bool updateString(JsonObject source, const char *key, char *field, size_t size)
{
    JsonVariant value = source[key];
    if (value.isNull())
        return false;
    const char *newValue = value.as<const char *>();
    char buf[64];
    copyUtf8(buf, newValue ? newValue : "", size < sizeof(buf) ? size : sizeof(buf));
    if (strcmp(buf, field) == 0)
        return false;
    strlcpy(field, buf, size);
    return true;
}

uint32_t clampTargetLapMs(uint32_t ms)
{
    if (ms == 0)
        return 0;
    return ms < TARGET_LAP_MIN_MS ? TARGET_LAP_MIN_MS : ms > TARGET_LAP_MAX_MS ? TARGET_LAP_MAX_MS : ms;
}

// Exit must stay below enter, or every reading between them would open and close a pass.
// Both stay within the page's sliders (RSSI_SLIDER_MIN-255), so the page shows what is used.
void fixThresholds(uint8_t &enter, uint8_t &exit)
{
    if (enter < RSSI_SLIDER_MIN + 1)
        enter = RSSI_SLIDER_MIN + 1;
    if (exit < RSSI_SLIDER_MIN)
        exit = RSSI_SLIDER_MIN;
    if (exit >= enter)
        exit = enter - 1;
}

template <typename T>
static void keepWithin(T &value, T low, T high)
{
    if (value < low)
        value = low;
    else if (value > high)
        value = high;
}

// Changes are made on a copy and checked before they are published: the timing core
// reads the settings at any moment
void Config::fromJson(JsonObject source)
{
    laptimer_config_t next = this->conf;
    laptimer_config_t &conf = next; // the updates below go to the copy
    bool changed = false;
    changed |= updateField(source, "freq", conf.frequency);
    changed |= updateField(source, "minLap", conf.minLap);
    changed |= updateField(source, "alarm", conf.alarm);
    changed |= updateField(source, "anType", conf.announcerType);
    changed |= updateField(source, "anRate", conf.announcerRate);
    changed |= updateField(source, "anDelta", conf.announceDelta);
    changed |= updateField(source, "anTarget", conf.announceTarget);
    // a lap is compared with the best lap or with the target, never both: the one switched
    // on now wins (an old page or a second phone can't leave both on)
    if (conf.announceDelta && conf.announceTarget)
    {
        if (source["anTarget"] | false)
            conf.announceDelta = false;
        else
            conf.announceTarget = false;
    }
    changed |= updateField(source, "buzzerOn", conf.buzzerOn);
    changed |= updateField(source, "enterRssi", conf.enterRssi);
    changed |= updateField(source, "exitRssi", conf.exitRssi);
    changed |= updateString(source, "name", conf.pilotName, sizeof(conf.pilotName));
    changed |= updateField(source, "raceMode", conf.raceMode);
    changed |= updateField(source, "raceSec", conf.raceSeconds);
    changed |= updateField(source, "raceLaps", conf.raceLaps);
    changed |= updateField(source, "countdown", conf.countdown);
    changed |= updateField(source, "target", conf.targetLapMs);

    // keep values within the ranges of the page's controls: another phone, an older page or the
    // API can't set a value the page would show differently (a slider can't show 10 s or 40 laps)
    if (conf.frequency != POWER_DOWN_FREQ_MHZ && (conf.frequency < 5000 || conf.frequency > 5999))
        conf.frequency = this->conf.frequency; // outside the 5.8 GHz band: keep the old one
    keepWithin<uint8_t>(conf.minLap, 10, 200);          // 1-20 s
    if (conf.raceMode > RACE_LAPS)
        conf.raceMode = RACE_PRACTICE;
    keepWithin<uint16_t>(conf.raceSeconds, 30, 600);    // 0:30-10:00
    keepWithin<uint8_t>(conf.raceLaps, 1, 30);
    keepWithin<uint8_t>(conf.announcerRate, 1, 20);     // 0.1-2.0
    keepWithin<uint8_t>(conf.alarm, 0, 42);             // off-4.2 V
    conf.targetLapMs = clampTargetLapMs(conf.targetLapMs);
    fixThresholds(conf.enterRssi, conf.exitRssi);

    if (changed)
    {
        this->conf = next;
        modified = true;
        revision++;
    }
}

uint16_t Config::getFrequency()
{
    return conf.frequency;
}

uint8_t Config::getEnterRssi()
{
    return conf.enterRssi;
}

uint8_t Config::getExitRssi()
{
    return conf.exitRssi;
}

const char *Config::getPilotName()
{
    return conf.pilotName;
}

// The network is moved into the saved WiFi list; forget it here
void Config::clearWifi()
{
    memset(conf.ssid, 0, sizeof(conf.ssid));
    memset(conf.password, 0, sizeof(conf.password));
    modified = true;
    write();
}

uint32_t Config::getMinLapMs()
{
    return conf.minLap * 100;
}

uint8_t Config::getAlarmThreshold()
{
    return conf.alarm;
}

char *Config::getSsid()
{
    return conf.ssid;
}

char *Config::getPassword()
{
    return conf.password;
}

bool Config::getBuzzerOn()
{
    return conf.buzzerOn;
}

race_mode_e Config::getRaceMode()
{
    return (race_mode_e)conf.raceMode;
}

uint32_t Config::getRaceMs()
{
    return (uint32_t)conf.raceSeconds * 1000;
}

uint8_t Config::getRaceLaps()
{
    return conf.raceLaps;
}

bool Config::getCountdown()
{
    return conf.countdown;
}

uint32_t Config::getTargetLapMs()
{
    return conf.targetLapMs;
}

void Config::setRaceDefaults(void)
{
    conf.raceMode = RACE_PRACTICE;
    conf.raceSeconds = 120;
    conf.raceLaps = 3;
    conf.countdown = false;
    conf.announceDelta = false;
}

void Config::setDefaults(void)
{
    DEBUG("Setting EEPROM defaults\n");
    // Reset everything to 0/false and then just set anything that zero is not appropriate
    memset(&conf, 0, sizeof(conf));
    conf.version = CONFIG_VERSION | CONFIG_MAGIC;
    conf.frequency = 1111;
    conf.minLap = 100;
    conf.alarm = 0;  // off by default: on USB power VBAT reads ~0V and would trigger the alarm
    conf.announcerType = 2;
    conf.announcerRate = 10;
    conf.enterRssi = 120;
    conf.exitRssi = 100;
    conf.buzzerOn = true;
    strlcpy(conf.ssid, "", sizeof(conf.ssid));
    strlcpy(conf.password, "", sizeof(conf.password));
    strlcpy(conf.pilotName, "", sizeof(conf.pilotName));
    setRaceDefaults();
    conf.targetLapMs = 0;
    conf.announceTarget = false;
    modified = true;
    write();
}

// allowWrite = false during a race: a flash write stalls both cores, including RSSI sampling
void Config::handleEeprom(uint32_t currentTimeMs, bool allowWrite)
{
    if (allowWrite && modified && ((currentTimeMs - checkTimeMs) > EEPROM_CHECK_TIME_MS))
    {
        checkTimeMs = currentTimeMs;
        write();
    }
}
