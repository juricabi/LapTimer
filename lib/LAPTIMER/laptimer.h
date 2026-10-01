#pragma once

#include <ArduinoJson.h>

#include "RX5808.h"
#include "buzzer.h"
#include "config.h"
#include "kalman.h"
#include "led.h"

#define MAX_LAPS 200              // stored per race (entry 0 is the start pass); a full race finishes
#define RSSI_HISTORY 240          // one value per RSSI_HISTORY_STEP_MS (6 s)
#define RSSI_HISTORY_STEP_MS 25
#define PEAK_TOLERANCE 2          // RSSI units below the peak that still count as "at the peak"
#define COUNTDOWN_MS 3000         // 3-2-1 beeps, then GO

// After every frequency change the RX5808 shows nothing until its synthesizer has locked,
// then the full RSSI at once. Measured with /api/debug/step: the same for any jump (5-155 MHz);
// over 150 switches 36 ms typically, 44.5 ms at most (timed from the end of the register
// write; the wait here starts a little earlier). Too slow to share one receiver between
// pilots: a fast pass would fall between the readings.
#define RECEIVER_WAIT_MAX_MS 5000 // power-up: receiver off until WiFi has started, at most this long
#define RX_LOCK_MS 50
// Still above exit this long after the signal was last at the peak: landed or hovering near
// the timer. If the signal fell clearly (PEAK_DROP) from the peak after the first pass, the
// pass is counted at the peak; otherwise (drone switched on at the pad, the signal drifting)
// the peak is dropped and only a clear rise (PEAK_REARM, more than the plateau tolerance and
// the wander of a parked drone) starts a new one.
#define PEAK_TIMEOUT_MS 3000
#define PEAK_DROP 10
#define PEAK_REARM 5
// A flat signal stays at its peak and never reaches PEAK_TIMEOUT_MS: a drone parked within
// Enter got its pass (or the race start) at the middle of a plateau of any length, and a
// crashed drone carried away counted a lap. So a peak is also dropped after this long in
// all, counted from when it began, or from GO in a countdown race (a drone waiting on the
// pad during the countdown still gets its start pass when it takes off). A pass at the
// gate is at its peak for well under a second; a slow one for a few.
#define PEAK_PARKED_MS 10000

// Spectrum scan: RSSI across the 5.8 GHz band to spot channels already in use
#define SPECTRUM_START_MHZ 5645
#define SPECTRUM_STEP_MHZ 5
#define SPECTRUM_POINTS 61        // 5645 - 5945 MHz (bands A, B, E, F, R)
#define SPECTRUM_SWEEPS 2         // highest average of 2 sweeps (~6.5 s)
#define SPECTRUM_SAMPLE_MS 5      // average after RX_LOCK_MS

