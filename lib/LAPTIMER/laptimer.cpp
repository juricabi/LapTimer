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

    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        pilots[i].filter.setMeasurementNoise(rssi_filter_q * 0.01f);
        pilots[i].filter.setProcessNoise(rssi_filter_r * 0.0001f);
        memset(pilots[i].history, 0, sizeof(pilots[i].history));
        pilots[i].rssi = 0;
        resetPilot(pilots[i]);
    }
    state = RACE_IDLE;
    DEBUG("LapTimer stopped\n");
}

void LapTimer::resetPilot(PilotState &p)
{
    p.inPass = false;
    p.hoverBlocked = false;
    p.peak = 0;
    p.hasPassed = false;
    p.lastPassMs = 0;
    p.lapCount = 0;
    p.finished = false;
    memset(p.laps, 0, sizeof(p.laps));
}

bool LapTimer::hasRaceData()
{
    for (uint8_t i = 0; i < pilotCount; i++)
    {
        if (pilots[i].lapCount > 0)
            return true;
    }
    return false;
}

// Race settings are taken from the config when the race is armed
void LapTimer::start(uint32_t epochSec)
{
    if (state == RACE_COUNTDOWN || state == RACE_WAITING || state == RACE_RUNNING)
    {
        return;
    }
    if (savePending)
    {
        return; // previous race still being saved; the page retries
    }
    DEBUG("LapTimer started\n");
    pilotCount = conf->getPilotCount();
    mode = conf->getRaceMode();
    countdown = conf->getCountdown();
    raceMs = conf->getRaceMs();
    raceLaps = conf->getRaceLaps();
    startEpochSec = epochSec;
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        raceFreq[i] = conf->getFrequency(i);
        resetPilot(pilots[i]);
    }
    timeUp = false;
    raceId++;

    uint32_t now = millis();
    if (countdown)
    {
        raceStartMs = now + COUNTDOWN_MS;
        countdownBeeps = 0;
        state = RACE_COUNTDOWN;
    }
    else
    {
        raceStartMs = 0;
        state = RACE_WAITING;
        buz->beep(500);
        led->on(500);
    }
}

void LapTimer::stop()
{
    if (state == RACE_IDLE)
    {
        return;
    }
    DEBUG("LapTimer stopped\n");
    bool wasFinished = state == RACE_FINISHED;
    state = RACE_IDLE;
    if (!wasFinished && hasRaceData())
    {
        savePending = true; // finished races were already queued for saving
    }
    buz->beep(500);
    led->on(500);
}

void LapTimer::clear()
{
    if (isRacing() || savePending)
    {
        return; // never clear laps that are still being saved
    }
    state = RACE_IDLE;
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        resetPilot(pilots[i]);
    }
}

int32_t LapTimer::getElapsedMs(uint32_t nowMs)
{
    switch (state)
    {
    case RACE_COUNTDOWN:
        return (int32_t)(nowMs - raceStartMs); // negative until GO
    case RACE_RUNNING:
        return (int32_t)(nowMs - raceStartMs);
    default:
        return 0;
    }
}

bool LapTimer::requestStart(uint32_t epochSec)
{
    if (isRacing() || savePending || pendingCommand != CMD_NONE)
    {
        return false;
    }
    pendingEpoch = epochSec;
    pendingCommand = CMD_START;
    return true;
}

void LapTimer::requestStop()
{
    pendingCommand = CMD_STOP;
}

bool LapTimer::requestClear()
{
    if (isRacing() || savePending)
    {
        return false;
    }
    pendingCommand = CMD_CLEAR;
    return true;
}

// Runs a queued command on the timing core, so race data is only changed here
void LapTimer::runPendingCommand()
{
    uint8_t command = pendingCommand;
    if (command == CMD_NONE)
    {
        return;
    }
    pendingCommand = CMD_NONE;
    switch (command)
    {
    case CMD_START:
        start(pendingEpoch);
        break;
    case CMD_STOP:
        stop();
        break;
    case CMD_CLEAR:
        clear();
        break;
    }
}

