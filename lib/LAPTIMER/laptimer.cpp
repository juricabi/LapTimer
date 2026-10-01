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

    filter.setMeasurementNoise(rssi_filter_q * 0.01f);
    filter.setProcessNoise(rssi_filter_r * 0.0001f);
    memset(history, 0, sizeof(history));
    resetLaps();
    state = RACE_IDLE;
    DEBUG("LapTimer stopped\n");
}

void LapTimer::raceToJson(JsonObject out)
{
    out["race"] = raceId;
    out["state"] = state;
    out["mode"] = mode;
    out["cd"] = countdown;
    out["raceMs"] = raceMs;
    out["raceLaps"] = raceLaps;
    out["date"] = startEpochSec;
    out["edits"] = editCount;
    if (raceTargetMs)
        out["target"] = raceTargetMs; // the pace target this race started with
    JsonObject p = out["pilots"].to<JsonArray>().add<JsonObject>();
    p["name"] = raceName;
    p["freq"] = raceFreq;
    p["fin"] = finished;
    if (full)
        p["full"] = true;
    JsonArray list = p["laps"].to<JsonArray>();
    int count = lapCount; // read once: laps below this index are complete
    for (int l = 0; l < count; l++)
        list.add(laps[l]);
}

void LapTimer::resetLaps()
{
    inPass = false;
    peakStale = false;
    hoverBlocked = false;
    peak = 0;
    hasPassed = false;
    lastPassMs = 0;
    lapCount = 0;
    finished = false;
    full = false;
    memset(laps, 0, sizeof(laps));
}

// Race settings are taken from the config when the race is armed
void LapTimer::start(uint32_t epochSec)
{
    if (isRacing())
    {
        return;
    }
    if (savePending)
    {
        return; // previous race still being saved; the page retries
    }
    DEBUG("LapTimer started\n");
    mode = conf->getRaceMode();
    countdown = conf->getCountdown();
    raceMs = conf->getRaceMs();
    raceLaps = conf->getRaceLaps();
    raceMinLapMs = conf->getMinLapMs();
    raceFreq = conf->getFrequency();
    raceEnter = conf->getEnterRssi();
    raceExit = conf->getExitRssi();
    strlcpy(raceName, conf->getPilotName(), sizeof(raceName));
    raceTargetMs = conf->getTargetLapMs();
    startEpochSec = epochSec;
    editCount = 0;
    // A race always wins over a channel scan: stop it so the receiver listens to the pilot
    spectrumRequested = false;
    spectrumActive = false;
    spectrumTuned = false;
    resetLaps();
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
    resetLaps();
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
    if (isRacing() || savePending || pendingCommand != CMD_NONE || stepTestBusy)
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

bool LapTimer::requestEdit(uint8_t op, int index)
{
    if (editPending)
        return false;
    editOp = op;
    editIndex = index;
    editPending = true;
    return true;
}

void LapTimer::runPendingEdit()
{
    if (!editPending)
        return;
    if (!isRacing() && !savePending)
    {
        int count = lapCount;
        if (applyLapEdit(laps, count, MAX_LAPS, editOp, editIndex))
        {
            lapCount = count;
            full = count >= MAX_LAPS;
            editCount++;
        }
    }
    editPending = false;
}

bool LapTimer::requestStepTest(uint16_t fromMhz, uint16_t toMhz, uint16_t hops)
{
    if (isRacing() || isSpectrumRunning() || stepTestBusy || pendingCommand == CMD_START)
        return false;
    stepTestFrom = fromMhz;
    stepTestTo = toMhz;
    stepTestHops = hops < STEP_TEST_MAX_HOPS ? hops : STEP_TEST_MAX_HOPS;
    stepTestDone = false;
    stepTestBusy = true;
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
}

// Blocks the timing core for ~1.1 s, or ~150 ms per hop (only on request, never during a race)
void LapTimer::runStepTest()
{
    if (stepTestHops > 0)
    {
        runLockTest();
    }
    else
    {
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
    }
    stepTestDone = true; // scan() tunes back to the pilot's channel
    stepTestBusy = false;
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
            spectrumActive = false; // scan() tunes back to the pilot's channel
        }
    }
}

void LapTimer::update(uint32_t nowMs)
{
    if (nowMs - sampleCountStartMs >= 1000)
    {
        samplesPerSec = sampleCount; // 0 while the receiver is off or held
        sampleCount = 0;
        sampleCountStartMs = nowMs;
    }
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
        stepTestBusy = false;
        return;
    }
    scan(nowMs);
    recordHistory(nowMs);
    updateRace(nowMs);
}

// Keeps the receiver on the pilot's channel and feeds every reading through the Kalman filter
void LapTimer::scan(uint32_t nowMs)
{
    // during a race the race's channel, otherwise the live setting
    uint16_t freq = isRacing() ? raceFreq : conf->getFrequency();
    if (!receiverEnabled && (int32_t)(nowMs - RECEIVER_WAIT_MAX_MS) < 0)
        return; // power-up: the module stays in its reset state until WiFi has started
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
    sample(round(filter.filter(rx->readRssiRaw(), 0)), nowMs);
}

