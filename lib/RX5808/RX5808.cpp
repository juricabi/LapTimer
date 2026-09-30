#include "RX5808.h"

#include <Arduino.h>

#include "debug.h"

#if CONFIG_IDF_TARGET_ESP32
#include "driver/adc.h"
#include "soc/sens_struct.h"
#endif

RX5808::RX5808(uint8_t _rssiInputPin, uint8_t _rx5808DataPin, uint8_t _rx5808SelPin, uint8_t _rx5808ClkPin) {
    rssiInputPin = _rssiInputPin;
    rx5808DataPin = _rx5808DataPin;
    rx5808SelPin = _rx5808SelPin;
    rx5808ClkPin = _rx5808ClkPin;
}

void RX5808::init() {
    pinMode(rssiInputPin, INPUT);
    pinMode(rx5808DataPin, OUTPUT);
    pinMode(rx5808SelPin, OUTPUT);
    pinMode(rx5808ClkPin, OUTPUT);
#if CONFIG_IDF_TARGET_ESP32
    // analogRead() once sets up the pin, attenuation and width; the ADC then stays powered and
    // readRssiAdc() starts conversions itself (CLAUDE.md, Sampling rate)
    analogRead(rssiInputPin);
    int8_t channel = digitalPinToAnalogChannel(rssiInputPin);
    if (channel >= 0 && channel < 8) {  // ADC1 (ADC2 is shared with WiFi)
        adc_power_acquire();
        adcChannel = channel;
    }
#endif
    digitalWrite(rx5808SelPin, HIGH);
    digitalWrite(rx5808ClkPin, LOW);
    digitalWrite(rx5808DataPin, LOW);
    // After a reset the RX5808 ignores writes for 20-50 ms (measured) and stays deaf until its
    // power register is written, so wait before the next write
    resetRxModule();
    delay(RX5808_RESET_MS);
    // Left in its reset state (as after power-up) until LapTimer::scan() tunes it: the ESP32
    // calibrates its transmitter when WiFi starts, and a tuned or powered-down RX5808 disturbs
    // that (CLAUDE.md, Transmit power fade). Marked powered down, so the first tune writes the
    // power register (setupRxModule) and wakes it.
    currentFrequency = POWER_DOWN_FREQ_MHZ;
    rxPoweredDown = true;
}

// Set frequency on RX5808 module to given value
void RX5808::setFrequency(uint16_t vtxFreq, bool verbose) {
    if (verbose) DEBUG("Setting frequency to %u\n", vtxFreq);

    currentFrequency = vtxFreq;

    if (vtxFreq == POWER_DOWN_FREQ_MHZ)  // frequency value to power down rx module
    {
        powerDownRxModule();
        rxPoweredDown = true;
        return;
    }
    if (rxPoweredDown) {
        // Power the blocks back on. Not resetRxModule(): after a reset the RX5808 ignores
        // frequency writes for 20-50 ms (measured), so the receiver stayed deaf after boot.
        setupRxModule();
        rxPoweredDown = false;
    }

    // Get the hex value to send to the rx module
    uint16_t vtxHex = freqMhzToRegVal(vtxFreq);

    // Channel data from the lookup table, 20 bytes of register data are sent, but the
    // MSB 4 bits are zeros register address = 0x1, write, data0-15=vtxHex data15-19=0x0
    rx5808SerialEnableHigh();
    rx5808SerialEnableLow();

    rx5808SerialSendBit1();  // Register 0x1
    rx5808SerialSendBit0();
    rx5808SerialSendBit0();
    rx5808SerialSendBit0();

    rx5808SerialSendBit1();  // Write to register

    // D0-D15, note: loop runs backwards as more efficent on AVR
    uint8_t i;
    for (i = 16; i > 0; i--) {
        if (vtxHex & 0x1) {  // Is bit high or low?
            rx5808SerialSendBit1();
        } else {
            rx5808SerialSendBit0();
        }
        vtxHex >>= 1;  // Shift bits along to check the next one
    }

    for (i = 4; i > 0; i--)  // Remaining D16-D19
        rx5808SerialSendBit0();

    rx5808SerialEnableHigh();  // Finished clocking data in
    delayMicroseconds(100);

    digitalWrite(rx5808ClkPin, LOW);
    digitalWrite(rx5808DataPin, LOW);
}

