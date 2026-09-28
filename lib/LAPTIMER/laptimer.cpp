#include "laptimer.h"

#include "debug.h"

bool applyLapEdit(uint32_t *laps, int &count, int maxCount, uint8_t op, int index)
{
    if (index < 0 || index >= count)
        return false;
    if (op == LAP_EDIT_MERGE)
    {
        if (index == count - 1)
        {
            count--; // false last pass: drop it
            return true;
        }
        laps[index] += laps[index + 1]; // join with the next lap
        for (int i = index + 1; i + 1 < count; i++)
            laps[i] = laps[i + 1];
        count--;
        return true;
    }
    if (op == LAP_EDIT_SPLIT)
    {
        if (index == 0 || count >= maxCount)
            return false; // the start pass is not a lap
        uint32_t first = laps[index] / 2;
        for (int i = count; i > index + 1; i--)
            laps[i] = laps[i - 1];
        laps[index + 1] = laps[index] - first;
        laps[index] = first;
        count++;
        return true;
    }
    return false;
}

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
    memset(raceNames, 0, sizeof(raceNames));
    state = RACE_IDLE;
    DEBUG("LapTimer stopped\n");
}

void LapTimer::raceToJson(JsonObject out)
{
    out["race"] = raceId;
    out["state"] = state;
    out["mode"] = mode;
    out["cd"] = countdown;
    out["stag"] = staggered;
    out["raceMs"] = raceMs;
    out["raceLaps"] = raceLaps;
    out["date"] = startEpochSec;
    out["edits"] = editCount;
    JsonArray list = out["pilots"].to<JsonArray>();
    for (uint8_t i = 0; i < pilotCount; i++)
    {
        JsonObject p = list.add<JsonObject>();
        p["name"] = raceNames[i];
        p["freq"] = raceFreq[i];
        p["fin"] = pilots[i].finished;
        if (pilots[i].full)
            p["full"] = true;
        JsonArray laps = p["laps"].to<JsonArray>();
        int count = pilots[i].lapCount; // read once: laps below this index are complete
        for (int l = 0; l < count; l++)
            laps.add(pilots[i].laps[l]);
    }
}

