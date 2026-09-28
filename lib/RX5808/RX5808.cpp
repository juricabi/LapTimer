#include "RX5808.h"

#include <Arduino.h>

#include "debug.h"

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
    digitalWrite(rx5808SelPin, HIGH);
    digitalWrite(rx5808ClkPin, LOW);
    digitalWrite(rx5808DataPin, LOW);
    resetRxModule();
    setFrequency(POWER_DOWN_FREQ_MHZ);
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
        resetRxModule();
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

// Read the RSSI value. The caller (LapTimer::scan) waits for the receiver to settle after tuning.
uint8_t RX5808::readRssiRaw() {
    volatile uint16_t rssi = 0;

    // for (uint8_t i = 0; i < RSSI_READS; i++) {
    //   rssi += map(analogRead(rssiInputPin), 0, analogRead(vbatPin), 0, 4095);
    // }

    // rssi = rssi / RSSI_READS; // average of RSSI_READS readings

    // reads 5V value as 0-4095, RX5808 is 3.3V powered so RSSI pin will never output the full range
    rssi = analogRead(rssiInputPin);
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

// Reset rx5808 module to wake up from power down
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

    setupRxModule();
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