void LapTimer::update(uint32_t nowMs)
{
    runPendingCommand();
    scan(nowMs);
    recordHistory(nowMs);
    updateRace(nowMs);
}

// Chooses which pilot's frequency the RX5808 listens to and feeds it the samples
void LapTimer::scan(uint32_t nowMs)
{
    // During a race use the race's pilots and frequencies, otherwise the live settings
    bool racing = state != RACE_IDLE;
    uint8_t count = racing ? pilotCount : conf->getPilotCount();

    if (count == 1)
    {
        activePilot = 0;
        uint16_t freq = racing ? raceFreq[0] : conf->getFrequency(0);
        if (rx->getFrequency() != freq)
        {
            rx->setFrequency(freq);
            settleUntilMs = nowMs + SINGLE_SETTLE_MS;
        }
    }
    else if ((int32_t)(nowMs - slotEndMs) >= 0)
    {
        // next pilot's slot (pilots without a channel are skipped)
        activePilot = nextActivePilot(activePilot, count, racing);
        uint16_t freq = racing ? raceFreq[activePilot] : conf->getFrequency(activePilot);
        if (rx->getFrequency() != freq)
        {
            rx->setFrequency(freq, false);
        }
        settleUntilMs = nowMs + HOP_SETTLE_MS;
        slotEndMs = settleUntilMs + HOP_DWELL_MS;
    }

    if (rx->getFrequency() == POWER_DOWN_FREQ_MHZ || (int32_t)(nowMs - settleUntilMs) < 0)
    {
        return; // receiver off or still settling
    }
    sample(activePilot, rx->readRssiRaw(), nowMs);
}

uint8_t LapTimer::nextActivePilot(uint8_t from, uint8_t count, bool racing)
{
    for (uint8_t step = 1; step <= count; step++)
    {
        uint8_t candidate = (from + step) % count;
        uint16_t freq = racing ? raceFreq[candidate] : conf->getFrequency(candidate);
        if (freq != POWER_DOWN_FREQ_MHZ)
            return candidate;
    }
    return (from + 1) % count; // all off: scan() sees the power-down frequency and skips sampling
}

void LapTimer::sample(uint8_t pilot, uint8_t raw, uint32_t nowMs)
{
    PilotState &p = pilots[pilot];
    uint8_t v = round(p.filter.filter(raw, 0));
    p.rssi = v;
    if (!p.stepHasSample || v > p.stepMax)
    {
        p.stepMax = v;
        p.stepHasSample = true;
    }

    bool racing = state != RACE_IDLE;
    uint8_t count = racing ? pilotCount : conf->getPilotCount();
    uint8_t enter = conf->getEnterRssi(pilot);
    uint8_t exit = conf->getExitRssi(pilot);

    // After hovering at the gate, wait until the drone has left before detecting again
    if (p.hoverBlocked)
    {
        if (v < exit)
            p.hoverBlocked = false;
        return;
    }

    // With several pilots, only count this channel while it clearly beats all the
    // others (a close drone can bleed into the other channels)
    bool dominant = true;
    for (uint8_t other = 0; other < count; other++)
    {
        uint16_t otherFreq = racing ? raceFreq[other] : conf->getFrequency(other);
        if (otherFreq == POWER_DOWN_FREQ_MHZ)
            continue; // not scanned, its RSSI is stale
        if (other != pilot && v < pilots[other].rssi + DOMINANCE_DELTA)
        {
            dominant = false;
            break;
        }
    }

    if (v >= enter && dominant)
    {
        if (!p.inPass)
        {
            p.inPass = true;
            p.passStartMs = nowMs;
            p.peak = v;
            p.peakFirstMs = p.peakLastMs = nowMs;
        }
        else if (v > p.peak)
        {
            p.peak = v;
            p.peakFirstMs = p.peakLastMs = nowMs;
        }
        else if (v + PEAK_TOLERANCE >= p.peak)
        {
            p.peakLastMs = nowMs; // still at the peak (plateau)
        }
    }

    if (p.inPass && (nowMs - p.passStartMs) > MAX_PASS_MS)
    {
        p.inPass = false; // hovering near the gate, not a pass
        p.hoverBlocked = true;
        return;
    }

    if (p.inPass && v < exit)
    {
        // Pass time = middle of the time spent at the peak, which is more
        // accurate than the first peak sample when the signal plateaus
        p.inPass = false;
        uint32_t passMs = p.peakFirstMs + (p.peakLastMs - p.peakFirstMs) / 2;
        onPass(pilot, passMs);
    }
}

