#include "hotspotdhcp.h"

#include <WiFi.h>
#include <esp_attr.h>
#include <esp_netif.h>
#include <esp_netif_net_stack.h>
#include <esp_private/wifi.h>
#include <lwip/etharp.h>
#include <lwip/tcpip.h>

#include "debug.h"

// DHCP message (RFC 2131): 236 fixed bytes, the magic cookie, then options
#define BOOTP_FIXED 236
#define OPT_START (BOOTP_FIXED + 4)
#define OFF_OP 0
#define OFF_XID 4
#define OFF_FLAGS 10
#define OFF_CIADDR 12
#define OFF_YIADDR 16
#define OFF_GIADDR 24
#define OFF_CHADDR 28
#define BROADCAST_FLAG 0x80  // high bit of the flags field

enum { DISCOVER = 1, OFFER = 2, REQUEST = 3, DECLINE = 4, ACK = 5, NAK = 6, RELEASE = 7, INFORM = 8 };

static const uint8_t MAGIC[4] = {99, 130, 83, 99};

// The lease table, in RTC memory: a restart keeps it (a power cycle doesn't; the checksum
// tells). Phones keep their address across the timer's restart, and an empty table handed
// a phone's address to the next device (see hotspotdhcp.h).
#define LEASES_MAGIC 0x4C454153
struct RtcLeases
{
    uint32_t magic;
    HotspotDhcp::Lease leases[DHCP_POOL_SIZE];
    uint32_t check;
};
static RTC_NOINIT_ATTR RtcLeases rtcLeases;

static uint32_t leasesChecksum(const HotspotDhcp::Lease *leases)
{
    uint32_t sum = 0x5A5A;
    const uint8_t *b = (const uint8_t *)leases;
    for (size_t i = 0; i < sizeof(HotspotDhcp::Lease) * DHCP_POOL_SIZE; i++)
        sum = sum * 31 + b[i];
    return sum;
}

// ARP table lookups and requests run in lwIP's own thread
struct ArpQuery
{
    struct netif *netif;
    ip4_addr_t ip;
    uint8_t mac[6];
    volatile int found;
    volatile bool done;
};
static void arpRequestCb(void *arg)
{
    ArpQuery *q = (ArpQuery *)arg;
    etharp_request(q->netif, &q->ip);
    q->done = true;
}
static void arpFindCb(void *arg)
{
    ArpQuery *q = (ArpQuery *)arg;
    struct eth_addr *eth = nullptr;
    const ip4_addr_t *ipr = nullptr;
    q->found = etharp_find_addr(q->netif, &q->ip, &eth, &ipr) >= 0 && eth ? 1 : 0;
    if (q->found)
        memcpy(q->mac, eth->addr, 6);
    q->done = true;
}
static bool inLwip(tcpip_callback_fn fn, ArpQuery *q)
{
    q->done = false;
    if (tcpip_callback(fn, q) != ERR_OK)
        return false;
    for (int i = 0; i < 200 && !q->done; i++)
        delay(1);
    return q->done;
}

static uint32_t get32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }  // keeps network order
static void put32(uint8_t *p, uint32_t v) { memcpy(p, &v, 4); }

// Finds a DHCP option; returns its data (and length) or nullptr
static const uint8_t *findOption(const uint8_t *msg, size_t len, uint8_t code, uint8_t *optLen)
{
    size_t i = OPT_START;
    while (i < len)
    {
        uint8_t c = msg[i];
        if (c == 255)
            break;
        if (c == 0)
        {
            i++;
            continue;
        }
        if (i + 1 >= len || i + 2 + msg[i + 1] > len)
            break;
        if (c == code)
        {
            *optLen = msg[i + 1];
            return msg + i + 2;
        }
        i += 2 + msg[i + 1];
    }
    return nullptr;
}

