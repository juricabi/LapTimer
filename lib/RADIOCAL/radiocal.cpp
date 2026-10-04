#include "radiocal.h"

#include <Arduino.h>
#include <esp_phy_init.h>
#include <esp_sleep.h>
#include <esp_system.h>
#include <nvs.h>

// libphy's analog gain codes, strongest first (correct_rf_ana_gain_new; ~0.25 dB steps relative
// to 0x5f: +10 +5 0 -8 -18 -25 -34 -44 -55 -65 -71 -84 -96 -113 -127 -151). The number says
// nothing about strength: 0x5a is weaker than 0x5f, and a code outside the table makes the
// library compute from a register that was never set.
static const uint8_t CODES[] = {0x7f, 0x6f, 0x5f, 0x7a, 0x5a, 0x69, 0x75, 0x55,
                                0x74, 0x54, 0x44, 0x60, 0x40, 0x20, 0x10, 0x00};

int RadioCal::rank(int code)
{
    for (size_t i = 0; i < sizeof(CODES); i++)
        if (CODES[i] == code)
            return i;
    return -1;
}

bool RadioCal::isCode(int code) { return rank(code) >= 0; }

#if CONFIG_IDF_TARGET_ESP32
// The radio library's own namespace and keys (esp_phy_init.c), and ours with the same keys
static const char *PHY_NS = "phy";
static const char *BEST_NS = "phybest";
static const char *KEY_VERSION = "cal_version", *KEY_MAC = "cal_mac", *KEY_DATA = "cal_data", *KEY_CODE = "code";
#define CAL_DATA_MAX 2048 // cal_data is 1894 bytes on the classic ESP32

#define RTC_MAGIC 0x43414C31
static RTC_NOINIT_ATTR uint32_t rtcMagic;    // the two below are valid (RTC memory is random at power-up)
static RTC_NOINIT_ATTR uint32_t rtcPlain;    // diagnostics: starts calibrate as the library does
static RTC_NOINIT_ATTR uint32_t rtcRestored; // the start before this one put the best back

static bool fresh = false; // this start calibrates and the library stores the result
static bool plain = false;
static bool haveBest = false;
static uint8_t best = 0;
static const char *event = "none";

static bool hasCal(const char *ns)
{
    nvs_handle_t h;
    if (nvs_open(ns, NVS_READONLY, &h) != ESP_OK)
        return false;
    size_t len = 0;
    bool has = nvs_get_blob(h, KEY_DATA, nullptr, &len) == ESP_OK && len > 0;
    nvs_close(h);
    return has;
}

// Copies a calibration (its three entries) from one namespace to the other; code >= 0 is
// recorded with it. The data itself is never interpreted.
static bool copyCal(const char *from, const char *to, int code)
{
    nvs_handle_t src;
    if (nvs_open(from, NVS_READONLY, &src) != ESP_OK)
        return false;
    uint32_t version = 0;
    uint8_t mac[6];
    size_t macLen = sizeof(mac), dataLen = CAL_DATA_MAX;
    uint8_t *data = (uint8_t *)malloc(CAL_DATA_MAX);
    bool ok = data && nvs_get_u32(src, KEY_VERSION, &version) == ESP_OK &&
              nvs_get_blob(src, KEY_MAC, mac, &macLen) == ESP_OK &&
              nvs_get_blob(src, KEY_DATA, data, &dataLen) == ESP_OK;
    nvs_close(src);
    nvs_handle_t dst;
    if (ok && (ok = nvs_open(to, NVS_READWRITE, &dst) == ESP_OK))
    {
        ok = nvs_set_u32(dst, KEY_VERSION, version) == ESP_OK &&
             nvs_set_blob(dst, KEY_MAC, mac, macLen) == ESP_OK &&
             nvs_set_blob(dst, KEY_DATA, data, dataLen) == ESP_OK &&
             (code < 0 || nvs_set_u8(dst, KEY_CODE, code) == ESP_OK) &&
             nvs_commit(dst) == ESP_OK;
        nvs_close(dst);
    }
    free(data);
    return ok;
}

