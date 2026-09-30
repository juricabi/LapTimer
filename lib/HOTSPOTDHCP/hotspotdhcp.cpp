#include "hotspotdhcp.h"

#include <WiFi.h>
#include <esp_netif.h>
#include <esp_private/wifi.h>

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
    memset(leases, 0, sizeof(leases));
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

int HotspotDhcp::findLease(const uint8_t *mac)
{
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        if (leases[i].used && memcmp(leases[i].mac, mac, 6) == 0)
            return i;
    }
    return -1;
}

// A free address, else an expired one, else the one that expires first
int HotspotDhcp::newLease(const uint8_t *mac)
{
    uint32_t now = millis();
    int pick = -1;
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
        pick = 0;
        for (int i = 1; i < DHCP_POOL_SIZE; i++)
        {
            if ((int32_t)(leases[i].expiresMs - leases[pick].expiresMs) < 0)
                pick = i;
        }
    }
    leases[pick].used = true;
    memcpy(leases[pick].mac, mac, 6);
    leases[pick].expiresMs = now + 60000; // an offer is held for a minute; the ACK extends it
    return pick;
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
        reply(msg, OFFER, addressOf(lease));
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
        if (!freeForIt)
        {
            // not ours to give (an address from another network, or another phone's):
            // a NAK makes it start over with a DISCOVER right away instead of timing out
            reply(msg, NAK, 0);
            return;
        }
        if (lease >= 0 && lease != wantedLease)
            leases[lease].used = false; // it moved to another address
        leases[wantedLease].used = true;
        memcpy(leases[wantedLease].mac, mac, 6);
        leases[wantedLease].expiresMs = now + DHCP_LEASE_SECONDS * 1000UL;
        reply(msg, ACK, wanted);
        if (onAssigned)
            onAssigned(mac, wanted);
        break;
    }
    case RELEASE:
        if (lease >= 0)
            leases[lease].used = false;
        break;
    case DECLINE:
        // the address is in use by something else: keep it away from everyone for 10 minutes
        if (lease >= 0)
        {
            memset(leases[lease].mac, 0, 6);
            leases[lease].expiresMs = now + 600000;
        }
        break;
    case INFORM:
        reply(msg, ACK, 0);
        break;
    }
}

// Builds the reply and hands the whole Ethernet frame to the WiFi driver: unicast to the
// phone's MAC unless it asked for broadcast (or a NAK, which RFC 2131 broadcasts)
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
    if (broadcast)
        memset(frame, 0xFF, 6);
    else
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

    esp_wifi_internal_tx(WIFI_IF_AP, frame, 14 + ipLen);
}
