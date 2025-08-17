#include "gps_handler.h"
#include "casic_gps_wrapper.h" // For CASIC protocol support
#include "config.h"
#include "gpx_logger.h"  // For appendGpxPoint
#include "logger.h"      // For Log
#include "system_info.h" // For gSystemInfo and GpsState_t
#include <Arduino.h>
#include <stdint.h> // For uint32_t, int32_t
#include <vector>   // For AGNSS message queue

// --- State Machine Constants (as per state_spec.md, kept internal to
// gps_handler.cpp) ---
static const unsigned long T_ACTIVE_SAMPLING_INTERVAL = 1 * 1000UL; // 1 seconds
// ACCEL_STILL_THRESHOLD is used by accel_handler, gSystemInfo.isStationary
// reflects its outcome
static const unsigned long T_STILLNESS_CONFIRM_DURATION =
    60 * 1000UL;                                       // 60 seconds
static const float GPS_SPEED_VEHICLE_THRESHOLD = 5.0f; // 5 km/h
static const unsigned long T_GPS_QUERY_TIMEOUT_FOR_STILLNESS =
    5 * 1000UL; // 5 seconds
static const unsigned long T_GPS_COLD_START_FIX_TIMEOUT =
    90 * 1000UL; // 90 seconds
static const unsigned long T_GPS_REACQUIRE_FIX_TIMEOUT =
    30 * 1000UL; // 30 seconds
static const unsigned long T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL =
    15 * 60 * 1000UL; // 15 minutes
// AGNSS related constants
static const unsigned long T_AGNSS_MESSAGE_SEND_TIMEOUT = 1;     // 1 seconds
static const unsigned long T_AGNSS_TOTAL_TIMEOUT = 60 * 10000UL; // 60 seconds
static const uint8_t MAX_AGNSS_MESSAGE_RETRY = 3;                // 3 retries
static std::vector<std::vector<uint8_t>> AGNSS_Message_Queue;

// --- GPS objects and internal state variables ---
CasicGpsWrapper gpsWrapper; // CASIC GPS wrapper that includes TinyGPS++
HardwareSerial &gpsSerial = GPS_SERIAL; // Use definition from config.h

// Structure to hold position data, similar to the old one but might not be
// strictly needed if gSystemInfo is always up-to-date before logging.
struct PositionResult {
  uint32_t timestamp{0};
  double latitude{0};
  double longitude{0};
  double altitude_m{0};
  double hdop{1e9};
};
static PositionResult last_successful_position =
    PositionResult{}; // Still useful for logging the *last good* fix

// Internal Timers for State Machine (timestamps of when the timer period
// started)
static unsigned long Stillness_Confirm_Timer_Start = 0;
static unsigned long Active_Sampling_Timer_Start = 0;
static unsigned long Fix_Attempt_Timer_Start = 0;
static unsigned long Periodic_Wake_Timer_Start = 0;
static unsigned long GPS_Query_Timeout_Timer_S4_Start = 0;
static bool isGpsPoweredOn = false;

static uint8_t Consecutive_Fix_Failures_Counter = 0;
// AGNSS related variables
static unsigned long AGNSS_Message_Timer_Start = 0;
static unsigned long AGNSS_Total_Timer_Start = 0;
static bool AGNSS_Request_Pending = true; // Flag to indicate AGNSS request
static size_t AGNSS_Current_Message_Index = 0;
static uint8_t AGNSS_Current_Message_Retry_Count = 0;
static GpsState_t AGNSS_Previous_State = S2_IDLE_GPS_OFF;
// Tracks if the *very first* fix attempt (cold start) has been tried since init
// or a long sleep. This helps decide T_GPS_COLD_START_FIX_TIMEOUT vs
// T_GPS_REACQUIRE_FIX_TIMEOUT.
static bool isFirstFixAttemptCycle = true;

// --- Helper Function to reset all timers (used when changing states often) ---
static void resetAllStateTimers() {
  Stillness_Confirm_Timer_Start = 0;
  Active_Sampling_Timer_Start = 0;
  Fix_Attempt_Timer_Start = 0;
  Periodic_Wake_Timer_Start = 0;
  GPS_Query_Timeout_Timer_S4_Start = 0;
  AGNSS_Message_Timer_Start = 0;
  AGNSS_Total_Timer_Start = 0;
}