static bool writeBestCode(uint8_t code)
{
    nvs_handle_t h;
    if (nvs_open(BEST_NS, NVS_READWRITE, &h) != ESP_OK)
        return false;
    bool ok = nvs_set_u8(h, KEY_CODE, code) == ESP_OK && nvs_commit(h) == ESP_OK;
    nvs_close(h);
    if (ok)
        best = code;
    return ok;
}

// Woken from deep sleep, the library loads the stored calibration without calibrating
static void sleepAndRestart()
{
    esp_sleep_enable_timer_wakeup(1000);
    esp_deep_sleep_start();
}

void RadioCal::beginBoot()
{
    if (rtcMagic != RTC_MAGIC)
    {
        rtcMagic = RTC_MAGIC;
        rtcPlain = 0;
        rtcRestored = 0;
    }
    nvs_handle_t h;
    if (nvs_open(BEST_NS, NVS_READONLY, &h) == ESP_OK)
    {
        haveBest = nvs_get_u8(h, KEY_CODE, &best) == ESP_OK && hasCal(BEST_NS);
        nvs_close(h);
    }
    if (rtcPlain)
    {
        plain = true;
        return;
    }
    esp_reset_reason_t reason = esp_reset_reason();
    bool stored = hasCal(PHY_NS);
    if (stored && haveBest && (reason == ESP_RST_POWERON || reason == ESP_RST_EXT))
    {
        esp_phy_erase_cal_data_in_nvs(); // a power-on calibrates in full, and the library stores that
        stored = false;
    }
    fresh = !stored; // with nothing stored the library calibrates in full and stores, whatever the reset
    if (!fresh && reason != ESP_RST_DEEPSLEEP)
        sleepAndRestart();
}

void RadioCal::afterWifiStart(uint8_t code)
{
    static bool done = false;
    if (done)
        return;
    done = true;
    if (plain)
    {
        event = "plain";
        return;
    }
    if (!fresh && haveBest)
    {
        if (code != best && rtcRestored)
            writeBestCode(code); // the best put back calibrates to this code: record it
        if (code == best)
        {
            event = rtcRestored ? "restored" : "reused";
            rtcRestored = 0;
            return;
        }
        // otherwise the library stored a new calibration anyway (its version changed: an update)
    }
    int r = rank(code);
    if (!haveBest || (r >= 0 && r < rank(best)))
    {
        event = haveBest ? "better" : "adopted";
        if (copyCal(PHY_NS, BEST_NS, code))
        {
            best = code;
            haveBest = true;
        }
        else
            event = "keep failed";
        return;
    }
    if (r == rank(best))
    {
        event = "same";
        return;
    }
    // weaker (or no code of the table): the best goes back and is loaded without calibrating
    if (copyCal(BEST_NS, PHY_NS, -1))
    {
        rtcRestored = 1;
        sleepAndRestart();
    }
    event = "restore failed";
}

uint8_t RadioCal::bestCode() { return haveBest ? best : 0; }
const char *RadioCal::lastEvent() { return event; }

bool RadioCal::forget()
{
    nvs_handle_t h;
    bool ok = nvs_open(BEST_NS, NVS_READWRITE, &h) == ESP_OK;
    if (ok)
    {
        ok = nvs_erase_all(h) == ESP_OK && nvs_commit(h) == ESP_OK;
        nvs_close(h);
    }
    haveBest = false;
    best = 0;
    return esp_phy_erase_cal_data_in_nvs() == ESP_OK && ok;
}

bool RadioCal::setBestCode(int code) { return haveBest && isCode(code) && writeBestCode(code); }
void RadioCal::setHop(bool on) { rtcPlain = on ? 0 : 1; }
#else
void RadioCal::beginBoot() {}
void RadioCal::afterWifiStart(uint8_t code) { (void)code; }
uint8_t RadioCal::bestCode() { return 0; }
const char *RadioCal::lastEvent() { return "none"; }
bool RadioCal::forget() { return esp_phy_erase_cal_data_in_nvs() == ESP_OK; }
bool RadioCal::setBestCode(int code) { (void)code; return false; }
void RadioCal::setHop(bool on) { (void)on; }
#endif
