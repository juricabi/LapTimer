#include <Arduino.h>
#include "config.h"

#pragma once

typedef enum {
    BUZZER_IDLE,
    BUZZER_BEEPING
} buzzer_state_e;


class Buzzer {
   public:
    void init(Config* config, uint8_t pin, bool inverted);
    void handleBuzzer(uint32_t currentTimeMs);
    void beep(uint32_t timeMs);

   private:
    // beep() runs on the timing core, handleBuzzer() on the other: the time is stored
    // before the state (see beep), and both are volatile
    volatile buzzer_state_e buzzerState = BUZZER_IDLE;
    uint8_t buzzerPin;
    uint8_t initialState = LOW;
    volatile uint32_t beepTimeMs = 0;
    volatile uint32_t startTimeMs = 0;
    Config* config; // Pointer to Config object
};