void HotspotDhcp::begin(IPAddress serverIp, IPAddress netMask)
{
    // the built-in server holds port 67 and would answer too
    esp_netif_t *ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if (ap)
        esp_netif_dhcps_stop(ap);
    server = (uint32_t)serverIp;
    mask = (uint32_t)netMask;
    leases = rtcLeases.leases;
    uint32_t magicFound = rtcLeases.magic;
    bool kept = rtcLeases.magic == LEASES_MAGIC && rtcLeases.check == leasesChecksum(leases);
    if (!kept)
        memset(leases, 0, sizeof(Lease) * DHCP_POOL_SIZE);
    uint32_t now = millis();
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        // the clock restarted with the timer: acknowledged leases get a full term again,
        // offers that were never taken are dropped
        if (leases[i].used && leases[i].bound)
            leases[i].expiresMs = now + DHCP_LEASE_SECONDS * 1000UL;
        else
            leases[i].used = leases[i].bound = false;
    }
    rtcLeases.magic = LEASES_MAGIC;
    commit();
    int inUse = 0;
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
        inUse += leases[i].used ? 1 : 0;
    event(kept ? EVENT_KEPT : EVENT_CLEARED, nullptr, kept ? inUse : magicFound); // diagnostics
    DEBUG("Hotspot DHCP leases %s\n", kept ? "kept across the restart" : "cleared");
    if (!running)
    {
        running = udp.listen(67);
        udp.onPacket([this](AsyncUDPPacket packet) { handle(packet); });
    }
    if (!running && ap)
        esp_netif_dhcps_start(ap); // never leave the hotspot without any DHCP server
    DEBUG("Hotspot DHCP server %s\n", running ? "started" : "failed, built-in server used");
}

uint32_t HotspotDhcp::addressOf(int lease)
{
    // server .1 -> leases .2, .3, ... (network byte order: the last octet is the top byte)
    uint32_t host = (server >> 24) + 1 + lease;
    return (server & 0x00FFFFFF) | (host << 24);
}

int HotspotDhcp::leaseForAddress(uint32_t ip)
{
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        if (addressOf(i) == ip)
            return i;
    }
    return -1;
}

void HotspotDhcp::commit()
{
    rtcLeases.check = leasesChecksum(leases);
}

// Is another device using this address (a phone that kept its lease across the timer's
// restart or power cycle)? The ARP table knows every device the timer has talked to; a
// silent one is asked twice (an ARP request is a broadcast, which the hotspot can lose).
bool HotspotDhcp::inUseByOther(uint32_t ip, const uint8_t *mac)
{
    esp_netif_t *ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    struct netif *n = ap ? (struct netif *)esp_netif_get_netif_impl(ap) : nullptr;
    if (!n)
        return false;
    ArpQuery q = {};
    q.netif = n;
    q.ip.addr = ip;
    for (int probe = 0; probe < 3; probe++)
    {
        if (inLwip(arpFindCb, &q) && q.found)
            return memcmp(q.mac, mac, 6) != 0;
        if (probe == 2 || !inLwip(arpRequestCb, &q))
            break;
        delay(DHCP_ARP_PROBE_MS);
    }
    return false;
}

int HotspotDhcp::findLease(const uint8_t *mac)
{
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        if (leases[i].used && memcmp(leases[i].mac, mac, 6) == 0)
            return i;
    }
    return -1;
}

// The address derived from the MAC when it is free (so a device gets the same one back after
// a power cycle), else a free one, else an expired one, else the offer that expires first;
// -1 when every address is bound (no offer then: a phone keeps its address until it expires).
// An address another device is found to be using is set aside for ten minutes.
int HotspotDhcp::newLease(const uint8_t *mac)
{
    uint32_t now = millis();
    for (int attempt = 0; attempt < DHCP_POOL_SIZE; attempt++)
    {
        int pick = -1;
        int preferred = (mac[2] + mac[3] + mac[4] + mac[5]) % DHCP_POOL_SIZE;
        if (!leases[preferred].used || (int32_t)(now - leases[preferred].expiresMs) >= 0)
            pick = preferred;
        for (int i = 0; i < DHCP_POOL_SIZE && pick < 0; i++)
        {
            if (!leases[i].used)
                pick = i;
        }
        for (int i = 0; i < DHCP_POOL_SIZE && pick < 0; i++)
        {
            if ((int32_t)(now - leases[i].expiresMs) >= 0)
                pick = i;
        }
        if (pick < 0)
        {
            for (int i = 0; i < DHCP_POOL_SIZE; i++)
            {
                if (!leases[i].bound && (pick < 0 || (int32_t)(leases[i].expiresMs - leases[pick].expiresMs) < 0))
                    pick = i;
            }
        }
        if (pick < 0)
            return -1;
        if (inUseByOther(addressOf(pick), mac))
        {
            event(EVENT_IN_USE, mac, addressOf(pick));
            memset(leases[pick].mac, 0, 6);
            leases[pick].used = true;
            leases[pick].bound = true;
            leases[pick].expiresMs = now + 600000;
            continue;
        }
        leases[pick].used = true;
        leases[pick].bound = false;
        memcpy(leases[pick].mac, mac, 6);
        leases[pick].expiresMs = now + 60000; // an offer is held for a minute; the ACK extends it
        return pick;
    }
    return -1;
}