// --- Function to explicitly power on the GPS module ---
void powerOnGPS() {
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  digitalWrite(PIN_GPS_EN, HIGH); // Assuming HIGH turns GPS ON
  Log.println("GPS Power ON");
  isGpsPoweredOn = true; // Track that GPS is powered on
  delay(100);            // Small delay for module to stabilize
#else
  Log.println("Warning: PIN_GPS_EN not defined. Cannot control GPS power.");
#endif
}

// --- Function to explicitly power off the GPS module ---
void powerOffGPS() {
#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
  digitalWrite(PIN_GPS_EN, LOW); // Assuming LOW turns GPS OFF
  Log.println("GPS Power OFF");
  isGpsPoweredOn = false; // Track that GPS is powered off
#else
  Log.println("Warning: PIN_GPS_EN not defined. Cannot control GPS power.");
#endif
  // Reset GPS data when turning off to avoid showing stale data
  gpsWrapper.reset(); // Clears internal TinyGPS++ state and CASIC parser
  // Explicitly clear relevant gSystemInfo fields related to current fix
  gSystemInfo.locationValid = false;
  gSystemInfo.dateTimeValid = false;
  gSystemInfo.latitude = 0.0;
  gSystemInfo.longitude = 0.0;
  gSystemInfo.altitude = 0.0f;
  gSystemInfo.satellites = 0;
  gSystemInfo.hdop = 99.9f;
  gSystemInfo.speed = -1.0f;
  gSystemInfo.course = -1.0f;
  gSystemInfo.year = 0;
  gSystemInfo.month = 0;
  gSystemInfo.day = 0;
  gSystemInfo.hour = 0;
  gSystemInfo.minute = 0;
  gSystemInfo.second = 0;
}

// --- AGNSS related helper functions ---
static void initAgnssVariables() {
  AGNSS_Current_Message_Index = 0;
  AGNSS_Current_Message_Retry_Count = 0;
  AGNSS_Message_Timer_Start = 0;
  AGNSS_Total_Timer_Start = 0;
}

static void sendCurrentAgnssMessage() {
  if (AGNSS_Current_Message_Index < AGNSS_Message_Queue.size()) {
    const auto &message = AGNSS_Message_Queue[AGNSS_Current_Message_Index];
    auto len = gpsSerial.write(message.data(), message.size());
    if (len != message.size()) {
      Log.printf(
          "AGNSS: Failed to send message %d, expected %d bytes, sent %d\n",
          (int)AGNSS_Current_Message_Index, (int)message.size(), (int)len);
      AGNSS_Current_Message_Retry_Count++;
    } else {
      Log.printf("AGNSS: Successfully sent message %d, size %d bytes\n",
                 (int)AGNSS_Current_Message_Index, (int)len);
    }
    Log.printf("AGNSS: Sent message %d/%d (retry %d)\n",
               (int)(AGNSS_Current_Message_Index + 1),
               (int)AGNSS_Message_Queue.size(),
               AGNSS_Current_Message_Retry_Count);
  }
}

// Helper function to check if AGNSS should be triggered
static bool shouldTriggerAgnss() {
  return millis() > 10 * 1000 && AGNSS_Request_Pending &&
         !AGNSS_Message_Queue.empty() &&
         gSystemInfo.gpsState != S5_AGNSS_PROCESSING;
}