void LapTimer::resetPilot(PilotState &p)
{
    p.inPass = false;
    p.hoverBlocked = false;
    p.belowExit = 0;
    p.peak = 0;
    p.hasPassed = false;
    p.timeUpBeeped = false;
    p.lastPassMs = 0;
    p.lapCount = 0;
    p.finished = false;
    p.full = false;
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
    staggered = conf->getStaggered();
    raceMs = conf->getRaceMs();
    raceLaps = conf->getRaceLaps();
    raceMinLapMs = conf->getMinLapMs();
    startEpochSec = epochSec;
    editCount = 0;
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
        strlcpy(raceNames[i], conf->getPilotName(i), sizeof(raceNames[i]));
    // A race always wins over a channel scan: stop it so the receiver listens to the pilots
    spectrumRequested = false;
    spectrumActive = false;
    spectrumTuned = false;
    for (uint8_t i = 0; i < MAX_PILOTS; i++)
    {
        raceFreq[i] = conf->getFrequency(i);
        raceEnter[i] = conf->getEnterRssi(i);
        raceExit[i] = conf->getExitRssi(i);
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

bool LapTimer::requestEdit(uint8_t pilot, uint8_t op, int index)
{
    if (editPending)
        return false;
    editPilot = pilot;
    editOp = op;
    editIndex = index;
    editPending = true;
    return true;
}

void LapTimer::runPendingEdit()
{
    if (!editPending)
        return;
    if (!isRacing() && !savePending && editPilot < pilotCount)
    {
        PilotState &p = pilots[editPilot];
        int count = p.lapCount;
        if (applyLapEdit(p.laps, count, MAX_LAPS, editOp, editIndex))
        {
            p.lapCount = count;
            editCount++;
        }
    }
    editPending = false;
}

bool LapTimer::requestStepTest(uint16_t fromMhz, uint16_t toMhz, uint16_t hops)
{
    if (isRacing() || isSpectrumRunning() || stepTestRequested || pendingCommand == CMD_START)
        return false;
    stepTestFrom = fromMhz;
    stepTestTo = toMhz;
    stepTestHops = hops < STEP_TEST_SAMPLES ? hops : STEP_TEST_SAMPLES;
    stepTestDone = false;
    stepTestRequested = true;
    return true;
}

// Lock time of many switches: 50 ms on `from`, then `to` sampled every 0.5 ms for 100 ms.
// Locked = the first of 4 readings in a row above the middle between start and final level.
void LapTimer::runLockTest()
{
    static uint8_t trace[200];
    for (uint16_t k = 0; k < stepTestHops; k++)
    {
        rx->setFrequency(stepTestFrom, false);
        delay(50);
        rx->setFrequency(stepTestTo, false);
        uint32_t t0 = micros();
        for (int i = 0; i < 200; i++)
        {
            while ((int32_t)(micros() - (t0 + (uint32_t)i * 500)) < 0)
            {
            }
            trace[i] = rx->readRssiRaw();
        }
        uint16_t final = 0;
        for (int i = 180; i < 200; i++)
            final += trace[i];
        final /= 20;
        uint8_t mid = (trace[0] + final) / 2;
        uint8_t lock = 255;
        for (int i = 0; i + 3 < 200 && final > trace[0] + 20; i++)
        {
            if (trace[i] > mid && trace[i + 1] > mid && trace[i + 2] > mid && trace[i + 3] > mid)
            {
                lock = i;
                break;
            }
        }
        stepTestData[k] = lock;
    }
    stepTestDone = true;
}

// Blocks the timing core for ~1.1 s (only on request, never during a race)
void LapTimer::runStepTest()
{
    if (stepTestHops > 0)
    {
        runLockTest();
        return;
    }
    rx->setFrequency(stepTestFrom, false);
    delay(300);
    for (int half = 0; half < 2; half++)
    {
        rx->setFrequency(half == 0 ? stepTestTo : stepTestFrom, false);
        uint32_t t0 = micros();
        for (int i = 0; i < STEP_TEST_HALF; i++)
        {
            while ((int32_t)(micros() - (t0 + (uint32_t)i * STEP_TEST_INTERVAL_US)) < 0)
            {
            }
            stepTestData[half * STEP_TEST_HALF + i] = rx->readRssiRaw();
        }
    }
    stepTestDone = true; // scan() tunes back to the pilots' channels
}

bool LapTimer::requestSpectrum()
{
    if (isRacing() || isSpectrumRunning() || pendingCommand == CMD_START)
        return false;
    spectrumRequested = true;
    return true;
}

// Sweeps the band one frequency at a time: tune, settle, average the RSSI
void LapTimer::spectrumStep(uint32_t nowMs)
{
    if (!spectrumTuned)
    {
        uint16_t freq = SPECTRUM_START_MHZ + spectrumIndex * SPECTRUM_STEP_MHZ;
        rx->setFrequency(freq, false);
        spectrumSettleUntilMs = nowMs + RX_LOCK_MS;
        spectrumSampleUntilMs = spectrumSettleUntilMs + SPECTRUM_SAMPLE_MS;
        spectrumSum = 0;
        spectrumSamples = 0;
        spectrumTuned = true;
        return;
    }
    if ((int32_t)(nowMs - spectrumSettleUntilMs) < 0)
        return;
    if ((int32_t)(nowMs - spectrumSampleUntilMs) < 0)
    {
        spectrumSum += rx->readRssiRaw();
        spectrumSamples++;
        return;
    }
    // average of this window; across sweeps keep the highest average (a transmitter is steady, noise is not)
    uint8_t average = spectrumSamples ? spectrumSum / spectrumSamples : 0;
    if (spectrumSweep == 0 || average > spectrumRssi[spectrumIndex])
        spectrumRssi[spectrumIndex] = average;
    spectrumTuned = false;
    if (++spectrumIndex >= SPECTRUM_POINTS)
    {
        spectrumIndex = 0;
        if (++spectrumSweep >= SPECTRUM_SWEEPS)
        {
            spectrumDone = SPECTRUM_POINTS * SPECTRUM_SWEEPS;
            spectrumActive = false; // scan() tunes back to the pilots' channels
        }
    }
}

void LapTimer::update(uint32_t nowMs)
{
    runPendingCommand();
    runPendingEdit();
    if (spectrumRequested && isRacing())
    {
        spectrumRequested = false; // a race started meanwhile: the race wins
    }
    if (spectrumRequested)
    {
        spectrumRequested = false;
        spectrumActive = true;
        spectrumIndex = 0;
        spectrumSweep = 0;
        spectrumTuned = false;
        spectrumDone = 0;
        memset(spectrumRssi, 0, sizeof(spectrumRssi)); // 0 = not measured yet (the page draws as it goes)
        slotSamples = 0;                               // the hop slot in progress is lost
    }
    if (spectrumActive)
    {
        spectrumStep(nowMs);
        return;
    }
    if (stepTestRequested)
    {
        stepTestRequested = false;
        if (!isRacing())
            runStepTest();
        slotSamples = 0;
        return;
    }
    scan(nowMs);
    recordHistory(nowMs);
    updateRace(nowMs);
}

// Chooses which pilot's frequency the RX5808 listens to and feeds it the readings
void LapTimer::scan(uint32_t nowMs)
{
    // During a race use the race's pilots and frequencies, otherwise the live settings
    bool racing = isRacing();
    uint8_t count = racing ? pilotCount : conf->getPilotCount();

    if (count == 1)
    {
        // One pilot: stay on its channel and sample continuously through the Kalman filter
        activePilot = 0;
        slotSamples = 0;
        slotEndMs = nowMs;
        uint16_t freq = racing ? raceFreq[0] : conf->getFrequency(0);
        if (rx->getFrequency() != freq)
        {
            rx->setFrequency(freq);
            settleUntilMs = nowMs + RX_LOCK_MS;
            settling = true;
        }
        if (settling)
        {
            if ((int32_t)(nowMs - settleUntilMs) < 0)
                return; // not locked yet
            settling = false;
        }
        if (freq == POWER_DOWN_FREQ_MHZ)
            return; // receiver off
        sample(0, round(pilots[0].filter.filter(rx->readRssiRaw(), 0)), nowMs);
        return;
    }

    // Several pilots: one averaged value per pilot per slot
    if ((int32_t)(nowMs - slotEndMs) < 0)
    {
        if ((int32_t)(nowMs - settleUntilMs) >= 0 && slotFreq != POWER_DOWN_FREQ_MHZ)
        {
            slotSum += rx->readRssiRaw();
            slotSamples++;
        }
        return;
    }
    // Slot over: hand it to the pilot if the pilot is still on that channel
    if (slotSamples > 0 && activePilot < count &&
        slotFreq == (racing ? raceFreq[activePilot] : conf->getFrequency(activePilot)))
    {
        sample(activePilot, slotSum / slotSamples, slotEndMs - HOP_DWELL_MS / 2);
    }
    // Next pilot's slot (pilots without a channel are skipped)
    activePilot = nextActivePilot(activePilot, count, racing);
    slotFreq = racing ? raceFreq[activePilot] : conf->getFrequency(activePilot);
    settleUntilMs = nowMs;
    if (rx->getFrequency() != slotFreq)
    {
        rx->setFrequency(slotFreq, false);
        settleUntilMs = nowMs + RX_LOCK_MS;
    }
    slotEndMs = settleUntilMs + HOP_DWELL_MS;
    slotSum = 0;
    slotSamples = 0;
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

// Pass time = middle of the time spent at the peak. When the peak is a single reading (several
// pilots: one reading per pilot every ~50 ms x pilots), a parabola through the peak and its
// neighbours places it between the readings.
uint32_t LapTimer::passTime(PilotState &p)
{
    uint32_t t1 = p.peakFirstMs;
    if (p.peakLastMs != t1)
        return t1 + (p.peakLastMs - t1) / 2;
    if (p.peakNextMs == 0 || p.peakPrevMs == 0)
        return t1;
    float a = (float)(t1 - p.peakPrevMs); // ms before the peak
    float b = (float)(p.peakNextMs - t1); // ms after the peak
    if (a <= 0 || b <= 0 || a > 500 || b > 500)
        return t1; // neighbours missing or too far apart (scan interrupted)
    float d0 = (float)p.peak - p.peakPrev; // > 0: the peak is higher than both neighbours
    float d2 = (float)p.peak - p.peakNext;
    float den = a * d2 + b * d0;
    if (den <= 0)
        return t1;
    float offset = 0.5f * (b * b * d0 - a * a * d2) / den; // vertex of the parabola, ms from t1
    if (offset < -a / 2)
        offset = -a / 2;
    if (offset > b / 2)
        offset = b / 2;
    return t1 + (int32_t)lroundf(offset);
}

void LapTimer::sample(uint8_t pilot, uint8_t v, uint32_t nowMs)
{
    PilotState &p = pilots[pilot];
    uint8_t prevV = p.lastV;
    uint32_t prevMs = p.lastMs;
    p.lastV = v;
    p.lastMs = nowMs;
    p.rssi = v;
    if (!p.stepHasSample || v > p.stepMax)
    {
        p.stepMax = v;
        p.stepHasSample = true;
    }

    bool racing = isRacing();
    uint8_t count = racing ? pilotCount : conf->getPilotCount();
    // Live thresholds, so calibrating during a race works. If the slot was switched to another
    // channel (the next heat being prepared), keep the thresholds of the pilot still flying.
    uint8_t enter = conf->getEnterRssi(pilot);
    uint8_t exit = conf->getExitRssi(pilot);
    if (racing && conf->getFrequency(pilot) != raceFreq[pilot])
    {
        enter = raceEnter[pilot];
        exit = raceExit[pilot];
    }

    // After a pass counted at the peak timeout, wait until the drone has left
    if (p.hoverBlocked)
    {
        if (v < exit)
            p.hoverBlocked = false;
        return;
    }

    // With several pilots, ignore this channel while another pilot's is much stronger
    // (a close drone bleeds into the other channels, but weaker than on its own)
    bool dominant = true;
    for (uint8_t other = 0; other < count; other++)
    {
        uint16_t otherFreq = racing ? raceFreq[other] : conf->getFrequency(other);
        if (otherFreq == POWER_DOWN_FREQ_MHZ)
            continue; // not scanned, its RSSI is stale
        if (other != pilot && pilots[other].rssi > v + BLEED_DELTA)
        {
            dominant = false;
            break;
        }
    }

    if (v >= enter && dominant && (!p.inPass || v > p.peak))
    {
        if (!p.inPass)
        {
            p.inPass = true;
            p.passStartMs = nowMs;
        }
        p.peak = v; // new peak
        p.peakFirstMs = p.peakLastMs = nowMs;
        p.peakPrev = prevV;
        p.peakPrevMs = prevMs;
        p.peakNextMs = 0;
    }
    else if (p.inPass)
    {
        if (v >= enter && dominant && v + PEAK_TOLERANCE >= p.peak)
            p.peakLastMs = nowMs; // still at the peak (plateau)
        if (p.peakNextMs == 0)
        {
            p.peakNext = v; // the reading right after the peak
            p.peakNextMs = nowMs;
        }
    }

    if (p.inPass && (nowMs - p.peakLastMs) > PEAK_TIMEOUT_MS)
    {
        if (state == RACE_RUNNING && p.hasPassed)
        {
            // Landed or hovering near the timer after passing the gate: the pass was at
            // the peak. Wait until the drone has left before detecting again.
            p.inPass = false;
            p.hoverBlocked = true;
            onPass(pilot, passTime(p));
            return;
        }
        // Waiting near the gate before the pilot's first pass (e.g. on the start pad while
        // the signal drifts): drop the old peak, the take-off through the gate makes a new one
        p.peak = v;
        p.peakFirstMs = p.peakLastMs = nowMs;
        p.peakPrev = prevV;
        p.peakPrevMs = prevMs;
        p.peakNextMs = 0;
    }

    if (p.inPass && v < exit)
    {
        // one pilot: the Kalman filter already smooths single readings
        if (++p.belowExit >= (count > 1 ? HOP_EXIT_READINGS : 1))
        {
            p.inPass = false;
            p.belowExit = 0;
            onPass(pilot, passTime(p));
        }
    }
    else
    {
        p.belowExit = 0;
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
    if (p.hasPassed && (passMs - p.lastPassMs) < raceMinLapMs)
    {
        return; // too soon after the previous pass
    }

    if (state == RACE_WAITING)
    {
        // Without countdown the race starts on the first pass of any pilot
        raceStartMs = passMs;
        state = RACE_RUNNING;
    }

    // Write the time before publishing the new count, so readers on
    // another core never see a count without its time
    int index = p.lapCount;
    if (!p.hasPassed)
    {
        p.firstPassMs = passMs;
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
    // The pass time decides, not when it was detected (the exit comes later). Staggered:
    // each pilot's race time runs from their own first pass.
    uint32_t pilotStartMs = staggered ? p.firstPassMs : raceStartMs;
    bool pilotTimeUp = (int32_t)(passMs - pilotStartMs) >= (int32_t)raceMs;
    p.full = p.lapCount >= MAX_LAPS;
    if ((mode == RACE_LAPS && completedLaps >= raceLaps) ||
        (mode == RACE_TIMED && pilotTimeUp && completedLaps >= 1) || p.full)
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

    // Staggered timed race: beep when each pilot's own time is up
    if (mode == RACE_TIMED && staggered)
    {
        for (uint8_t i = 0; i < pilotCount; i++)
        {
            PilotState &p = pilots[i];
            if (p.hasPassed && !p.finished && !p.timeUpBeeped && (nowMs - p.firstPassMs) >= raceMs)
            {
                p.timeUpBeeped = true;
                buz->beep(800);
                led->on(800);
            }
        }
    }

    if (mode == RACE_TIMED && !staggered && !timeUp && (nowMs - raceStartMs) >= raceMs)
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
            bool noChannel = raceFreq[i] == POWER_DOWN_FREQ_MHZ;
            bool didNotStart = mode == RACE_TIMED && !staggered && timeUp && !pilots[i].hasPassed;
            allFinished &= pilots[i].finished || noChannel || didNotStart;
        }
        if (allFinished)
        {
            DEBUG("Race finished\n");
            state = RACE_FINISHED;
            savePending = hasRaceData(); // a race nobody started isn't worth a history slot
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
