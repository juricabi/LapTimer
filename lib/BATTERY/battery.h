#include <stdint.h>

#include "buzzer.h"
#include "led.h"

#define MONITOR_CHECK_TIME_MS 5000
#define MONITOR_BEEP_TIME_MS 500
#define MONITOR_SAMPLE_TIME_MS 200
#define AVERAGING_SIZE 5

typedef enum {
    ALARM_OFF,
    ALARM_IDLE,
    ALARM_BEEPING
} alarm_state_e;

class BatteryMonitor {
   public:
    void init(uint8_t pin, uint8_t batScale, uint8_t batAdd, Buzzer *buzzer, Led *l);
    // Latest averaged voltage in tenths of a volt. Safe to call from any task.
    uint8_t getBatteryVoltage();
    // Samples the ADC and runs the alarm. Call only from one task.
    void checkBatteryState(uint32_t currentTimeMs, uint8_t alarmThreshold);

   private:
    void sample();

    alarm_state_e state = ALARM_OFF;
    uint16_t measurements[AVERAGING_SIZE];
    uint8_t measurementIndex;
    uint32_t lastCheckTimeMs;
    uint32_t lastSampleTimeMs;
    volatile uint8_t voltage;
    uint8_t vbatPin;
    uint8_t scale;
    uint8_t add;
    Buzzer *buz;
    Led *led;
};
