#ifndef GPS_SCHEDULER_H
#define GPS_SCHEDULER_H

#include <stdint.h>

class GpsScheduler {
public:
  GpsScheduler();

  unsigned long getFixInterval() const;
  unsigned long getMinPowerOnTime() const;
  unsigned long getFixAttemptTimeout() const;

  // Report the status of the last fix attempt
  void reportFixStatus(bool successful);

  // Update current speed for dynamic adjustments
  void updateSpeed(float currentSpeedKmph);

private:
  unsigned long currentFixInterval;
  unsigned long currentMinPowerOnTime;
  unsigned long currentFixAttemptTimeout;

  int consecutiveFailedAttempts;
  float lastKnownSpeedKmph;

  // Configuration for scheduling logic
  static constexpr unsigned long DEFAULT_FIX_INTERVAL = 10000; // Default: 10s
  static constexpr unsigned long DEFAULT_MIN_POWER_ON_TIME =
      1500; // Default: 1.5s
  static constexpr unsigned long DEFAULT_FIX_ATTEMPT_TIMEOUT =
      30000;                                                // Default: 30s
  static constexpr unsigned long MAX_FIX_INTERVAL = 120000; // Max: 120s
  static constexpr int MAX_FAILED_ATTEMPTS_BEFORE_MAX_INTERVAL =
      5; // Increase interval up to 5 failures
  static constexpr float HIGH_SPEED_THRESHOLD_KMPH = 20.0f; // e.g., 20 km/h
  static constexpr unsigned long HIGH_SPEED_FIX_INTERVAL =
      5000; // 5s for high speed
  static constexpr unsigned long HIGH_SPEED_MIN_POWER_ON_TIME =
      1500; // 1s for high speed

  // Internal logic to adjust parameters
  void adjustParameters();
};

#endif // GPS_SCHEDULER_H