static void transitionBackFromAgnss(unsigned long now) {
  // Clean up AGNSS state
  AGNSS_Message_Queue.clear();
  initAgnssVariables();

  // Transition back based on previous state
  switch (AGNSS_Previous_State) {
  case S1_GPS_SEARCHING_FIX:
    Fix_Attempt_Timer_Start = now;
    gSystemInfo.gpsState = S1_GPS_SEARCHING_FIX;
    Log.println("GPS State: S5 -> S1_GPS_SEARCHING_FIX (AGNSS complete)");
    break;
  case S2_IDLE_GPS_OFF:
    powerOffGPS();
    Periodic_Wake_Timer_Start = now;
    gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
    Log.println("GPS State: S5 -> S2_IDLE_GPS_OFF (AGNSS complete)");
    break;
  case S3_TRACKING_FIXED:
    Active_Sampling_Timer_Start = now;
    gSystemInfo.gpsState = S3_TRACKING_FIXED;
    Log.println("GPS State: S5 -> S3_TRACKING_FIXED (AGNSS complete)");
    break;
  case S4_ANALYZING_STILLNESS:
    GPS_Query_Timeout_Timer_S4_Start = now;
    gSystemInfo.gpsState = S4_ANALYZING_STILLNESS;
    Log.println("GPS State: S5 -> S4_ANALYZING_STILLNESS (AGNSS complete)");
    break;
  default:
    // Fallback to idle state
    powerOffGPS();
    Periodic_Wake_Timer_Start = now;
    gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
    Log.println("GPS State: S5 -> S2_IDLE_GPS_OFF (AGNSS fallback)");
    break;
  }
}

// --- Public function to set AGNSS message queue ---
void setAgnssMessageQueue(const std::vector<std::vector<uint8_t>> &messages) {
  AGNSS_Message_Queue = messages;
  if (!messages.empty()) {
    AGNSS_Request_Pending = true;
    Log.printf("AGNSS: Message queue set with %d messages, request pending\n",
               (int)messages.size());
  }
}

// --- Public function to trigger AGNSS processing ---
void triggerAgnssProcessing() {
  if (AGNSS_Message_Queue.empty()) {
    Log.println("AGNSS: No messages in queue, ignoring trigger");
    return;
  }

  if (gSystemInfo.gpsState == S5_AGNSS_PROCESSING) {
    Log.println("AGNSS: Already in AGNSS processing state");
    return;
  }

  unsigned long now = millis();
  AGNSS_Previous_State = gSystemInfo.gpsState;
  AGNSS_Request_Pending = false; // Clear the request flag

  Log.printf("AGNSS: Triggering processing, previous state: %d\n",
             AGNSS_Previous_State);

  // Stop current state timers
  resetAllStateTimers();

  // Ensure GPS is powered on
  if (!isGpsPoweredOn) {
    powerOnGPS();
  }

  // Initialize AGNSS processing
  initAgnssVariables();
  AGNSS_Total_Timer_Start = now;

  // Send first message
  sendCurrentAgnssMessage();
  AGNSS_Message_Timer_Start = now;

  gSystemInfo.gpsState = S5_AGNSS_PROCESSING;
  Log.printf("GPS State: %d -> S5_AGNSS_PROCESSING (AGNSS triggered)\n",
             AGNSS_Previous_State);
}

// --- Function to initialize GPS communication and power pin ---
void initGPS() {
  gSystemInfo.gpsState = S0_INITIALIZING;
  Log.println("GPS State: S0_INITIALIZING");

  // Hardware reset for GPS module (if LORA_RESET is also for GPS)
#ifdef LORA_RESET // Assuming LORA_RESET might be used for GPS too, or a
                  // dedicated GPS_RESET_PIN
  pinMode(LORA_RESET, OUTPUT);
  digitalWrite(LORA_RESET, LOW);
  delay(100);
  digitalWrite(LORA_RESET, HIGH);
  Log.println("GPS Module Reset via LORA_RESET pin.");
#else
  Log.println("Warning: LORA_RESET (for GPS) not defined.");
#endif

  gpsSerial.begin(GPS_DEFAULT_BAUD_RATE);
  gpsSerial.println("$PCAS04,7*1E"); // Configure for Beidou + GPS + GLONASS
  gpsSerial.println("$PCAS03,1,0,0,0,1,0,0,0,0,0,,,0,0*02"); // GGA + RMC
  gpsSerial.flush();                 // Ensure all data is sent
  delay(1500);                       // Wait for GPS module to process config
  gpsSerial.println("$PCAS01,5*19"); // 115200 baud rate
  gpsSerial.flush();                 // Ensure all data is sent
  gpsSerial.end();
  delay(1500);
  gpsSerial.begin(GPS_BAUD_RATE); // Reinitialize with new baud rate
  for (int i = 0; i < 4; i++) {
    // gpsSerial.println("$PCAS02,100*1E");
    gpsSerial.println("$PCAS02,500*1A");
    delay(100);
  }
  Log.println("GPS Serial Initialized, NMEA configured.");

#ifdef PIN_GPS_EN
  pinMode(PIN_GPS_EN, OUTPUT);
#endif

  // E0.1_Initialization_Complete: Default to power-saving start ->
  // S2_IDLE_GPS_OFF
  powerOffGPS();
  resetAllStateTimers();
  Periodic_Wake_Timer_Start = millis(); // Start periodic wake timer
  isFirstFixAttemptCycle = true;        // Next fix attempt will be a cold start
  gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
  Log.println("GPS State: S0 -> S2_IDLE_GPS_OFF. Init complete.");
}