void HotspotDhcp::handle(AsyncUDPPacket &packet)
{
    const uint8_t *msg = packet.data();
    size_t len = packet.length();
    if (len < OPT_START + 3 || msg[OFF_OP] != 1 || msg[1] != 1 || msg[2] != 6 || memcmp(msg + BOOTP_FIXED, MAGIC, 4) != 0)
        return; // not an Ethernet BOOTREQUEST with DHCP options
    uint8_t n;
    const uint8_t *type = findOption(msg, len, 53, &n);
    if (!type || n != 1)
        return;
    const uint8_t *mac = msg + OFF_CHADDR;
    const uint8_t *serverId = findOption(msg, len, 54, &n);
    if (serverId && n == 4 && get32(serverId) != server)
        return; // talking to another server

    int lease = findLease(mac);
    uint32_t now = millis();
    switch (type[0])
    {
    case DISCOVER:
        if (lease < 0)
            lease = newLease(mac);
        if (lease >= 0)
        {
            reply(msg, OFFER, addressOf(lease));
            event(EVENT_OFFERED, mac, addressOf(lease));
        }
        break;
    case REQUEST:
    {
        // the address it asks for: option 50 (selecting / init-reboot) or ciaddr (renewing)
        uint32_t wanted = get32(msg + OFF_CIADDR);
        const uint8_t *req = findOption(msg, len, 50, &n);
        if (req && n == 4)
            wanted = get32(req);
        int wantedLease = leaseForAddress(wanted);
        bool freeForIt = wantedLease >= 0 && (!leases[wantedLease].used || wantedLease == lease ||
                                              (int32_t)(now - leases[wantedLease].expiresMs) >= 0);
        if (!freeForIt || inUseByOther(wanted, mac))
        {
            // not ours to give (an address from another network, another phone's, or one
            // another device is found using): a NAK makes it start over with a DISCOVER
            // right away instead of timing out
            reply(msg, NAK, 0);
            event(EVENT_REFUSED, mac, wanted);
            break;
        }
        if (lease >= 0 && lease != wantedLease)
        {
            leases[lease].used = false; // it moved to another address
            leases[lease].bound = false;
        }
        leases[wantedLease].used = true;
        leases[wantedLease].bound = true;
        memcpy(leases[wantedLease].mac, mac, 6);
        leases[wantedLease].expiresMs = now + DHCP_LEASE_SECONDS * 1000UL;
        reply(msg, ACK, wanted);
        event(EVENT_ASSIGNED, mac, wanted);
        break;
    }
    case RELEASE:
        if (lease >= 0)
        {
            leases[lease].used = false;
            leases[lease].bound = false;
        }
        break;
    case DECLINE:
        // the address is in use by something else: keep it away from everyone for 10 minutes
        if (lease >= 0)
        {
            memset(leases[lease].mac, 0, 6);
            leases[lease].bound = true;
            leases[lease].expiresMs = now + 600000;
        }
        break;
    case INFORM:
        reply(msg, ACK, 0);
        break;
    }
    commit();
}

