#include "hotspotdhcp.h"

#include <WiFi.h>
#include <esp_attr.h>
#include <esp_netif.h>
#include <esp_netif_net_stack.h>
#include <esp_private/wifi.h>
#include <lwip/etharp.h>
#include <lwip/tcpip.h>
#include <new>

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
    uint32_t savedAtMs; // millis() at the last change: the lease times count from the old clock
    uint32_t check;
};
static RTC_NOINIT_ATTR RtcLeases rtcLeases;

static uint32_t leasesChecksum(const HotspotDhcp::Lease *leases, uint32_t savedAtMs)
{
    uint32_t sum = 0x5A5A ^ savedAtMs;
    const uint8_t *b = (const uint8_t *)leases;
    for (size_t i = 0; i < sizeof(HotspotDhcp::Lease) * DHCP_POOL_SIZE; i++)
        sum = sum * 31 + b[i];
    return sum;
}

// ARP table lookups and requests run in lwIP's own thread. One query at a time (the UDP task
// is the only caller); a callback that runs after its query was given up on (lwIP stalled)
// is told apart by its generation number and ignored, so it never writes into a dead query.
struct ArpQuery
{
    struct netif *netif;
    ip4_addr_t ip;
    uint8_t mac[6];
    volatile int found;
    volatile bool done;
    volatile uint32_t gen;
};
static ArpQuery arpQuery;
struct ArpPost
{
    uint32_t gen;
    bool request;
};
static void arpCb(void *arg)
{
    ArpPost *post = (ArpPost *)arg;
    ArpQuery *q = &arpQuery;
    if (post->gen == q->gen)
    {
        if (post->request)
            etharp_request(q->netif, &q->ip);
        else
        {
            struct eth_addr *eth = nullptr;
            const ip4_addr_t *ipr = nullptr;
            q->found = etharp_find_addr(q->netif, &q->ip, &eth, &ipr) >= 0 && eth ? 1 : 0;
            if (q->found)
                memcpy(q->mac, eth->addr, 6);
        }
        q->done = true;
    }
    delete post;
}
static bool inLwip(bool request)
{
    ArpQuery *q = &arpQuery;
    ArpPost *post = new (std::nothrow) ArpPost{++q->gen, request};
    if (!post)
        return false;
    q->done = false;
    // try, don't wait: lwIP's thread can itself be waiting for AsyncUDP's queue, which this
    // task empties (a DHCP flood would lock both). A full queue counts as no answer.
    if (tcpip_try_callback(arpCb, post) != ERR_OK)
    {
        delete post;
        return false;
    }
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
    if (running)
        return; // already serving this hotspot (the AP branch ran again): only the built-in server, started again by softAPConfig(), is stopped
    server = (uint32_t)serverIp;
    mask = (uint32_t)netMask;
    leases = rtcLeases.leases;
    uint32_t magicFound = rtcLeases.magic;
    bool kept = rtcLeases.magic == LEASES_MAGIC && rtcLeases.check == leasesChecksum(leases, rtcLeases.savedAtMs);
    if (!kept)
        memset(leases, 0, sizeof(Lease) * DHCP_POOL_SIZE);
    uint32_t now = millis();
    static const uint8_t noMac[6] = {0, 0, 0, 0, 0, 0};
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        // the clock restarted with the timer: acknowledged leases keep the time they had left
        // when the table was last saved (the time between that and the restart is unknown:
        // a lease lasts a little longer, never shorter); expired ones, offers that were never
        // taken, and addresses set aside as in use by an unknown device (no MAC) are dropped:
        // the ARP probe finds such a device again
        int32_t left = (int32_t)(leases[i].expiresMs - rtcLeases.savedAtMs);
        if (leases[i].used && leases[i].bound && memcmp(leases[i].mac, noMac, 6) != 0 && left > 0)
            leases[i].expiresMs = now + (uint32_t)left;
        else
        {
            leases[i].used = leases[i].bound = false;
            memset(leases[i].mac, 0, 6);
        }
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

// Saves the table's checksum: called right after every change, so a restart in the middle of
// a packet (an update, a crash) keeps what was decided so far
void HotspotDhcp::commit()
{
    rtcLeases.savedAtMs = millis();
    rtcLeases.check = leasesChecksum(leases, rtcLeases.savedAtMs);
}

// Keeps an address away from everyone for ten minutes: another device was found using it
void HotspotDhcp::setAside(int lease, uint32_t now)
{
    memset(leases[lease].mac, 0, 6);
    leases[lease].used = true;
    leases[lease].bound = true;
    leases[lease].expiresMs = now + 600000;
    commit();
}

// Is another device using this address (a phone that kept its lease across the timer's
// restart or power cycle)? The ARP table knows every device the timer has talked to; a
// silent one is asked twice (an ARP request is a broadcast, which the hotspot can lose).
bool HotspotDhcp::inUseByOther(uint32_t ip, const uint8_t *mac, const uint8_t *radioMac)
{
    esp_netif_t *ap = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    struct netif *n = ap ? (struct netif *)esp_netif_get_netif_impl(ap) : nullptr;
    if (!n)
        return false;
    arpQuery.netif = n;
    arpQuery.ip.addr = ip;
    for (int probe = 0; probe < 3; probe++)
    {
        if (inLwip(false) && arpQuery.found)
            return memcmp(arpQuery.mac, mac, 6) != 0 && (!radioMac || memcmp(arpQuery.mac, radioMac, 6) != 0);
        if (probe == 2 || !inLwip(true))
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
int HotspotDhcp::newLease(const uint8_t *mac, const uint8_t *radioMac)
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
        if (inUseByOther(addressOf(pick), mac, radioMac))
        {
            event(EVENT_IN_USE, mac, addressOf(pick));
            setAside(pick, now);
            continue;
        }
        leases[pick].used = true;
        leases[pick].bound = false;
        memcpy(leases[pick].mac, mac, 6);
        leases[pick].expiresMs = now + 60000; // an offer is held for a minute; the ACK extends it
        commit();
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
    static const uint8_t noMac[6] = {0, 0, 0, 0, 0, 0};
    if (packet.interface() != TCPIP_ADAPTER_IF_AP || memcmp(mac, noMac, 6) == 0)
        return; // a home network's DHCP (the station side), or no client MAC (set-aside entries have none)
    const uint8_t *serverId = findOption(msg, len, 54, &n);
    if (serverId && n == 4 && get32(serverId) != server)
        return; // talking to another server
    // the reply goes to the frame's source (the client's radio; chaddr can be a device behind it)
    uint8_t srcMac[6];
    packet.remoteMac(srcMac);
    const uint8_t *dstMac = memcmp(srcMac, noMac, 6) != 0 ? srcMac : mac;

    uint32_t now = millis();
    // expired leases are cleared, not just treated as free: the clock wraps after 49 days,
    // and an expired lease left in place would look valid again 24.8 days after it expired
    bool swept = false;
    for (int i = 0; i < DHCP_POOL_SIZE; i++)
    {
        if (leases[i].used && (int32_t)(now - leases[i].expiresMs) >= 0)
        {
            leases[i].used = leases[i].bound = false;
            memset(leases[i].mac, 0, 6);
            swept = true;
        }
    }
    if (swept)
        commit();
    int lease = findLease(mac);
    switch (type[0])
    {
    case DISCOVER:
        if (lease >= 0 && inUseByOther(addressOf(lease), mac, dstMac))
        {
            // its remembered address was taken meanwhile (a device on a fixed address):
            // set aside, and a new one below (offering it again would loop offer / refuse)
            event(EVENT_IN_USE, mac, addressOf(lease));
            setAside(lease, now);
            lease = -1;
        }
        if (lease < 0)
            lease = newLease(mac, dstMac);
        if (lease >= 0)
        {
            reply(msg, OFFER, addressOf(lease), dstMac);
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
        bool taken = freeForIt && inUseByOther(wanted, mac, dstMac);
        if (!freeForIt || taken)
        {
            // not ours to give (an address from another network, another phone's, or one
            // another device is found using): a NAK makes it start over with a DISCOVER
            // right away instead of timing out. A taken address is set aside, also when it
            // was this client's own remembered one, so its DISCOVER gets a new address.
            if (taken)
            {
                event(EVENT_IN_USE, mac, wanted);
                setAside(wantedLease, now);
            }
            reply(msg, NAK, 0, dstMac);
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
        commit(); // saved before the phone is told
        reply(msg, ACK, wanted, dstMac);
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
            setAside(lease, now);
        break;
    case INFORM:
        reply(msg, ACK, 0, dstMac);
        break;
    }
    commit();
}

// Builds the reply and hands the whole Ethernet frame to the WiFi driver, addressed to the
// phone's MAC (acknowledged and retransmitted, unlike a broadcast frame). The IP destination
// is the broadcast address where RFC 2131 wants it (a NAK, the broadcast bit, no address yet).
void HotspotDhcp::reply(const uint8_t *request, uint8_t type, uint32_t yiaddr, const uint8_t *dstMac)
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

    uint32_t ciaddr = get32(request + OFF_CIADDR);
    bool broadcast = type == NAK || (request[OFF_FLAGS] & BROADCAST_FLAG) || (yiaddr == 0 && ciaddr == 0);
    uint32_t dstIp = broadcast ? 0xFFFFFFFF : (yiaddr ? yiaddr : ciaddr); // INFORM: to the address it has
    uint8_t apMac[6];
    WiFi.softAPmacAddress(apMac);

    // Ethernet
    memcpy(frame, dstMac, 6);
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
    auto setDestination = [&](uint32_t dst) {
        put32(ip + 16, dst);
        ip[10] = ip[11] = 0;
        uint32_t sum = 0;
        for (int i = 0; i < 20; i += 2)
            sum += (ip[i] << 8) | ip[i + 1];
        while (sum >> 16)
            sum = (sum & 0xFFFF) + (sum >> 16);
        uint16_t check = ~sum;
        ip[10] = check >> 8;
        ip[11] = check;
    };
    setDestination(dstIp);

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
    if (err != 0 || (request[OFF_FLAGS] & BROADCAST_FLAG))
    {
        // A copy to every station as well: when it asked for broadcast replies (Windows does)
        // in case it ignores a frame to its own MAC before it has an address, and when the
        // driver refused the frame (a station it doesn't count as associated yet). The frame
        // above is the one the driver acknowledges and retransmits; a duplicate is ignored
        // (same xid). An unconfigured client only takes an IP broadcast.
        if (!broadcast)
            setDestination(0xFFFFFFFF);
        memset(frame, 0xFF, 6);
        esp_wifi_internal_tx(WIFI_IF_AP, frame, 14 + ipLen);
    }
}
