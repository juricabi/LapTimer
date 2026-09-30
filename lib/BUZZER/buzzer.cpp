#include "buzzer.h"

void Buzzer::init(Config *config, uint8_t pin, bool inverted)
{
    this->config = config; // Store the config pointer
    pinMode(pin, OUTPUT);
    initialState = inverted ? HIGH : LOW;
    buzzerPin = pin;
    buzzerState = BUZZER_IDLE;
    digitalWrite(buzzerPin, initialState);
}

void Buzzer::beep(uint32_t timeMs)
{
    if (config->getBuzzerOn() == false)
    {
        return;
    }

    // time first, state last: handleBuzzer() on the other core reads them in that order
    uint32_t now = millis();
    startTimeMs = now;
    beepTimeMs = timeMs;
    digitalWrite(buzzerPin, !initialState);
    buzzerState = BUZZER_BEEPING;
}

void Buzzer::handleBuzzer(uint32_t currentTimeMs)
{
    switch (buzzerState)
    {
    case BUZZER_IDLE:
        break;
    case BUZZER_BEEPING:
        if (currentTimeMs < startTimeMs)
        {
            break; // updated from different core
        }
        if ((currentTimeMs - startTimeMs) > beepTimeMs)
        {
            digitalWrite(buzzerPin, initialState);
            buzzerState = BUZZER_IDLE;
        }
        break;
    default:
        break;
    }
}