// --- Function to update the global gSystemInfo struct from TinyGPSPlus data
// ---
void updateGpsSystemInfo() {
  TinyGPSPlus &gps =
      gpsWrapper.getTinyGPS(); // Get TinyGPS++ instance from wrapper

  // Enhanced location validity check including HDOP and datetime
  bool locationValid = gps.location.isValid();
  bool dateTimeValid = gps.date.isValid() && gps.time.isValid();
  bool hdopValid = gps.hdop.isValid() &&
                   (gps.hdop.value() / 100.0f <= MIN_HDOP_FOR_VALID_FIX);
  bool satellitesValid =
      gps.satellites.isValid() && (gps.satellites.value() >= 4);

  gSystemInfo.locationValid =
      locationValid && dateTimeValid && hdopValid && satellitesValid;
  gSystemInfo.dateTimeValid = dateTimeValid;

  if (gSystemInfo.locationValid) {
    gSystemInfo.latitude = gps.location.lat();
    gSystemInfo.longitude = gps.location.lng();
    gSystemInfo.satellites = gps.satellites.value();
    gSystemInfo.altitude = gps.altitude.meters();
  } else {
    // Keep old values or reset? Spec implies reset if invalid.
    gSystemInfo.latitude = 0.0;
    gSystemInfo.longitude = 0.0;
    gSystemInfo.satellites =
        gps.satellites.isValid() ? gps.satellites.value() : 0;
    gSystemInfo.altitude = 0.0f;
  }

  if (gps.hdop.isValid()) {
    gSystemInfo.hdop = gps.hdop.value() / 100.0f;
  } else {
    gSystemInfo.hdop = 99.9f;
  }

  if (gps.speed.isValid()) {
    gSystemInfo.speed = gps.speed.kmph();
  } else {
    gSystemInfo.speed = -1.0f; // Invalid speed
  }

  if (gps.course.isValid()) {
    gSystemInfo.course = gps.course.deg();
  } else {
    gSystemInfo.course = -1.0f; // Invalid course
  }

  gSystemInfo.dateTimeValid = gps.date.isValid() && gps.time.isValid();
  if (gSystemInfo.dateTimeValid) {
    gSystemInfo.year = gps.date.year();
    gSystemInfo.month = gps.date.month();
    gSystemInfo.day = gps.date.day();
    gSystemInfo.hour = gps.time.hour();
    gSystemInfo.minute = gps.time.minute();
    gSystemInfo.second = gps.time.second();
  } else {
    gSystemInfo.year = 0;
    gSystemInfo.month = 0;
    gSystemInfo.day = 0;
    gSystemInfo.hour = 0;
    gSystemInfo.minute = 0;
    gSystemInfo.second = 0;
  }
}

// --- Helper function to convert GPS date/time to an approximate Unix timestamp
// ---
uint32_t dateTimeToUnixTimestamp(uint16_t year, uint8_t month, uint8_t day,
                                 uint8_t hour, uint8_t minute, uint8_t second) {
  if (year < 1970 || year > 2038)
    return 0;
  uint32_t days = (year - 1970) * 365;
  for (uint16_t y = 1972; y < year; y += 4)
    days++;                      // Add leap year days
  bool isLeap = (year % 4 == 0); // Simplified leap year check
  if (isLeap && month > 2)
    days++;
  const uint8_t daysInMonth[] = {0,  31, 28, 31, 30, 31, 30,
                                 31, 31, 30, 31, 30, 31};
  for (uint8_t m = 1; m < month; m++)
    days += daysInMonth[m];
  days += (day - 1);
  uint32_t seconds_val = days * 86400UL;
  seconds_val += hour * 3600UL;
  seconds_val += minute * 60UL;
  seconds_val += second;
  return seconds_val;
}

