#pragma once

#include "RX5808.h"
#include "buzzer.h"
#include "config.h"
#include "kalman.h"
#include "led.h"

#define MAX_LAPS 100              // stored per pilot per race (entry 0 is the start pass)
#define RSSI_HISTORY 240          // per pilot, one value per RSSI_HISTORY_STEP_MS (6 s)
#define RSSI_HISTORY_STEP_MS 25
#define PEAK_TOLERANCE 2          // RSSI units below the peak that still count as "at the peak"
#define COUNTDOWN_MS 3000         // 3-2-1 beeps, then GO

// Several pilots (up to MAX_PILOTS) share one RX5808 by hopping between their frequencies:
// tune, wait for the RX5808 to settle, then sample for the dwell time.
// Values follow PhobosLT_4ch, which tested settle times of 3-8 ms (3 ms gave false laps).
#define HOP_SETTLE_MS 8
#define HOP_DWELL_MS 6            // 14 ms per pilot per cycle: pass time resolution ~ +-7 ms x pilots
#define SINGLE_SETTLE_MS 35       // after a frequency change with one pilot
// With several pilots, a pass only counts while this pilot's RSSI beats the others'
// by this much (a close drone can bleed into the other channels)
#define DOMINANCE_DELTA 10
#define MAX_PASS_MS 3000          // above the enter threshold longer than this = hovering, ignore

// Spectrum scan: RSSI across the 5.8 GHz band to spot channels already in use
#define SPECTRUM_START_MHZ 5645
#define SPECTRUM_STEP_MHZ 5
#define SPECTRUM_POINTS 61        // 5645 - 5945 MHz (bands A, B, E, F, R)
#define SPECTRUM_SWEEPS 3         // highest value of 3 sweeps (~2.6 s)
#define SPECTRUM_SETTLE_MS 10
#define SPECTRUM_SAMPLE_MS 4

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
    bool hoverBlocked;           // held above enter too long: ignore until RSSI drops below exit
    uint32_t passStartMs;
    uint8_t peak;
    uint32_t peakFirstMs;
    uint32_t peakLastMs;

    // race data
    bool hasPassed;
    uint32_t firstPassMs;        // this pilot's own start (staggered races)
    bool timeUpBeeped;           // staggered timed race: this pilot's time-up beep done
    uint32_t lastPassMs;
    uint32_t laps[MAX_LAPS];     // [0] = start pass (ms after race start), [n] = lap n time
    volatile int lapCount;       // number of entries in laps[]
    volatile bool finished;

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

    // Lap correction on the current/last race (only while no race is running)
    bool editLaps(uint8_t pilot, uint8_t op, int index);

    // Spectrum scan (not during a race)
    bool requestSpectrum();
    bool isSpectrumRunning() { return spectrumActive || spectrumRequested; }
    uint8_t getSpectrumRssi(uint8_t point) { return spectrumRssi[point]; }

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
    volatile uint32_t raceStartMs = 0;
    uint32_t startEpochSec = 0;
    uint32_t raceId = 0;
    volatile bool timeUp = false;
    uint8_t countdownBeeps = 0;

    // receiver scheduling
    uint8_t activePilot = 0;
    uint32_t settleUntilMs = 0;
    uint32_t slotEndMs = 0;
    uint32_t historyStepMs = 0;
    volatile uint32_t historySeq = 0;

    // spectrum scan state
    volatile bool spectrumRequested = false;
    volatile bool spectrumActive = false;
    uint8_t spectrumRssi[SPECTRUM_POINTS];
    uint8_t spectrumIndex = 0;
    uint8_t spectrumSweep = 0;
    bool spectrumTuned = false;
    uint8_t spectrumMax = 0;
    uint32_t spectrumSettleUntilMs = 0;
    uint32_t spectrumSampleUntilMs = 0;
    void spectrumStep(uint32_t nowMs);

    void scan(uint32_t nowMs);
    void sample(uint8_t pilot, uint8_t raw, uint32_t nowMs);
    void onPass(uint8_t pilot, uint32_t passMs);
    void updateRace(uint32_t nowMs);
    void recordHistory(uint32_t nowMs);
    void resetPilot(PilotState &p);
    void start(uint32_t startEpochSec);
    void stop();
    void clear();
    void runPendingCommand();
    uint8_t nextActivePilot(uint8_t from, uint8_t count, bool racing);

    enum { CMD_NONE, CMD_START, CMD_STOP, CMD_CLEAR };
    volatile uint8_t pendingCommand = CMD_NONE;
    volatile uint32_t pendingEpoch = 0;
};
