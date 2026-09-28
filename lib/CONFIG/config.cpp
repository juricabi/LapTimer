#include "config.h"

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
        // older layout: keep all existing settings, add defaults for the new ones
        DEBUG("Migrating config v%u -> v%u\n", version, CONFIG_VERSION);
        if (version < 1)
            setV1Defaults();
        if (version < 2)
            setV2Defaults();
        conf.version = CONFIG_VERSION | CONFIG_MAGIC;
        modified = true;
        write();
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

    EEPROM.put(0, conf);
    EEPROM.commit();

    DEBUG("Writing to EEPROM done\n");

    modified = false;
}

void Config::toJsonDoc(JsonDocument &config)
{
    config["freq"] = conf.frequency;
    config["minLap"] = conf.minLap;
    config["alarm"] = conf.alarm;
    config["anType"] = conf.announcerType;
    config["anRate"] = conf.announcerRate;
    config["anDelta"] = conf.announceDelta;
    config["buzzerOn"] = conf.buzzerOn;
    config["enterRssi"] = conf.enterRssi;
    config["exitRssi"] = conf.exitRssi;
    config["name"] = conf.pilotName;
    config["pilots"] = conf.pilotCount;
    // all pilots (index 0 = pilot 1, same values as the keys above)
    JsonArray list = config["p"].to<JsonArray>();
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        JsonObject p = list.add<JsonObject>();
        p["name"] = getPilotName(i);
        p["freq"] = getFrequency(i);
        p["enter"] = getEnterRssi(i);
        p["exit"] = getExitRssi(i);
    }
    config["raceMode"] = conf.raceMode;
    config["raceSec"] = conf.raceSeconds;
    config["raceLaps"] = conf.raceLaps;
    config["countdown"] = conf.countdown;
    config["rankBy"] = conf.rankBy;
    config["stagger"] = conf.staggered;
    // WiFi networks (with passwords) are managed by WifiList and never sent back to the page
}

void Config::toJson(AsyncResponseStream &destination)
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

static bool updateString(JsonObject source, const char *key, char *field, size_t size)
{
    JsonVariant value = source[key];
    if (value.isNull())
        return false;
    const char *newValue = value.as<const char *>();
    if (newValue == nullptr)
        newValue = "";
    if (strncmp(newValue, field, size) == 0)
        return false;
    strlcpy(field, newValue, size);
    return true;
}

void Config::fromJson(JsonObject source)
{
    bool changed = false;
    changed |= updateField(source, "freq", conf.frequency);
    changed |= updateField(source, "minLap", conf.minLap);
    changed |= updateField(source, "alarm", conf.alarm);
    changed |= updateField(source, "anType", conf.announcerType);
    changed |= updateField(source, "anRate", conf.announcerRate);
    changed |= updateField(source, "anDelta", conf.announceDelta);
    changed |= updateField(source, "buzzerOn", conf.buzzerOn);
    changed |= updateField(source, "enterRssi", conf.enterRssi);
    changed |= updateField(source, "exitRssi", conf.exitRssi);
    changed |= updateString(source, "name", conf.pilotName, sizeof(conf.pilotName));
    changed |= updateField(source, "pilots", conf.pilotCount);
    JsonArray list = source["p"].as<JsonArray>();
    uint8_t i = 0;
    for (JsonObject p : list)
    {
        if (i >= MAX_PILOTS)
            break;
        if (i == 0)
        {
            changed |= updateString(p, "name", conf.pilotName, sizeof(conf.pilotName));
            changed |= updateField(p, "freq", conf.frequency);
            changed |= updateField(p, "enter", conf.enterRssi);
            changed |= updateField(p, "exit", conf.exitRssi);
        }
        else
        {
            extra_pilot_t &e = conf.extraPilots[i - 1];
            changed |= updateString(p, "name", e.name, sizeof(e.name));
            changed |= updateField(p, "freq", e.frequency);
            changed |= updateField(p, "enter", e.enterRssi);
            changed |= updateField(p, "exit", e.exitRssi);
        }
        i++;
    }
    changed |= updateField(source, "raceMode", conf.raceMode);
    changed |= updateField(source, "raceSec", conf.raceSeconds);
    changed |= updateField(source, "raceLaps", conf.raceLaps);
    changed |= updateField(source, "countdown", conf.countdown);
    changed |= updateField(source, "rankBy", conf.rankBy);
    changed |= updateField(source, "stagger", conf.staggered);

    // keep values in sane ranges
    if (conf.pilotCount < 1)
        conf.pilotCount = 1;
    if (conf.pilotCount > MAX_PILOTS)
        conf.pilotCount = MAX_PILOTS;
    if (conf.rankBy > RANK_FASTEST_3)
        conf.rankBy = RANK_MOST_LAPS;
    if (conf.raceMode > RACE_LAPS)
        conf.raceMode = RACE_PRACTICE;
    if (conf.raceSeconds < 10)
        conf.raceSeconds = 10;
    if (conf.raceLaps < 1)
        conf.raceLaps = 1;

    if (changed)
        modified = true;
}

uint8_t Config::getPilotCount()
{
    return conf.pilotCount;
}

uint16_t Config::getFrequency(uint8_t pilot)
{
    return pilot == 0 ? conf.frequency : conf.extraPilots[pilot - 1].frequency;
}

uint8_t Config::getEnterRssi(uint8_t pilot)
{
    return pilot == 0 ? conf.enterRssi : conf.extraPilots[pilot - 1].enterRssi;
}

uint8_t Config::getExitRssi(uint8_t pilot)
{
    return pilot == 0 ? conf.exitRssi : conf.extraPilots[pilot - 1].exitRssi;
}

const char *Config::getPilotName(uint8_t pilot)
{
    return pilot == 0 ? conf.pilotName : conf.extraPilots[pilot - 1].name;
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

rank_by_e Config::getRankBy()
{
    return (rank_by_e)conf.rankBy;
}

bool Config::getStaggered()
{
    return conf.staggered;
}

void Config::setV2Defaults(void)
{
    conf.rankBy = RANK_MOST_LAPS;
    conf.staggered = false;
}

void Config::setV1Defaults(void)
{
    // Default channels for pilots 2-4: R2, R7, R8 (well separated for 4 pilots with R1)
    static const uint16_t defaultFreqs[MAX_PILOTS - 1] = {5695, 5880, 5917};
    conf.pilotCount = 1;
    for (uint8_t i = 0; i < MAX_PILOTS - 1; i++)
    {
        extra_pilot_t &e = conf.extraPilots[i];
        e.frequency = defaultFreqs[i];
        e.enterRssi = conf.enterRssi ? conf.enterRssi : 120;
        e.exitRssi = conf.exitRssi ? conf.exitRssi : 100;
        strlcpy(e.name, "", sizeof(e.name));
    }
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
    setV1Defaults();
    setV2Defaults();
    modified = true;
    write();
}

void Config::handleEeprom(uint32_t currentTimeMs)
{
    if (modified && ((currentTimeMs - checkTimeMs) > EEPROM_CHECK_TIME_MS))
    {
        checkTimeMs = currentTimeMs;
        write();
    }
}
