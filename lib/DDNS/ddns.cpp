#include "ddns.h"

#include <HTTPClient.h>
#include <Preferences.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>

#include "debug.h"

static const char *NVS_NAMESPACE = "ddns";
static const char *HOST = "www.duckdns.org";

// pauses before trying again after a failure, the last one for every further try
static const uint32_t RETRY_S[] = {30, 60, 120, 300, 600};
#define DDNS_SETTLE_MS 2000   // after joining a network: DHCP done, the address is final
#define DDNS_TASK_STACK 10240
#define DDNS_MIN_HEAP 60000   // TLS needs about 40 KB while it runs

void Ddns::init() { load(); }

void Ddns::load()
{
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, true);
    prefs.getString("name", nameBuf, sizeof(nameBuf));
    prefs.getString("token", tokenBuf, sizeof(tokenBuf));
    prefs.end();
    if (!validName(nameBuf))
        nameBuf[0] = 0; // a stored value that fails the checks (older firmware, a flash fault) is dropped
    if (!validToken(tokenBuf))
        tokenBuf[0] = 0;
}

void Ddns::save()
{
    Preferences prefs;
    prefs.begin(NVS_NAMESPACE, false);
    if (nameBuf[0])
        prefs.putString("name", nameBuf);
    else
        prefs.remove("name");
    if (tokenBuf[0])
        prefs.putString("token", tokenBuf);
    else
        prefs.remove("token");
    prefs.end();
}

// The subdomain as DuckDNS shows it: lower case, without ".duckdns.org", "http://" or spaces
void Ddns::normalizeName(const char *in, char *out, size_t outLen)
{
    size_t n = 0;
    out[0] = 0;
    if (!in)
        return;
    while (*in == ' ')
        in++;
    if (strncasecmp(in, "http://", 7) == 0)
        in += 7;
    else if (strncasecmp(in, "https://", 8) == 0)
        in += 8;
    for (; *in && n + 1 < outLen; in++)
    {
        if (*in == '/')
            break;
        out[n++] = tolower((unsigned char)*in);
    }
    while (n && out[n - 1] == ' ')
        n--; // trailing spaces go; a space inside stays, so the check refuses the name
    out[n] = 0;
    const char *suffix = ".duckdns.org";
    size_t sl = strlen(suffix);
    if (n > sl && strcmp(out + n - sl, suffix) == 0)
        out[n - sl] = 0;
}

bool Ddns::validName(const char *name)
{
    size_t n = strlen(name);
    if (n < 1 || n > DDNS_NAME_MAX || name[0] == '-' || name[n - 1] == '-')
        return false;
    for (size_t i = 0; i < n; i++)
        if (!((name[i] >= 'a' && name[i] <= 'z') || (name[i] >= '0' && name[i] <= '9') || name[i] == '-'))
            return false;
    return true;
}

bool Ddns::validToken(const char *token)
{
    size_t n = strlen(token);
    if (n < 20 || n > DDNS_TOKEN_MAX)
        return false;
    for (size_t i = 0; i < n; i++)
        if (!((token[i] >= 'a' && token[i] <= 'f') || (token[i] >= '0' && token[i] <= '9') || token[i] == '-'))
            return false;
    return true;
}

bool Ddns::set(const char *name, const char *token)
{
    char n[DDNS_NAME_MAX + 1];
    normalizeName(name, n, sizeof(n));
    if (!n[0])
    {
        // clears the name and the token: the timer has no internet name any more
        nameBuf[0] = tokenBuf[0] = 0;
        save();
        dueMs = 0;
        lastFailed = false;
        lastOk = lastTry = 0;
        resultBuf[0] = 0;
        sent = IPAddress();
        return true;
    }
    if (!validName(n))
        return false;
    char t[DDNS_TOKEN_MAX + 1] = "";
    size_t tn = 0;
    for (const char *p = token ? token : ""; *p && tn + 1 < sizeof(t); p++)
        if (*p != ' ')
            t[tn++] = tolower((unsigned char)*p);
    t[tn] = 0;
    if (t[0] && !validToken(t))
        return false;
    if (!t[0] && !tokenBuf[0])
        return false; // a name needs a token
    strlcpy(nameBuf, n, sizeof(nameBuf));
    if (t[0])
        strlcpy(tokenBuf, t, sizeof(tokenBuf));
    save();
    sent = IPAddress(); // DuckDNS has nothing for this name yet (as far as the timer knows)
    lastOk = 0;
    lastFailed = false;
    resultBuf[0] = 0;
    updateNow();
    return true;
}

Ddns::State Ddns::state()
{
    if (!configured() || !tokenBuf[0])
        return OFF;
    if (running)
        return UPDATING;
    if (!wasConnected)
        return NO_NETWORK;
    if (lastFailed)
        return FAILED;
    if (lastOk && sent == current)
        return OK;
    return WAITING;
}

