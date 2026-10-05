#pragma once

#include <Arduino.h>
#include <IPAddress.h>

#define DDNS_NAME_MAX 63   // a DuckDNS subdomain: 1-63 of a-z, 0-9 and -, not at the ends
#define DDNS_TOKEN_MAX 64  // the account token: a UUID (36 characters), 20-64 of 0-9, a-f and -

// An internet name for the timer (DuckDNS, free). A phone's hotspot hands out a different
// address every time and Android can't resolve laptimer.local there, so whenever the timer is
// on a network with internet it tells DuckDNS its address, and http://<name>.duckdns.org opens
// the page from that phone (and from home). Name and token live in NVS like WiFi passwords;
// the token never leaves the timer. The update runs in its own task on core 0, so neither the
// timing core nor the web server waits for it; failures say why and are tried again with
// growing pauses (30 s to 10 min), a new address or network at once.
class Ddns {
   public:
    enum State : uint8_t { OFF, NO_NETWORK, WAITING, UPDATING, OK, FAILED };
    void init();
    // Every service round (core 0): the station's state and address
    void handle(uint32_t nowMs, bool connected, IPAddress ip);
    // name "" clears both; token "" keeps the stored one. False: invalid (nothing changed)
    bool set(const char *name, const char *token);
    void updateNow() { dueMs = 0; retryStep = 0; force = true; }
    bool configured() { return nameBuf[0] != 0; }
    bool hasToken() { return tokenBuf[0] != 0; }
    const char *name() { return nameBuf; }
    State state();
    const char *result() { return resultBuf; }  // what the last try reported
    uint32_t lastTryMs() { return lastTry; }    // 0 = none yet
    uint32_t lastOkMs() { return lastOk; }
    IPAddress sentIp() { return sent; }

    static bool validName(const char *name);    // after normalizeName
    static bool validToken(const char *token);
    // lower case, ".duckdns.org" and spaces removed (the name as shown on the DuckDNS page)
    static void normalizeName(const char *in, char *out, size_t outLen);

   private:
    char nameBuf[DDNS_NAME_MAX + 1] = "";
    char tokenBuf[DDNS_TOKEN_MAX + 1] = "";
    char resultBuf[96] = "";
    volatile bool running = false;
    volatile bool finished = false; // the task has ended: handle() plans what follows
    volatile bool force = false;
    bool wasConnected = false;
    IPAddress current;   // the station's address now
    IPAddress sent;      // the address DuckDNS has
    IPAddress attempt;   // the address the running try sends
    uint32_t dueMs = 0;  // the next try, 0 = none planned
    uint32_t lastTry = 0, lastOk = 0;
    uint8_t retryStep = 0;
    bool lastFailed = false;
    void load();
    void save();
    void start(IPAddress ip);
    void run();  // the update itself, in the task
    static void task(void *arg);
};