void LapTimer::onPass(uint8_t pilot, uint32_t passMs)
{
    PilotState &p = pilots[pilot];

    if (state != RACE_WAITING && state != RACE_RUNNING)
    {
        return; // no race, countdown not finished, or race finished
    }
    if (p.finished)
    {
        return;
    }
    if (p.hasPassed && (passMs - p.lastPassMs) < conf->getMinLapMs())
    {
        return; // too soon after the previous pass
    }

    if (state == RACE_WAITING)
    {
        // Without countdown the race starts on the first pass of any pilot
        raceStartMs = passMs;
        state = RACE_RUNNING;
    }

    if (p.lapCount >= MAX_LAPS)
    {
        return;
    }

    // Write the time before publishing the new count, so readers on
    // another core never see a count without its time
    int index = p.lapCount;
    if (!p.hasPassed)
    {
        // Start pass, relative to the race start. It can be slightly before the start
        // (drone on the gate during the countdown, or two pilots passing together), so clamp at 0.
        int32_t sinceStart = (int32_t)(passMs - raceStartMs);
        p.laps[index] = sinceStart > 0 ? sinceStart : 0;
        p.hasPassed = true;
    }
    else
    {
        p.laps[index] = passMs - p.lastPassMs;
    }
    p.lastPassMs = passMs;
    p.lapCount = index + 1;
    DEBUG("Pilot %u pass %d: %u ms\n", pilot + 1, index, p.laps[index]);

    int completedLaps = p.lapCount - 1;
    if ((mode == RACE_LAPS && completedLaps >= raceLaps) ||
        (mode == RACE_TIMED && timeUp && completedLaps >= 1))
    {
        p.finished = true;
        buz->beep(700);
        led->on(700);
    }
    else
    {
        buz->beep(200);
        led->on(200);
    }
}

void LapTimer::updateRace(uint32_t nowMs)
{
    if (state == RACE_COUNTDOWN)
    {
        // short beeps at 3, 2, 1, long beep at GO
        int32_t toGo = (int32_t)(raceStartMs - nowMs);
        if (countdownBeeps < 3 && toGo <= (int32_t)(COUNTDOWN_MS - countdownBeeps * 1000))
        {
            countdownBeeps++;
            buz->beep(120);
            led->on(120);
        }
        if (toGo <= 0)
        {
            state = RACE_RUNNING;
            buz->beep(600);
            led->on(600);
        }
        return;
    }

    if (state != RACE_RUNNING)
    {
        return;
    }

    if (mode == RACE_TIMED && !timeUp && (nowMs - raceStartMs) >= raceMs)
    {
        timeUp = true; // each pilot finishes on their next pass
        buz->beep(800);
        led->on(800);
    }

    if (mode != RACE_PRACTICE)
    {
        bool allFinished = true;
        for (uint8_t i = 0; i < pilotCount; i++)
        {
            allFinished &= pilots[i].finished;
        }
        if (allFinished)
        {
            DEBUG("Race finished\n");
            state = RACE_FINISHED;
            savePending = true;
            buz->beep(1200);
            led->on(1200);
        }
    }
}

// Keeps the highest RSSI per RSSI_HISTORY_STEP_MS for the calibration graph
void LapTimer::recordHistory(uint32_t nowMs)
{
    if ((nowMs - historyStepMs) < RSSI_HISTORY_STEP_MS)
    {
        return;
    }
    historyStepMs = nowMs;
    uint32_t seq = historySeq + 1;
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        PilotState &p = pilots[i];
        p.history[seq % RSSI_HISTORY] = p.stepHasSample ? p.stepMax : p.rssi;
        p.stepHasSample = false;
    }
    historySeq = seq;
}