void Ddns::handle(uint32_t nowMs, bool connected, IPAddress ip)
{
    bool was = wasConnected;
    wasConnected = connected;
    if (!configured() || !tokenBuf[0])
        return;
    if (!connected)
    {
        current = IPAddress();
        dueMs = 0; // off a network there is nothing to tell; the next join starts again
        return;
    }
    if (!was || ip != current)
    {
        // joined, or a new address: DuckDNS gets it shortly (a changed name/token too)
        current = ip;
        retryStep = 0;
        lastFailed = false;
        dueMs = nowMs + DDNS_SETTLE_MS;
    }
    if (force)
    {
        force = false;
        dueMs = nowMs; // now (the service round is the only writer of dueMs)
    }
    if (finished)
    {
        // the task has ended: plan the next try, or none
        finished = false;
        if (lastFailed)
        {
            uint8_t step = retryStep < (sizeof(RETRY_S) / sizeof(RETRY_S[0])) ? retryStep : (sizeof(RETRY_S) / sizeof(RETRY_S[0]) - 1);
            dueMs = nowMs + RETRY_S[step] * 1000;
            retryStep++;
        }
        else
            dueMs = 0;
    }
    if (running || dueMs == 0 || (int32_t)(nowMs - dueMs) < 0)
        return;
    dueMs = 0;
    start(ip);
}

void Ddns::start(IPAddress ip)
{
    if (ESP.getFreeHeap() < DDNS_MIN_HEAP)
    {
        strlcpy(resultBuf, "not enough free memory for the update now", sizeof(resultBuf));
        lastTry = millis();
        lastFailed = true;
        finished = true;
        return;
    }
    attempt = ip;
    running = true;
    if (xTaskCreatePinnedToCore(task, "ddns", DDNS_TASK_STACK, this, 1, nullptr, 0) != pdPASS)
    {
        running = false;
        strlcpy(resultBuf, "could not start the update (memory)", sizeof(resultBuf));
        lastTry = millis();
        lastFailed = true;
        finished = true;
    }
}

void Ddns::task(void *arg)
{
    Ddns *self = (Ddns *)arg;
    self->run();
    self->finished = true;
    self->running = false;
    vTaskDelete(NULL);
}

// One GET through the client given; the answer's body in `body`. Returns the HTTP code, or
// HTTPClient's negative error.
static int request(WiFiClient &client, const char *scheme, const String &path, String &body)
{
    HTTPClient http;
    http.setConnectTimeout(5000);
    http.setTimeout(8000);
    http.setReuse(false);
    String url = String(scheme) + "://" + HOST + path;
    if (!http.begin(client, url))
        return HTTPC_ERROR_CONNECTION_REFUSED;
    int code = http.GET();
    if (code > 0)
        body = http.getString();
    http.end();
    return code;
}

void Ddns::run()
{
    lastTry = millis();
    IPAddress ip = attempt;
    String path = String("/update?domains=") + nameBuf + "&token=" + tokenBuf + "&ip=" + ip.toString() + "&verbose=true";
    IPAddress resolved;
    if (!WiFi.hostByName(HOST, resolved))
    {
        strlcpy(resultBuf, "no internet on this network (duckdns.org not found)", sizeof(resultBuf));
        lastFailed = true;
        return;
    }
    // https without a certificate check (encrypted; nothing embedded that could go stale: only
    // a private address and the token travel), and plain http if TLS itself fails, said so
    String body;
    const char *how = "";
    int code;
    {
        WiFiClientSecure client;
        client.setInsecure();
        client.setTimeout(8);
        code = request(client, "https", path, body);
    }
    if (code == HTTPC_ERROR_CONNECTION_REFUSED)
    {
        WiFiClient client;
        client.setTimeout(8);
        code = request(client, "http", path, body);
        how = ", sent over plain http (TLS failed)";
    }
    if (code == HTTPC_ERROR_CONNECTION_REFUSED || code == HTTPC_ERROR_CONNECTION_LOST)
        snprintf(resultBuf, sizeof(resultBuf), "could not connect to duckdns.org");
    else if (code == HTTPC_ERROR_READ_TIMEOUT || code == HTTPC_ERROR_SEND_HEADER_FAILED)
        snprintf(resultBuf, sizeof(resultBuf), "duckdns.org did not answer in time");
    else if (code < 0)
        snprintf(resultBuf, sizeof(resultBuf), "request failed (%d)", code);
    else if (code != 200)
        snprintf(resultBuf, sizeof(resultBuf), "duckdns.org answered HTTP %d", code);
    else if (body.startsWith("KO"))
        snprintf(resultBuf, sizeof(resultBuf), "refused by duckdns.org: check the name and the token");
    else if (body.startsWith("OK"))
    {
        snprintf(resultBuf, sizeof(resultBuf), "updated%s", how);
        sent = ip;
        lastOk = millis();
        lastFailed = false;
        DEBUG("DuckDNS: %s.duckdns.org = %s%s\n", nameBuf, ip.toString().c_str(), how);
        return;
    }
    else
        snprintf(resultBuf, sizeof(resultBuf), "unexpected answer from duckdns.org");
    lastFailed = true;
    DEBUG("DuckDNS: %s\n", resultBuf);
}