// Builds the reply and hands the whole Ethernet frame to the WiFi driver, addressed to the
// phone's MAC (acknowledged and retransmitted, unlike a broadcast frame). The IP destination
// is the broadcast address where RFC 2131 wants it (a NAK, the broadcast bit, no address yet).
void HotspotDhcp::reply(const uint8_t *request, uint8_t type, uint32_t yiaddr)
{
    static uint8_t frame[14 + 20 + 8 + 312];
    uint8_t *dhcp = frame + 14 + 20 + 8;
    memset(frame, 0, sizeof(frame));

    dhcp[OFF_OP] = 2; // BOOTREPLY
    dhcp[1] = 1;
    dhcp[2] = 6;
    memcpy(dhcp + OFF_XID, request + OFF_XID, 4);
    memcpy(dhcp + OFF_FLAGS, request + OFF_FLAGS, 2);
    if (type == ACK && yiaddr == 0)
        memcpy(dhcp + OFF_CIADDR, request + OFF_CIADDR, 4); // INFORM
    put32(dhcp + OFF_YIADDR, yiaddr);
    memcpy(dhcp + OFF_GIADDR, request + OFF_GIADDR, 4);
    memcpy(dhcp + OFF_CHADDR, request + OFF_CHADDR, 16);
    memcpy(dhcp + BOOTP_FIXED, MAGIC, 4);

    uint8_t *o = dhcp + OPT_START;
    auto opt4 = [&](uint8_t code, uint32_t value) {
        *o++ = code;
        *o++ = 4;
        put32(o, value);
        o += 4;
    };
    auto optSeconds = [&](uint8_t code, uint32_t seconds) {
        *o++ = code;
        *o++ = 4;
        *o++ = seconds >> 24;
        *o++ = seconds >> 16;
        *o++ = seconds >> 8;
        *o++ = seconds;
    };
    *o++ = 53;
    *o++ = 1;
    *o++ = type;
    opt4(54, server);
    if (type != NAK)
    {
        if (yiaddr)
        {
            optSeconds(51, DHCP_LEASE_SECONDS);
            optSeconds(58, DHCP_LEASE_SECONDS / 2);
            optSeconds(59, DHCP_LEASE_SECONDS * 7 / 8);
        }
        opt4(1, mask);
        opt4(3, server); // router and DNS: the timer, as with the built-in server
        opt4(6, server);
        opt4(28, (server & mask) | ~mask);
    }
    *o++ = 255;
    size_t dhcpLen = o - dhcp;
    if (dhcpLen < 300)
        dhcpLen = 300; // BOOTP minimum; the rest is already zero

    bool broadcast = type == NAK || (request[OFF_FLAGS] & BROADCAST_FLAG) || yiaddr == 0;
    uint32_t dstIp = broadcast ? 0xFFFFFFFF : yiaddr;
    uint8_t apMac[6];
    WiFi.softAPmacAddress(apMac);

    // Ethernet
    memcpy(frame, request + OFF_CHADDR, 6);
    memcpy(frame + 6, apMac, 6);
    frame[12] = 0x08;
    frame[13] = 0x00;

    // IPv4
    static uint16_t ipId = 0;
    uint8_t *ip = frame + 14;
    uint16_t ipLen = 20 + 8 + dhcpLen;
    ip[0] = 0x45;
    ip[2] = ipLen >> 8;
    ip[3] = ipLen;
    ip[4] = (++ipId) >> 8;
    ip[5] = ipId;
    ip[8] = 64;
    ip[9] = 17; // UDP
    put32(ip + 12, server);
    put32(ip + 16, dstIp);
    uint32_t sum = 0;
    for (int i = 0; i < 20; i += 2)
        sum += (ip[i] << 8) | ip[i + 1];
    while (sum >> 16)
        sum = (sum & 0xFFFF) + (sum >> 16);
    uint16_t check = ~sum;
    ip[10] = check >> 8;
    ip[11] = check;

    // UDP (checksum 0 = none, allowed in IPv4)
    uint8_t *udpHdr = ip + 20;
    uint16_t udpLen = 8 + dhcpLen;
    udpHdr[1] = 67;
    udpHdr[3] = 68;
    udpHdr[4] = udpLen >> 8;
    udpHdr[5] = udpLen;

    int err = esp_wifi_internal_tx(WIFI_IF_AP, frame, 14 + ipLen);
    if (err != 0)
        event(EVENT_TX_FAILED, request + OFF_CHADDR, (uint32_t)err);
    if (request[OFF_FLAGS] & BROADCAST_FLAG)
    {
        // it asked for broadcast replies (Windows does): a copy to every station as well, in
        // case it ignores a frame to its own MAC before it has an address. The frame above is
        // the one the driver acknowledges and retransmits; a duplicate is ignored (same xid).
        memset(frame, 0xFF, 6);
        esp_wifi_internal_tx(WIFI_IF_AP, frame, 14 + ipLen);
    }
}
