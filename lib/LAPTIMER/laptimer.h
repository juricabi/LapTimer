#pragma once

#include <ArduinoJson.h>

#include "RX5808.h"
#include "buzzer.h"
#include "config.h"
#include "kalman.h"
#include "led.h"

#define MAX_LAPS 200              // stored per pilot per race (entry 0 is the start pass); a full pilot finishes
#define RSSI_HISTORY 240          // per pilot, one value per RSSI_HISTORY_STEP_MS (6 s)
#define RSSI_HISTORY_STEP_MS 25
#define PEAK_TOLERANCE 2          // RSSI units below the peak that still count as "at the peak"
#define COUNTDOWN_MS 3000         // 3-2-1 beeps, then GO

// After every frequency change the RX5808 shows nothing until its synthesizer has locked,
// then the full RSSI at once. Measured with /api/debug/step: 36-40 ms whatever the jump
// (5-155 MHz), so wait RX_LOCK_MS before trusting a reading.
#define RX_LOCK_MS 45
// Several pilots (up to MAX_PILOTS) share one RX5808 by hopping between their frequencies:
// tune, wait RX_LOCK_MS, then average the RSSI for HOP_DWELL_MS. One value per pilot every
// (RX_LOCK_MS + HOP_DWELL_MS) x pilots; the pass time is refined with a 3-point peak fit.
#define HOP_DWELL_MS 5
// With several pilots, a pass doesn't count while another pilot's RSSI is more than this
// above it: a close drone bleeds into the other channels, but weaker than on its own.
// Pilots crossing together (similar RSSI) both count.
#define BLEED_DELTA 20
// Still above exit this long after the peak: landed or hovering near the timer. A racing
// pilot's pass is counted at the peak; before the pilot's first pass the old peak is dropped.
#define PEAK_TIMEOUT_MS 3000
// With several pilots a reading is 5 ms of signal, and one odd reading (measured: ~0.4%,
// near noise level) must not end a pass early: this many readings below exit in a row end it
#define HOP_EXIT_READINGS 2

// Spectrum scan: RSSI across the 5.8 GHz band to spot channels already in use
#define SPECTRUM_START_MHZ 5645
#define SPECTRUM_STEP_MHZ 5
#define SPECTRUM_POINTS 61        // 5645 - 5945 MHz (bands A, B, E, F, R)
#define SPECTRUM_SWEEPS 2         // highest average of 2 sweeps (~6 s)
#define SPECTRUM_SAMPLE_MS 5      // average after RX_LOCK_MS

// Receiver response test: 200 samples rise + 200 samples fall, 2 ms apart
#define STEP_TEST_HALF 200
#define STEP_TEST_SAMPLES (2 * STEP_TEST_HALF)
#define STEP_TEST_INTERVAL_US 2000

// Correcting laps after a race
enum {
    LAP_EDIT_MERGE = 0,  // false pass at the end of this lap: join it with the next lap
    LAP_EDIT_SPLIT = 1   // missed pass inside this lap: split it into two laps
};

// Applies a lap edit to a lap list ([0] = start pass). Returns false if not possible.
bool applyLapEdit(uint32_t *laps, int &count, int maxCount, uint8_t op, int index);

typedef enum {
    RACE_IDLE = 0,       // no race; shows the last race's laps
    RACE_COUNTDOWN = 1,  // 3-2-1-go running
    RACE_WAITING = 2,    // armed, race starts on the first gate pass
    RACE_RUNNING = 3,
    RACE_FINISHED = 4    // every pilot finished (timed / lap races)
} race_state_e;

struct PilotState {
    KalmanFilter filter;
    volatile uint8_t rssi;       // latest filtered RSSI
    uint8_t stepMax;             // max RSSI in the current history step
    bool stepHasSample;

    // pass detection
    bool inPass;
    bool hoverBlocked;           // pass counted at a timeout: ignore until RSSI drops below exit
    uint32_t passStartMs;
    uint8_t peak;
    uint32_t peakFirstMs;
    uint32_t peakLastMs;
    // neighbours of a single-sample peak, for the 3-point peak fit when hopping
    uint8_t lastV;               // previous value
    uint32_t lastMs;
    uint8_t peakPrev;            // value before the peak
    uint32_t peakPrevMs;
    uint8_t peakNext;            // value after the peak (valid if peakNextMs != 0)
    uint32_t peakNextMs;
    uint8_t belowExit;           // readings below exit in a row

