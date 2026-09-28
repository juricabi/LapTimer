#include "laptimer.h"

#include "debug.h"

const uint16_t rssi_filter_q = 2000; //  0.01 - 655.36
const uint16_t rssi_filter_r = 40;   // 0.0001 - 65.536

void LapTimer::init(Config *config, RX5808 *rx5808, Buzzer *buzzer, Led *l)
{
    conf = config;
    rx = rx5808;
    buz = buzzer;
    led = l;

    filter.setMeasurementNoise(rssi_filter_q * 0.01f);
    filter.setProcessNoise(rssi_filter_r * 0.0001f);

    stop();
    memset(rssi, 0, sizeof(rssi));
}

// Arms the timer: the race (lap 0) starts on the first gate pass, detected in WAITING state
void LapTimer::start()
{
    DEBUG("LapTimer started\n");
    lapCount = -1;
    memset(lapTimes, 0, sizeof(lapTimes));
    lapPeakReset();
    state = WAITING;
    buz->beep(500);
    led->on(500);
}

void LapTimer::stop()
{
    DEBUG("LapTimer stopped\n");
    state = STOPPED;
    lapCount = -1;
    lapPeakReset();
    rssiCount = 0;
    memset(lapTimes, 0, sizeof(lapTimes));
    buz->beep(500);
    led->on(500);
}

int LapTimer::getLapNumber()
{
    return lapCount;
}

void LapTimer::handleLapTimerUpdate(uint32_t currentTimeMs)
{
    // always read RSSI
    rssi[rssiCount] = round(filter.filter(rx->readRssi(), 0));
    // DEBUG("RSSI: %u\n", rssi[rssiCount]);

    switch (state)
    {
    case STOPPED:
        break;
    case WAITING:
        // detect hole shot
        lapPeakCapture();
        if (lapPeakCaptured())
        {
            startLap();
            lapCount = 0; // race start
            lapAvailable = true;
            state = RUNNING;
        }
        break;
    case RUNNING:
        // Check if timer min has elapsed, start capturing peak
        if ((currentTimeMs - startTimeMs) > conf->getMinLapMs())
        {
            lapPeakCapture();
        }

        if (lapPeakCaptured())
        {
            finishLap();
            startLap();
        }
        break;
    default:
        break;
    }

    rssiCount = (rssiCount + 1) % LAPTIMER_RSSI_HISTORY;
}

void LapTimer::lapPeakCapture()
{
    // Check if RSSI is on or post threshold, update RSSI peak
    if (rssi[rssiCount] >= conf->getEnterRssi())
    {
        // Check if RSSI is greater than the previous detected peak
        if (rssi[rssiCount] > rssiPeak)
        {
            rssiPeak = rssi[rssiCount];
            rssiPeakTimeMs = millis();
        }
    }
}

bool LapTimer::lapPeakCaptured()
{
    return (rssi[rssiCount] < rssiPeak) && (rssi[rssiCount] < conf->getExitRssi());
}

void LapTimer::lapPeakReset()
{
    rssiPeak = 0;
    rssiPeakTimeMs = 0;
}

void LapTimer::startLap()
{
    DEBUG("Lap started\n");
    startTimeMs = rssiPeakTimeMs;
    lapPeakReset();
    buz->beep(200);
    led->on(200);
}

// Lap N (N >= 1) is stored at index (N - 1) % LAPTIMER_LAP_HISTORY.
// The time is written before lapCount is incremented, so a reader that
// sees the new lapCount also sees its time.
void LapTimer::finishLap()
{
    lapTimes[lapCount % LAPTIMER_LAP_HISTORY] = rssiPeakTimeMs - startTimeMs;
    DEBUG("Lap finished, lap time = %u\n", lapTimes[lapCount % LAPTIMER_LAP_HISTORY]);
    lapCount++;
    lapAvailable = true;
}

uint8_t LapTimer::getRssi()
{
    return rssi[rssiCount];
}

uint32_t LapTimer::getLapTime()
{
    int lapNumber;
    uint32_t lapTime;
    getLatestLap(&lapNumber, &lapTime);
    return lapTime;
}

void LapTimer::getLatestLap(int *lapNumber, uint32_t *lapTimeMs)
{
    int n = lapCount;
    lapAvailable = false;
    *lapNumber = n;
    *lapTimeMs = (n > 0) ? lapTimes[(n - 1) % LAPTIMER_LAP_HISTORY] : 0;
}

bool LapTimer::isLapAvailable()
{
    return lapAvailable;
}
