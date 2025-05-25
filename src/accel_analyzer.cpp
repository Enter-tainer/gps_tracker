#include "accel_analyzer.h"
#include "cmath"
#include "logger.h"
#include <algorithm>

AccelAnalyzer::AccelAnalyzer(size_t historySize, float stillThreshold,
                             float jumpThreshold)
    : history(historySize), stillThreshold(stillThreshold),
      jumpThreshold(jumpThreshold) {}

void AccelAnalyzer::addSample(float totalAccel) { history.push(totalAccel); }

bool AccelAnalyzer::isStill() const {
  if (history.size() == 0)
    return false;
  float minVal = history[0], maxVal = history[0];
  for (size_t i = 1; i < history.size(); ++i) {
    if (history[i] < minVal)
      minVal = history[i];
    if (history[i] > maxVal)
      maxVal = history[i];
  }
  // Log.print("Min: ");
  // Log.print(minVal);
  // Log.print(", Max: ");
  // Log.print(maxVal);
  // Log.print(", Still Threshold: ");
  // Log.println(stillThreshold);
  return (maxVal - minVal) < stillThreshold;
}

bool AccelAnalyzer::hasJump() const {
  if (history.size() < 2)
    return false;
  auto last_accel = history[history.size() - 1];
  auto second_last_accel = history[history.size() - 2];
  auto diff = abs(last_accel - second_last_accel);
  if (diff > jumpThreshold || last_accel < 0.2f) {
    return true;
  }
  return false;
}

void AccelAnalyzer::setStillThreshold(float threshold) {
  stillThreshold = threshold;
}

void AccelAnalyzer::setJumpThreshold(float threshold) {
  jumpThreshold = threshold;
}

void AccelAnalyzer::setHistorySize(size_t size) { history = Ring<float>(size); }