    // race data
    bool hasPassed;
    uint32_t firstPassMs;        // this pilot's own start (staggered races)
    bool timeUpBeeped;           // staggered timed race: this pilot's time-up beep done
    uint32_t lastPassMs;
    uint32_t laps[MAX_LAPS];     // [0] = start pass (ms after race start), [n] = lap n time
    volatile int lapCount;       // number of entries in laps[]
    volatile bool finished;
    bool full;                   // laps[] full: finished early

    uint8_t history[RSSI_HISTORY];
};

class LapTimer {
   public:
    void init(Config *config, RX5808 *rx5808, Buzzer *buzzer, Led *l);
    void update(uint32_t nowMs);  // call continuously from the main loop

    // Race commands. They are called from the web server (another core), so they only
    // queue the command; update() carries it out on the timing core.
    // requestStart/requestClear return false if the timer is busy (racing or saving).
    bool requestStart(uint32_t startEpochSec);  // epoch time from the browser, for race history
    void requestStop();
    bool requestClear();                        // forget the last race's laps (not while racing)
    bool isRacing() { return state == RACE_COUNTDOWN || state == RACE_WAITING || state == RACE_RUNNING; }
    bool hasRaceData();                         // any pilot has laps in the current/last race

    // race state
    race_state_e getState() { return state; }
    race_mode_e getMode() { return mode; }
    bool getCountdown() { return countdown; }
    bool getStaggered() { return staggered; }
    uint32_t getRaceId() { return raceId; }
    uint32_t getStartEpoch() { return startEpochSec; }
    int32_t getElapsedMs(uint32_t nowMs);  // < 0 during countdown, 0 before the race starts
    uint32_t getRaceMs() { return raceMs; }
    uint8_t getRaceLaps() { return raceLaps; }
    bool isTimeUp() { return timeUp; }

    // pilots
    uint8_t getPilotCount() { return pilotCount; }
    uint8_t getRssi(uint8_t pilot) { return pilots[pilot].rssi; }
    int getLapCount(uint8_t pilot) { return pilots[pilot].lapCount; }
    uint32_t getLap(uint8_t pilot, int index) { return pilots[pilot].laps[index]; }
    bool isFinished(uint8_t pilot) { return pilots[pilot].finished; }
    uint16_t getRaceFrequency(uint8_t pilot) { return raceFreq[pilot]; }
    const char *getRaceName(uint8_t pilot) { return raceNames[pilot]; }
    uint16_t getEditCount() { return editCount; }

    // The current/last race as JSON (shared by /api/race and the race history)
    void raceToJson(JsonObject out);

    // Lap correction on the current/last race (only while no race is running). Queued like
    // the race commands; editCount changes once it is applied. False if one is still queued.
    bool requestEdit(uint8_t pilot, uint8_t op, int index);

    // Spectrum scan (not during a race)
    bool requestSpectrum();
    bool isSpectrumRunning() { return spectrumActive || spectrumRequested; }
    uint8_t getSpectrumRssi(uint8_t point) { return spectrumRssi[point]; }
    // measured steps so far (all sweeps); SPECTRUM_POINTS * SPECTRUM_SWEEPS when complete
    uint16_t getSpectrumProgress() { return spectrumActive ? spectrumSweep * SPECTRUM_POINTS + spectrumIndex : spectrumDone; }

    // Receiver response test (diagnostics): tune to `fromMhz`, then switch to `toMhz` and
    // record the raw RSSI every STEP_TEST_INTERVAL_US (rise), then switch back (fall).
    // hops > 0: instead switch from -> to `hops` times (50 ms on `from` like a hop slot) and
    // store each lock time in 0.5 ms units (255 = no lock within 100 ms; needs a VTX on `to`).
    bool requestStepTest(uint16_t fromMhz, uint16_t toMhz, uint16_t hops = 0);
    bool isStepTestDone() { return stepTestDone; }
    uint16_t getStepTestCount() { return STEP_TEST_SAMPLES; }
    uint8_t getStepTestSample(uint16_t i) { return stepTestData[i]; }

