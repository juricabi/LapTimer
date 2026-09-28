#include "wifilist.h"

#include <Preferences.h>
#include <WiFi.h>

#include "debug.h"

static const char *NVS_NAMESPACE = "wifi";

void WifiList::init(Config *config)
{
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, true);
    n = prefs.getUChar("n", 0);
    if (n > MAX_WIFI_NETWORKS)
        n = 0;
    if (n > 0 && prefs.getBytes("list", nets, sizeof(WifiNetwork) * n) != sizeof(WifiNetwork) * n)
        n = 0;
    prefs.end();

    // Move the network saved by older firmware (single SSID in the config) into the list
    if (config->getSsid()[0] != 0)
    {
        add(config->getSsid(), config->getPassword());
        config->clearWifi();
    }
    DEBUG("%u saved WiFi networks\n", n);
}

void WifiList::save()
{
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, false);
    prefs.putUChar("n", n);
    if (n > 0)
        prefs.putBytes("list", nets, sizeof(WifiNetwork) * n);
    else
        prefs.remove("list");
    prefs.end();
}

bool WifiList::add(const char *ssid, const char *pass)
{
    if (!ssid || ssid[0] == 0 || strlen(ssid) > 32 || (pass && strlen(pass) > 64))
        return false;
    WifiNetwork entry;
    strlcpy(entry.ssid, ssid, sizeof(entry.ssid));
    strlcpy(entry.pass, pass ? pass : "", sizeof(entry.pass));

    // drop an existing entry with the same name, then insert at the top
    uint8_t count = n;
    for (uint8_t i = 0; i < count; i++)
    {
        if (strcmp(nets[i].ssid, ssid) == 0)
        {
            for (uint8_t j = i; j + 1 < count; j++)
                nets[j] = nets[j + 1];
            count--;
            break;
        }
    }
    if (count == MAX_WIFI_NETWORKS)
        count--; // list full: forget the oldest
    for (uint8_t j = count; j > 0; j--)
        nets[j] = nets[j - 1];
    nets[0] = entry;
    n = count + 1;
    save();
    return true;
}

bool WifiList::remove(const char *ssid)
{
    for (uint8_t i = 0; i < n; i++)
    {
        if (strcmp(nets[i].ssid, ssid) == 0)
        {
            for (uint8_t j = i; j + 1 < n; j++)
                nets[j] = nets[j + 1];
            n = n - 1;
            save();
            return true;
        }
    }
    return false;
}

void WifiList::clear()
{
    n = 0;
    save();
}

int WifiList::pickBest(int16_t found)
{
    int best = -1;
    int32_t bestRssi = -1000;
    for (int16_t i = 0; i < found; i++)
    {
        String name = WiFi.SSID(i);
        for (uint8_t k = 0; k < n; k++)
        {
            if (name == nets[k].ssid && WiFi.RSSI(i) > bestRssi)
            {
                best = k;
                bestRssi = WiFi.RSSI(i);
            }
        }
    }
    return best;
}