// Receiver response test: 200 samples rise + 200 samples fall, 2 ms apart
#define STEP_TEST_HALF 200
#define STEP_TEST_SAMPLES (2 * STEP_TEST_HALF)
#define STEP_TEST_INTERVAL_US 2000
#define STEP_TEST_MAX_HOPS 60     // ~150 ms each: the timing core is blocked meanwhile

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
    RACE_FINISHED = 4    // the pilot finished (timed / lap races)
} race_state_e;

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
    bool hasRaceData() { return lapCount > 0; }  // laps in the current/last race

    // race state
    race_state_e getState() { return state; }
    race_mode_e getMode() { return mode; }
    bool getCountdown() { return countdown; }
    uint32_t getRaceId() { return raceId; }
    int32_t getElapsedMs(uint32_t nowMs);  // < 0 during countdown, 0 before the race starts
    uint32_t getRaceMs() { return raceMs; }
    uint8_t getRaceLaps() { return raceLaps; }
    bool isTimeUp() { return timeUp; }
    uint8_t getRssi() { return rssi; }
    int getLapCount() { return lapCount; }
    bool isFinished() { return finished; }
    uint16_t getEditCount() { return editCount; }

    // The current/last race as JSON (shared by /api/race and the race history).
    // "pilots" is a list (one entry) so races saved by older builds read the same way.
    void raceToJson(JsonObject out);

    // Lap correction on the current/last race (only while no race is running). Queued like
    // the race commands; editCount changes once it is applied. False if one is still queued.
    bool requestEdit(uint8_t op, int index);

    // Spectrum scan (not during a race)
    bool requestSpectrum();
    bool isSpectrumRunning() { return spectrumActive || spectrumRequested; }
    uint8_t getSpectrumRssi(uint8_t point) { return spectrumRssi[point]; }
    // measured steps so far (all sweeps); SPECTRUM_POINTS * SPECTRUM_SWEEPS when complete
    uint16_t getSpectrumProgress() { return spectrumActive ? spectrumSweep * SPECTRUM_POINTS + spectrumIndex : spectrumDone; }

    // Receiver response test (diagnostics): tune to `fromMhz`, then switch to `toMhz` and
    // record the raw RSSI every STEP_TEST_INTERVAL_US (rise), then switch back (fall).
    // hops > 0: instead switch from -> to `hops` times (50 ms on `from`) and store each lock
    // time in 0.5 ms units (255 = no lock within 100 ms; needs a VTX on `to`).
    bool requestStepTest(uint16_t fromMhz, uint16_t toMhz, uint16_t hops = 0);
    bool isStepTestDone() { return stepTestDone; }
    uint8_t getStepTestSample(uint16_t i) { return stepTestData[i]; }

    // At power-up the receiver stays off until WiFi has started (at most RECEIVER_WAIT_MAX_MS):
    // the ESP32 calibrates its transmitter then, and the tuned RX5808 disturbs that
    // calibration (CLAUDE.md, Transmit power fade). The web server calls this once WiFi is up.
    void enableReceiver() { receiverEnabled = true; }

    // Diagnostics: RSSI samples taken in the last full second
    uint32_t getSamplesPerSec() { return samplesPerSec; }

    // RSSI history for the calibration graph
    uint32_t getHistorySeq() { return historySeq; }
    uint8_t getHistory(uint32_t seq) { return history[seq % RSSI_HISTORY]; }

    // set when a race ended with laps; the race store saves it and clears the flag
    volatile bool savePending = false;

   private:
    Config *conf;
    RX5808 *rx;
    Buzzer *buz;
    Led *led;
    volatile bool receiverEnabled = false;

    // race, with the settings taken at race start (switching to another pilot during a
    // race doesn't change the race: same channel, name and thresholds)
    volatile race_state_e state = RACE_IDLE;
    race_mode_e mode = RACE_PRACTICE;
    bool countdown = false;
    uint32_t raceMs = 0;
    uint8_t raceLaps = 0;
    uint32_t raceMinLapMs = 0;
    uint16_t raceFreq = 0;
    char raceName[21] = "";
    uint8_t raceEnter = 0;
    uint8_t raceExit = 0;
    uint32_t raceTargetMs = 0;        // pace target (0 = none): only reported, the page uses it
    volatile uint16_t editCount = 0;  // lap corrections since the race started
    volatile uint32_t raceStartMs = 0;
    uint32_t startEpochSec = 0;
    uint32_t raceId = 0;
    volatile bool timeUp = false;
    uint8_t countdownBeeps = 0;

    // laps
    bool hasPassed = false;
    uint32_t lastPassMs = 0;
    uint32_t laps[MAX_LAPS];          // [0] = start pass (ms after race start), [n] = lap n time
    volatile int lapCount = 0;        // number of entries in laps[]
    volatile bool finished = false;
    bool full = false;                // laps[] full: finished early

    // RSSI
    KalmanFilter filter;
    volatile uint8_t rssi = 0;        // latest filtered RSSI
    bool settling = false;            // waiting for the receiver to lock after a channel change
    uint32_t settleUntilMs = 0;
    uint8_t stepMax = 0;              // max RSSI in the current history step
    bool stepHasSample = false;
    uint8_t history[RSSI_HISTORY];
    uint32_t historyStepMs = 0;
    volatile uint32_t historySeq = 0;
    uint32_t sampleCount = 0;
    uint32_t sampleCountStartMs = 0;
    volatile uint32_t samplesPerSec = 0;

    // pass detection
    bool inPass = false;
    bool peakStale = false;           // peak dropped at the timeout: only a new peak counts
    bool hoverBlocked = false;        // pass counted at the timeout: ignore until below exit
    uint8_t peak = 0;
    uint32_t peakFirstMs = 0;
    uint32_t peakLastMs = 0;
    uint32_t peakSinceMs = 0;         // for PEAK_PARKED_MS: when the peak began, or GO

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
    volatile bool stepTestBusy = false;  // requested or running: no race start meanwhile
    uint8_t stepTestData[STEP_TEST_SAMPLES];
    void runLockTest();
    void runStepTest();

    void scan(uint32_t nowMs);
    void sample(uint8_t v, uint32_t nowMs);
    void onPass(uint32_t passMs);
    void updateRace(uint32_t nowMs);
    void recordHistory(uint32_t nowMs);
    void resetLaps();
    void start(uint32_t startEpochSec);
    void stop();
    void clear();
    void runPendingCommand();
    void runPendingEdit();

    enum { CMD_NONE, CMD_START, CMD_STOP, CMD_CLEAR };
    volatile uint8_t pendingCommand = CMD_NONE;
    volatile uint32_t pendingEpoch = 0;
    volatile uint8_t editOp = 0;   // stored before editPending (all volatile: order kept)
    volatile int editIndex = 0;
    volatile bool editPending = false;
};