    // RSSI history for the calibration graph
    uint32_t getHistorySeq() { return historySeq; }
    uint8_t getHistory(uint8_t pilot, uint32_t seq) { return pilots[pilot].history[seq % RSSI_HISTORY]; }

    // set when a race ended with laps; the race store saves it and clears the flag
    volatile bool savePending = false;

   private:
    Config *conf;
    RX5808 *rx;
    Buzzer *buz;
    Led *led;

    PilotState pilots[MAX_PILOTS];
    volatile race_state_e state = RACE_IDLE;
    race_mode_e mode = RACE_PRACTICE;
    bool countdown = false;
    bool staggered = false;
    uint32_t raceMs = 0;
    uint8_t raceLaps = 0;
    uint8_t pilotCount = 1;
    uint16_t raceFreq[MAX_PILOTS] = {0, 0};
    char raceNames[MAX_PILOTS][21];   // names at race start (renaming later doesn't relabel the race)
    uint8_t raceEnter[MAX_PILOTS];    // thresholds at race start, used if the slot's channel changes
    uint8_t raceExit[MAX_PILOTS];
    uint32_t raceMinLapMs = 0;
    volatile uint16_t editCount = 0;  // lap corrections since the race started
    volatile uint32_t raceStartMs = 0;
    uint32_t startEpochSec = 0;
    uint32_t raceId = 0;
    volatile bool timeUp = false;
    uint8_t countdownBeeps = 0;

    // receiver scheduling
    uint8_t activePilot = 0;
    bool settling = false;       // one pilot: waiting for the receiver to lock
    uint32_t settleUntilMs = 0;
    uint32_t slotEndMs = 0;
    uint16_t slotFreq = 0;       // frequency tuned for the current hop slot
    uint32_t slotSum = 0;        // RSSI sum and count in the current hop slot
    uint16_t slotSamples = 0;
    uint32_t historyStepMs = 0;
    volatile uint32_t historySeq = 0;

    // spectrum scan state
    volatile bool spectrumRequested = false;
    volatile bool spectrumActive = false;
    uint8_t spectrumRssi[SPECTRUM_POINTS];
    uint8_t spectrumIndex = 0;
    uint16_t spectrumDone = 0;   // progress of the last finished scan
    uint8_t spectrumSweep = 0;
    bool spectrumTuned = false;
    uint32_t spectrumSum = 0;
    uint16_t spectrumSamples = 0;
    uint32_t spectrumSettleUntilMs = 0;
    uint32_t spectrumSampleUntilMs = 0;
    void spectrumStep(uint32_t nowMs);

    // receiver response test
    volatile bool stepTestRequested = false;
    volatile bool stepTestDone = false;
    uint16_t stepTestFrom = 0;
    uint16_t stepTestTo = 0;
    uint16_t stepTestHops = 0;
    uint8_t stepTestData[STEP_TEST_SAMPLES];
    void runLockTest();
    void runStepTest();

    void scan(uint32_t nowMs);
    void sample(uint8_t pilot, uint8_t v, uint32_t nowMs);  // v: filtered (one pilot) or slot average
    uint32_t passTime(PilotState &p);
    void onPass(uint8_t pilot, uint32_t passMs);
    void updateRace(uint32_t nowMs);
    void recordHistory(uint32_t nowMs);
    void resetPilot(PilotState &p);
    void start(uint32_t startEpochSec);
    void stop();
    void clear();
    void runPendingCommand();
    void runPendingEdit();
    uint8_t nextActivePilot(uint8_t from, uint8_t count, bool racing);

    enum { CMD_NONE, CMD_START, CMD_STOP, CMD_CLEAR };
    volatile uint8_t pendingCommand = CMD_NONE;
    volatile uint32_t pendingEpoch = 0;
    volatile bool editPending = false;
    uint8_t editPilot = 0;
    uint8_t editOp = 0;
    int editIndex = 0;
};