// --- Function to handle GPS state, data reading, parsing, power, and updating
// gSystemInfo ---
void handleGPS() {
  unsigned long now = millis();
  if (isGpsPoweredOn) {
    while (gpsSerial.available() > 0) {
      char byte = gpsSerial.read();
      // Log.print(byte);
      if (gpsWrapper.encode(byte)) {
        updateGpsSystemInfo();

        // 检查是否有新的CASIC数据
        if (gpsWrapper.isNewCasicData()) {
          CasicPacket packet = gpsWrapper.getLastCasicPacket();
          Log.printf("Received CASIC packet: Class=0x%02X, ID=0x%02X, Len=%d\n",
                     packet.class_id, packet.msg_id, packet.payload_length);

          // 非AGNSS状态下的常规处理（AGNSS状态下的处理在switch语句中进行）
          if (gSystemInfo.gpsState != S5_AGNSS_PROCESSING) {
            if (gpsWrapper.hasNewAck()) {
              Log.println("GPS ACK received");
            } else if (gpsWrapper.hasNewNack()) {
              Log.println("GPS NACK received (treating as ACK)");
            } else if (gpsWrapper.hasNewEphemeris()) {
              Log.println("GPS Ephemeris data received");
            }
            // 只在非AGNSS状态下清理数据
            gpsWrapper.clearCasicData();
          }
          // AGNSS状态下不清理数据，让switch语句中的逻辑处理
        }
      }
    }
  }

  switch (gSystemInfo.gpsState) {
  case S0_INITIALIZING: { // Should have transitioned out during initGPS(). If
                          // stuck, force to S2.
    Log.println("Warning: Still in S0_INITIALIZING in handleGPS. Forcing S2.");
    powerOffGPS();
    resetAllStateTimers();
    Periodic_Wake_Timer_Start = now;
    isFirstFixAttemptCycle = true;
    gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
    break;
  }
  case S1_GPS_SEARCHING_FIX: { // Entry Actions (should be done when
                               // transitioning TO this state, but
    // double check if timer started)
    if (Fix_Attempt_Timer_Start == 0) {
      Log.println("S1: Fix_Attempt_Timer was 0, starting now.");
      Fix_Attempt_Timer_Start = now;
    }
    if (!isGpsPoweredOn)
      powerOnGPS(); // Ensure GPS is ON

    // E1.1_GPS_Fix_Acquired
    if (gSystemInfo.locationValid) {
      Log.println("GPS State: S1 -> S3_TRACKING_FIXED (Fix Acquired)");
      resetAllStateTimers();
      Active_Sampling_Timer_Start = now;
      Consecutive_Fix_Failures_Counter = 0;
      isFirstFixAttemptCycle =
          false; // A fix was successful, subsequent ones are reacquires until
                 // next long sleep/init

      last_successful_position.timestamp = dateTimeToUnixTimestamp(
          gSystemInfo.year, gSystemInfo.month, gSystemInfo.day,
          gSystemInfo.hour, gSystemInfo.minute, gSystemInfo.second);
      last_successful_position.latitude = gSystemInfo.latitude;
      last_successful_position.longitude = gSystemInfo.longitude;
      last_successful_position.altitude_m = gSystemInfo.altitude;
      last_successful_position.hdop = gSystemInfo.hdop;

      gSystemInfo.gpsState = S3_TRACKING_FIXED;
      break; // Exit switch case for this iteration
    }

    // E1.2_Fix_Attempt_Timer_Expired
    unsigned long current_fix_timeout = isFirstFixAttemptCycle
                                            ? T_GPS_COLD_START_FIX_TIMEOUT
                                            : T_GPS_REACQUIRE_FIX_TIMEOUT;
    if (now - Fix_Attempt_Timer_Start >= current_fix_timeout) {
      Log.printf("S1: Fix Attempt Timer Expired (%lu ms). Failures: %d\n",
                 current_fix_timeout, Consecutive_Fix_Failures_Counter + 1);
      Consecutive_Fix_Failures_Counter++;
      if (Consecutive_Fix_Failures_Counter >= MAX_CONSECUTIVE_FIX_FAILURES) {
        Log.println(
            "Max consecutive fix failures reached. Sending GPS warm restart.");
        gpsSerial.println("$PCAS10,1*1D"); // Warm restart command
        Consecutive_Fix_Failures_Counter = 0;
      }
      powerOffGPS();
      resetAllStateTimers();
      Periodic_Wake_Timer_Start = now;
      isFirstFixAttemptCycle = true; // Next attempt after sleep will be cold.
      gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
      Log.println("GPS State: S1 -> S2_IDLE_GPS_OFF (Fix Timeout)");
      break;
    }
    // E1.3 & E1.4 (Motion/Stillness during search) - Not explicitly handled to
    // change S1 behavior in this version.

    // E1.5_AGNSS_Request - Check for pending AGNSS request
    if (shouldTriggerAgnss()) {
      Log.println("GPS State: S1 -> S5_AGNSS_PROCESSING (AGNSS Request)");
      triggerAgnssProcessing();
      break;
    }
    break;
  }
  case S2_IDLE_GPS_OFF: {
    if (Periodic_Wake_Timer_Start == 0) {
      Periodic_Wake_Timer_Start = now;
    } // Safety for timer start
    if (isGpsPoweredOn)
      powerOffGPS(); // Ensure GPS is OFF

    // E2.1_Motion_Detected (gSystemInfo.isStationary is managed by accel
    // handler) If isStationary is false, it means motion is detected.
    if (!gSystemInfo.isStationary) {
      Log.println("GPS State: S2 -> S1_GPS_SEARCHING_FIX (Motion Detected)");
      powerOnGPS();
      resetAllStateTimers();
      Fix_Attempt_Timer_Start = now;
      // isFirstFixAttemptCycle remains true if it was, or false if a fix was
      // ever found before this sleep
      gSystemInfo.gpsState = S1_GPS_SEARCHING_FIX;
      break;
    }

    // E2.2_Periodic_Wake_Timer_Expired
    if (now - Periodic_Wake_Timer_Start >= T_GPS_SLEEP_PERIODIC_WAKE_INTERVAL) {
      Log.println("GPS State: S2 -> S1_GPS_SEARCHING_FIX (Periodic Wake)");
      powerOnGPS();
      resetAllStateTimers();
      Fix_Attempt_Timer_Start = now;
      isFirstFixAttemptCycle =
          true; // Waking from long sleep, assume cold start needed
      gSystemInfo.gpsState = S1_GPS_SEARCHING_FIX;
      break;
    }

    // E2.3_AGNSS_Request - Check for pending AGNSS request
    if (shouldTriggerAgnss()) {
      Log.println("GPS State: S2 -> S5_AGNSS_PROCESSING (AGNSS Request)");
      triggerAgnssProcessing();
      break;
    }
    break;
  }
  case S3_TRACKING_FIXED: {
    if (Active_Sampling_Timer_Start == 0) {
      Active_Sampling_Timer_Start = now;
    } // Safety
    if (!isGpsPoweredOn)
      powerOnGPS(); // Ensure GPS is ON

    // E3.5_GPS_Signal_Lost_Or_Degraded (Primary check)
    if (!gSystemInfo.locationValid) {
      Log.println(
          "GPS State: S3 -> S1_GPS_SEARCHING_FIX (Signal Lost/Degraded)");
      resetAllStateTimers();
      Fix_Attempt_Timer_Start = now;
      // isFirstFixAttemptCycle should be false here, as we were just in S3
      gSystemInfo.gpsState = S1_GPS_SEARCHING_FIX;
      break;
    }

    // E3.1_Active_Sampling_Timer_Expired
    if (now - Active_Sampling_Timer_Start >= T_ACTIVE_SAMPLING_INTERVAL) {
      Log.println("S3: Active Sampling Timer. Logging GPX.");
      // Ensure data is still good before logging (already checked by E3.5, but
      // good practice)
      if (gSystemInfo.locationValid) {
        last_successful_position.timestamp = dateTimeToUnixTimestamp(
            gSystemInfo.year, gSystemInfo.month, gSystemInfo.day,
            gSystemInfo.hour, gSystemInfo.minute, gSystemInfo.second);
        last_successful_position.latitude = gSystemInfo.latitude;
        last_successful_position.longitude = gSystemInfo.longitude;
        last_successful_position.altitude_m = gSystemInfo.altitude;
        last_successful_position.hdop = gSystemInfo.hdop;

        appendGpxPoint(last_successful_position.timestamp,
                       last_successful_position.latitude,
                       last_successful_position.longitude,
                       last_successful_position.altitude_m);
        Log.println("GPX Point logged in S3.");
      }
      Active_Sampling_Timer_Start = now; // Restart timer
    }

    // E3.2_Motion_Sensed / E3.3_Potential_Stillness_Sensed
    if (!gSystemInfo.isStationary) { // Motion
      if (Stillness_Confirm_Timer_Start != 0) {
        Log.println("S3: Motion, Stillness_Confirm_Timer reset.");
        Stillness_Confirm_Timer_Start = 0;
      }
    } else { // Potential Stillness (gSystemInfo.isStationary is true)
      if (Stillness_Confirm_Timer_Start == 0) {
        Log.println(
            "S3: Potential Stillness, Stillness_Confirm_Timer started.");
        Stillness_Confirm_Timer_Start = now;
      }
    }

    // E3.4_Stillness_Confirmed
    if (gSystemInfo.isStationary && Stillness_Confirm_Timer_Start != 0 &&
        (now - Stillness_Confirm_Timer_Start >= T_STILLNESS_CONFIRM_DURATION)) {
      Log.println(
          "GPS State: S3 -> S4_ANALYZING_STILLNESS (Stillness Confirmed)");
      resetAllStateTimers();
      GPS_Query_Timeout_Timer_S4_Start = now;
      gSystemInfo.gpsState = S4_ANALYZING_STILLNESS;
      // GPS remains ON for S4 analysis
      break;
    }

    // E3.6_AGNSS_Request - Check for pending AGNSS request
    if (shouldTriggerAgnss()) {
      Log.println("GPS State: S3 -> S5_AGNSS_PROCESSING (AGNSS Request)");
      triggerAgnssProcessing();
      break;
    }
    break;
  }
  case S4_ANALYZING_STILLNESS: {
    if (GPS_Query_Timeout_Timer_S4_Start == 0) {
      GPS_Query_Timeout_Timer_S4_Start = now;
    } // Safety
    if (!isGpsPoweredOn)
      powerOnGPS(); // Ensure GPS is ON for query

    // E4.1_Motion_Detected_During_Analysis
    if (!gSystemInfo.isStationary) {
      Log.println(
          "GPS State: S4 -> S3_TRACKING_FIXED (Motion during Analysis)");
      resetAllStateTimers();
      Active_Sampling_Timer_Start = now;
      gSystemInfo.gpsState = S3_TRACKING_FIXED;
      break;
    }

    // E4.2_GPS_Query_Results_Received (Implicitly, by checking gSystemInfo now)
    // AND E4.3_GPS_Query_Timeout_Timer_S4_Expired (Handled together)
    bool S4_timeout = (now - GPS_Query_Timeout_Timer_S4_Start >=
                       T_GPS_QUERY_TIMEOUT_FOR_STILLNESS);

    if (S4_timeout || gSystemInfo.locationValid) { // Process if timeout OR if
                                                   // data is valid for decision
      if (!S4_timeout && gSystemInfo.locationValid &&
          gSystemInfo.speed > GPS_SPEED_VEHICLE_THRESHOLD) {
        // Case 1: Traffic stop (vehicle still has GPS speed)
        Log.println("GPS State: S4 -> S3_TRACKING_FIXED (Vehicle Stop Analysis "
                    "- high GPS speed)");
        resetAllStateTimers();
        Active_Sampling_Timer_Start = now;
        gSystemInfo.gpsState = S3_TRACKING_FIXED;
      } else {
        // Case 2: Indoor/Signal Poor OR Outdoor Low Speed Stillness OR S4
        // Timeout
        if (S4_timeout)
          Log.println("S4: Query Timeout.");
        else
          Log.println("S4: Low GPS speed or poor signal.");

        Log.println("GPS State: S4 -> S2_IDLE_GPS_OFF");
        powerOffGPS();
        resetAllStateTimers();
        Periodic_Wake_Timer_Start = now;
        isFirstFixAttemptCycle = true; // Next attempt after sleep will be cold
        gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
      }
      break;
    }
    // If not timed out and location is not yet valid, stay in S4 and wait for
    // GPS data or timeout.

    // E4.4_AGNSS_Request - Check for pending AGNSS request
    if (shouldTriggerAgnss()) {
      Log.println("GPS State: S4 -> S5_AGNSS_PROCESSING (AGNSS Request)");
      triggerAgnssProcessing();
      break;
    }
    break;
  }
  case S5_AGNSS_PROCESSING: {
    if (AGNSS_Total_Timer_Start == 0) {
      AGNSS_Total_Timer_Start = now;
    } // Safety for timer start
    if (!isGpsPoweredOn)
      powerOnGPS(); // Ensure GPS is ON

    // E5.1_AGNSS_ACK_or_NACK_Received (both treated as ACK)
    if (gpsWrapper.isNewCasicData() &&
        (gpsWrapper.hasNewAck() || gpsWrapper.hasNewNack())) {
      if (gpsWrapper.hasNewAck()) {
        Log.println("S5: ACK received for AGNSS message");
      } else {
        Log.println("S5: NACK received for AGNSS message (treating as ACK)");
      }
      gpsWrapper.clearCasicData();   // 立即清理数据
      AGNSS_Message_Timer_Start = 0; // Stop message timer
      AGNSS_Current_Message_Index++;
      AGNSS_Current_Message_Retry_Count = 0;

      if (AGNSS_Current_Message_Index >= AGNSS_Message_Queue.size()) {
        // All AGNSS messages successfully sent
        Log.println("S5: All AGNSS messages sent successfully");
        transitionBackFromAgnss(now);
      } else {
        // Send next AGNSS message
        sendCurrentAgnssMessage();
        AGNSS_Message_Timer_Start = now;
      }
      break;
    }

    // E5.3_AGNSS_Message_Timer_Expired
    if (AGNSS_Message_Timer_Start != 0 &&
        now - AGNSS_Message_Timer_Start >= T_AGNSS_MESSAGE_SEND_TIMEOUT) {
      Log.println("S5: AGNSS message timer expired");
      AGNSS_Current_Message_Retry_Count++;

      if (AGNSS_Current_Message_Retry_Count >= MAX_AGNSS_MESSAGE_RETRY) {
        // Max retries reached, AGNSS processing failed
        Log.println(
            "S5: Max retries reached after timeout, AGNSS processing failed");
        transitionBackFromAgnss(now);
      } else {
        // Retry sending current AGNSS message
        Log.printf("S5: Retrying AGNSS message after timeout (attempt %d/%d)\n",
                   AGNSS_Current_Message_Retry_Count + 1,
                   MAX_AGNSS_MESSAGE_RETRY);
        sendCurrentAgnssMessage();
        AGNSS_Message_Timer_Start = now;
      }
      break;
    }

    // E5.4_AGNSS_Total_Timer_Expired
    if (now - AGNSS_Total_Timer_Start >= T_AGNSS_TOTAL_TIMEOUT) {
      Log.println("S5: AGNSS total timer expired, forcing completion");
      transitionBackFromAgnss(now);
      break;
    }

    // E5.5_Motion_Detected_During_AGNSS
    if (!gSystemInfo.isStationary) {
      // Motion detected during AGNSS processing
      // Update previous state to motion-related state for proper return
      if (AGNSS_Previous_State == S2_IDLE_GPS_OFF ||
          AGNSS_Previous_State == S4_ANALYZING_STILLNESS) {
        AGNSS_Previous_State =
            S3_TRACKING_FIXED; // Motion detected, should return to tracking
      }
      // Log motion but continue AGNSS processing
      Log.println("S5: Motion detected during AGNSS processing");
    }

    break;
  }
  default: {
    Log.printf("Error: Unknown GPS State (%d)! Resetting to S2_IDLE_GPS_OFF\n",
               gSystemInfo.gpsState);
    powerOffGPS();
    resetAllStateTimers();
    Periodic_Wake_Timer_Start = now;
    isFirstFixAttemptCycle = true;
    gSystemInfo.gpsState = S2_IDLE_GPS_OFF;
    break;
  }
  }
}
