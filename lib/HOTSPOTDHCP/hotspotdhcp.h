#pragma once

#include <AsyncUDP.h>
#include <IPAddress.h>

// DHCP server for the timer's hotspot.
//
// The ESP32's built-in server sends every OFFER/ACK as a broadcast. WiFi doesn't acknowledge
// or retransmit broadcast frames, and the first reply after a phone joined was often lost:
// a phone then got its address only on a later retry, 3-40 s on, or Android gave up with
// "failed to obtain IP address" (measured with a packet capture). This server sends every
// reply as a frame addressed to the phone's MAC (RFC 2131 4.1 allows it when the broadcast
// bit is clear; a NAK keeps the IP broadcast address but goes to the phone's MAC too, so it
// isn't lost either). The frame goes straight to the WiFi driver, which acknowledges and
// retransmits it.
//
// Phones keep their address across the timer's restart (a lease lasts two hours), and the
// built-in server forgets everything on a restart: the next device to join was given the
// address a phone was still using, and both then got each other's replies (measured: a page
// that loads sometimes, no live RSSI). So the lease table lives in RTC memory, which a
// restart keeps, every address is probed with ARP before it is handed out (a phone from
// before a power cycle answers), and a device gets the same address back when it can (an
// address derived from its MAC is tried first).
#define DHCP_POOL_SIZE 20            // hotspot addresses .2 - .21
#define DHCP_LEASE_SECONDS 7200
#define DHCP_ARP_PROBE_MS 120        // wait for an answer to each ARP probe (two are sent)

class HotspotDhcp {
   public:
    struct Lease {
        uint8_t mac[6];
        uint32_t expiresMs;
        bool used;
        bool bound; // acknowledged (or declined, or in use by another device): kept until it expires
    };
    enum Event { EVENT_ASSIGNED = 1, EVENT_OFFERED = 3, EVENT_REFUSED = 4, EVENT_IN_USE = 5, EVENT_TX_FAILED = 6,
                 EVENT_KEPT = 7, EVENT_CLEARED = 8 }; // 7/8 at start: leases kept across the restart (ip = count) or cleared (ip = magic found)

    void begin(IPAddress serverIp, IPAddress mask);  // call after WiFi.softAP(); stops the built-in server

    // Diagnostics: the phone's MAC and the address involved (Event says what happened)
    void (*onEvent)(uint8_t type, const uint8_t *mac, uint32_t ip) = nullptr;

   private:
    AsyncUDP udp;
    Lease *leases = nullptr;  // in RTC memory (see hotspotdhcp.cpp)
    uint32_t server = 0;  // network byte order, like ip4_addr_t
    uint32_t mask = 0;
    bool running = false;

    void handle(AsyncUDPPacket &packet);
    int findLease(const uint8_t *mac);
    int newLease(const uint8_t *mac);
    int leaseForAddress(uint32_t ip);
    uint32_t addressOf(int lease);
    bool inUseByOther(uint32_t ip, const uint8_t *mac);
    void commit();
    void reply(const uint8_t *request, uint8_t type, uint32_t yiaddr);
    void event(uint8_t type, const uint8_t *mac, uint32_t ip) { if (onEvent) onEvent(type, mac, ip); }
};