// One conversion of the RSSI pin, 0-4095. On the classic ESP32 the ADC's registers are used
// directly (the steps of the IDF's adc1_get_raw after the setup in init()), from IRAM:
// analogRead() takes ~90 us, mostly setup repeated on every call and code run from flash, and
// its speed changed from build to build with where that code landed in flash (6 500 to
// 10 600 samples/s). Only core 1 uses the ADC (CLAUDE.md, Boot freeze).
uint16_t IRAM_ATTR RX5808::readRssiAdc() {
#if CONFIG_IDF_TARGET_ESP32
    if (adcChannel >= 0) {
        SENS.sar_read_ctrl.sar1_dig_force = 0;          // RTC controller, started by software
        SENS.sar_meas_start1.meas1_start_force = 1;
        SENS.sar_meas_start1.sar1_en_pad_force = 1;
        SENS.sar_meas_start1.sar1_en_pad = 1 << adcChannel;
        SENS.sar_meas_start1.meas1_start_sar = 0;
        SENS.sar_meas_start1.meas1_start_sar = 1;
        while (!SENS.sar_meas_start1.meas1_done_sar) {
        }
        return SENS.sar_meas_start1.meas1_data_sar;
    }
#endif
    return analogRead(rssiInputPin);
}

// Read the RSSI value. The caller (LapTimer::scan) waits for the receiver to settle after tuning.
uint8_t RX5808::readRssiRaw() {
    // reads 5V value as 0-4095, RX5808 is 3.3V powered so RSSI pin will never output the full range
    uint16_t rssi = readRssiAdc();
    // clamp upper range to fit scaling
    if (rssi > 2047) rssi = 2047;
    // rescale to fit into a byte and remove some jitter TODO: experiment with exp or log
    return rssi >> 3;
}

void RX5808::rx5808SerialSendBit1() {
    digitalWrite(rx5808DataPin, HIGH);
    delayMicroseconds(RX5808_BIT_DELAY_US);
    digitalWrite(rx5808ClkPin, HIGH);
    delayMicroseconds(RX5808_BIT_DELAY_US);
    digitalWrite(rx5808ClkPin, LOW);
    delayMicroseconds(RX5808_BIT_DELAY_US);
}

void RX5808::rx5808SerialSendBit0() {
    digitalWrite(rx5808DataPin, LOW);
    delayMicroseconds(RX5808_BIT_DELAY_US);
    digitalWrite(rx5808ClkPin, HIGH);
    delayMicroseconds(RX5808_BIT_DELAY_US);
    digitalWrite(rx5808ClkPin, LOW);
    delayMicroseconds(RX5808_BIT_DELAY_US);
}

void RX5808::rx5808SerialEnableLow() {
    digitalWrite(rx5808SelPin, LOW);
    delayMicroseconds(RX5808_BIT_DELAY_US);
}

void RX5808::rx5808SerialEnableHigh() {
    digitalWrite(rx5808SelPin, HIGH);
    delayMicroseconds(RX5808_BIT_DELAY_US);
}

// Reset the rx5808 module (at start-up only, see init())
void RX5808::resetRxModule() {
    rx5808SerialEnableHigh();
    rx5808SerialEnableLow();

    rx5808SerialSendBit1();  // Register 0xF
    rx5808SerialSendBit1();
    rx5808SerialSendBit1();
    rx5808SerialSendBit1();

    rx5808SerialSendBit1();  // Write to register

    for (uint8_t i = 20; i > 0; i--)
        rx5808SerialSendBit0();

    rx5808SerialEnableHigh();  // Finished clocking data in
}

// Set power options on the rx5808 module
void RX5808::setRxModulePower(uint32_t options) {
    rx5808SerialEnableHigh();
    rx5808SerialEnableLow();

    rx5808SerialSendBit0();  // Register 0xA
    rx5808SerialSendBit1();
    rx5808SerialSendBit0();
    rx5808SerialSendBit1();

    rx5808SerialSendBit1();  // Write to register

    for (uint8_t i = 20; i > 0; i--) {
        if (options & 0x1) {  // Is bit high or low?
            rx5808SerialSendBit1();
        } else {
            rx5808SerialSendBit0();
        }
        options >>= 1;  // Shift bits along to check the next one
    }

    rx5808SerialEnableHigh();  // Finished clocking data in

    digitalWrite(rx5808DataPin, LOW);
}

// Power down rx5808 module
void RX5808::powerDownRxModule() {
    setRxModulePower(0b11111111111111111111);
}

// Set up rx5808 module (disabling unused features to save some power)
void RX5808::setupRxModule() {
    setRxModulePower(0b11010000110111110011);
}

// Calculate rx5808 register hex value for given frequency in MHz
uint16_t RX5808::freqMhzToRegVal(uint16_t freqInMhz) {
    uint16_t tf, N, A;
    tf = (freqInMhz - 479) / 2;
    N = tf / 32;
    A = tf % 32;
    return (N << (uint16_t)7) + A;
}
