#include <stdint.h>

#define POWER_DOWN_FREQ_MHZ 1111  // signal to power down the module
#define RESET_STATE_FREQ_MHZ 0    // getFrequency() after init(): reset state, nothing written yet
#define RX5808_BIT_DELAY_US 10    // SPI bit-bang half period; the RTC6715 is fine with much less than the original 300 us
#define RX5808_RESET_MS 60        // the RX5808 ignores writes for 20-50 ms after a reset

class RX5808 {
   public:
    RX5808(uint8_t _rssiInputPin, uint8_t _rx5808DataPin, uint8_t _rx5808SelPin, uint8_t _rx5808ClkPin);
    void init();
    void setFrequency(uint16_t frequency, bool verbose = true);
    uint8_t readRssiRaw();
    uint16_t getFrequency() { return currentFrequency; }

   private:
    uint8_t rx5808DataPin = 0;  // DATA (CH1) output line to RX5808 module
    uint8_t rx5808ClkPin = 0;   // CLK (CH3) output line to RX5808 module
    uint8_t rx5808SelPin = 0;   // SEL (CH2) output line to RX5808 module
    uint8_t rssiInputPin = 0;   // RSSI input from RX5808

    uint16_t currentFrequency = 0;

    bool rxPoweredDown = false;

    void rx5808SerialSendBit1();
    void rx5808SerialSendBit0();
    void rx5808SerialEnableLow();
    void rx5808SerialEnableHigh();

    void setRxModulePower(uint32_t options);
    void resetRxModule();
    void setupRxModule();
    void powerDownRxModule();

    static uint16_t freqMhzToRegVal(uint16_t freqInMhz);
};
