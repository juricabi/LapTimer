#pragma once

#include <AsyncUDP.h>
#include <IPAddress.h>

// DHCP server for the timer's hotspot.
//
// The ESP32's built-in server sends every OFFER/ACK as a broadcast. WiFi doesn't acknowledge
// or retransmit broadcast frames, and the first reply after a phone joined was often lost:
// a phone then got its address only on a later retry, 5-40 s on, or Android gave up with
// "failed to obtain IP address" (measured with a packet capture). This server replies by
// unicast to the phone's MAC, as RFC 2131 4.1 asks when the broadcast bit is clear. The reply
// frame goes straight to the WiFi driver, which acknowledges and retransmits it.
#define DHCP_POOL_SIZE 20            // hotspot addresses .2 - .21
#define DHCP_LEASE_SECONDS 7200

class HotspotDhcp {
   public:
    void begin(IPAddress serverIp, IPAddress mask);  // call after WiFi.softAP(); stops the built-in server

    // Diagnostics: called with the phone's MAC and the address it got (DHCPACK)
    void (*onAssigned)(const uint8_t *mac, uint32_t ip) = nullptr;

   private:
    struct Lease {
        uint8_t mac[6];
        uint32_t expiresMs;
        bool used;
        bool bound; // acknowledged (or declined): not given to anyone else before it expires
    };
    AsyncUDP udp;
    Lease leases[DHCP_POOL_SIZE];
    uint32_t server = 0;  // network byte order, like ip4_addr_t
    uint32_t mask = 0;
    bool running = false;

    void handle(AsyncUDPPacket &packet);
    int findLease(const uint8_t *mac);
    int newLease(const uint8_t *mac);
    int leaseForAddress(uint32_t ip);
    uint32_t addressOf(int lease);
    void reply(const uint8_t *request, uint8_t type, uint32_t yiaddr);
};
