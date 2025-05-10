#include "gps_scheduler.h"
#include "config.h" // For initial default values

GpsScheduler::GpsScheduler() {
  // Initialize with default values from config.h
  currentFixInterval = GPS_FIX_INTERVAL;
  currentMinPowerOnTime = GPS_MIN_POWER_ON_TIME;
  currentFixAttemptTimeout = GPS_FIX_ATTEMPT_TIMEOUT;
  consecutiveFailedAttempts = 0;
  lastKnownSpeedKmph = 0.0f;
}

unsigned long GpsScheduler::getFixInterval() const {
  return currentFixInterval;
}

unsigned long GpsScheduler::getMinPowerOnTime() const {
  return currentMinPowerOnTime;
}

unsigned long GpsScheduler::getFixAttemptTimeout() const {
  return currentFixAttemptTimeout;
}

void GpsScheduler::reportFixStatus(bool successful) {
  if (successful) {
    consecutiveFailedAttempts = 0;
  } else {
    lastKnownSpeedKmph = 0.0f; // Reset speed on failure
    consecutiveFailedAttempts++;
  }
  adjustParameters();
}

void GpsScheduler::updateSpeed(float currentSpeedKmph) {
  lastKnownSpeedKmph = currentSpeedKmph;
  adjustParameters();
}

void GpsScheduler::adjustParameters() {
  // Priority 1: High speed overrides other logic for interval and min power on
  // time
  if (lastKnownSpeedKmph > HIGH_SPEED_THRESHOLD_KMPH) {
    currentFixInterval = HIGH_SPEED_FIX_INTERVAL;
    currentMinPowerOnTime = HIGH_SPEED_MIN_POWER_ON_TIME;
  } else {
    // Priority 2: Handle consecutive failures if not high speed
    currentMinPowerOnTime = DEFAULT_MIN_POWER_ON_TIME;
    if (consecutiveFailedAttempts > 0) {
      unsigned long increaseFactor =
          (consecutiveFailedAttempts < MAX_FAILED_ATTEMPTS_BEFORE_MAX_INTERVAL)
              ? consecutiveFailedAttempts
              : MAX_FAILED_ATTEMPTS_BEFORE_MAX_INTERVAL;

      currentFixInterval =
          DEFAULT_FIX_INTERVAL +
          (increaseFactor * 10000UL); // Add 10s per counted failure
      if (currentFixInterval > MAX_FIX_INTERVAL) {
        currentFixInterval = MAX_FIX_INTERVAL;
      }
    } else {
      currentFixInterval = DEFAULT_FIX_INTERVAL;
    }
  }
}