void LapTimer::sample(uint8_t v, uint32_t nowMs)
{
    sampleCount++;
    rssi = v;
    if (!stepHasSample || v > stepMax)
    {
        stepMax = v;
        stepHasSample = true;
    }

    // Live thresholds, so calibrating during a race works. If another pilot was picked
    // during the race (the next one getting ready), keep the flying pilot's thresholds.
    uint8_t enter = conf->getEnterRssi();
    uint8_t exit = conf->getExitRssi();
    if (isRacing() && conf->getFrequency() != raceFreq)
    {
        enter = raceEnter;
        exit = raceExit;
    }

    // After a pass counted at the peak timeout, wait until the drone has left
    if (hoverBlocked)
    {
        if (v < exit)
            hoverBlocked = false;
        return;
    }

    if (v >= enter && (!inPass || v > peak + (peakStale ? PEAK_REARM : 0)))
    {
        inPass = true; // new peak (a stale one needs a clear rise, see PEAK_REARM)
        peakStale = false;
        peak = v;
        peakFirstMs = peakLastMs = peakSinceMs = nowMs;
    }
    else if (inPass && v >= enter && v + PEAK_TOLERANCE >= peak)
    {
        peakLastMs = nowMs; // still at the peak (plateau)
    }

    if (inPass && ((nowMs - peakLastMs) > PEAK_TIMEOUT_MS || (nowMs - peakSinceMs) > PEAK_PARKED_MS))
    {
        if (state == RACE_RUNNING && hasPassed && !peakStale && peak >= v + PEAK_DROP)
        {
            // Landed or hovering near the timer after passing the gate: the pass was at
            // the peak. Wait until the drone has left before detecting again.
            inPass = false;
            hoverBlocked = true;
            onPass(peakFirstMs + (peakLastMs - peakFirstMs) / 2);
            return;
        }
        // Waiting near the gate (on the pad, maybe just switched on) with the signal only
        // drifting or flat: drop the old peak; the take-off through the gate makes a new one.
        // Repeats while it stays (at the latest every PEAK_PARKED_MS), so the level to rise
        // from follows the drone.
        peakStale = true;
        peak = v;
        peakFirstMs = peakLastMs = peakSinceMs = nowMs;
    }

    if (inPass && v < exit)
    {
        // Pass time = middle of the time spent at the peak, which is more
        // accurate than the first peak sample when the signal plateaus
        inPass = false;
        if (!peakStale)
            onPass(peakFirstMs + (peakLastMs - peakFirstMs) / 2);
    }
}

void LapTimer::onPass(uint32_t passMs)
{
    if (state != RACE_WAITING && state != RACE_RUNNING)
    {
        return; // no race, countdown not finished, or race finished
    }
    if (finished)
    {
        return;
    }
    if (hasPassed && (passMs - lastPassMs) < raceMinLapMs)
    {
        return; // too soon after the previous pass
    }

    if (state == RACE_WAITING)
    {
        // Without countdown the race starts on the first pass
        raceStartMs = passMs;
        state = RACE_RUNNING;
    }

    // Write the time before publishing the new count, so readers on
    // another core never see a count without its time
    int index = lapCount;
    if (!hasPassed)
    {
        // Start pass, relative to the race start. It can be slightly before the start
        // (drone on the gate during the countdown), so clamp at 0.
        int32_t sinceStart = (int32_t)(passMs - raceStartMs);
        if (sinceStart < 0)
            passMs = raceStartMs; // the next lap is timed from the start too
        laps[index] = passMs - raceStartMs;
        hasPassed = true;
    }
    else
    {
        laps[index] = passMs - lastPassMs;
    }
    lastPassMs = passMs;
    lapCount = index + 1;
    DEBUG("Pass %d: %u ms\n", index, laps[index]);

    int completedLaps = lapCount - 1;
    // The pass time decides, not when it was detected (the exit comes later)
    bool raceTimeUp = (int32_t)(passMs - raceStartMs) >= (int32_t)raceMs;
    full = lapCount >= MAX_LAPS;
    if ((mode == RACE_LAPS && completedLaps >= raceLaps) ||
        (mode == RACE_TIMED && raceTimeUp && completedLaps >= 1) || full)
    {
        finished = true;
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
            peakSinceMs = nowMs; // a drone on the pad since the countdown: PEAK_PARKED_MS counts from GO
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
        timeUp = true; // the pilot finishes on the next pass
        buz->beep(800);
        led->on(800);
    }

    // Timed and lap races end when the pilot finishes, or when the time is up
    // before the first pass (or there is no channel to listen to)
    bool over = finished || (mode == RACE_TIMED && timeUp && !hasPassed) || raceFreq == POWER_DOWN_FREQ_MHZ;
    if (mode != RACE_PRACTICE && over)
    {
        DEBUG("Race finished\n");
        state = RACE_FINISHED;
        savePending = hasRaceData(); // a race without laps isn't worth a history slot
        buz->beep(1200);
        led->on(1200);
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
    history[seq % RSSI_HISTORY] = stepHasSample ? stepMax : rssi;
    stepHasSample = false;
    historySeq = seq;
}
