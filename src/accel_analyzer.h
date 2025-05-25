#ifndef ACCEL_ANALYZER_H
#define ACCEL_ANALYZER_H
#include <cmath>
#include <cstddef>
#include <vector>

// 通用的环形缓冲区模板，底层用std::vector管理内存

template <typename T> class Ring {
public:
  Ring(size_t size) : buf(size), capacity(size), head(0), count(0) {}
  void push(const T &v) {
    buf[head] = v;
    head = (head + 1) % capacity;
    if (count < capacity)
      ++count;
  }
  size_t size() const { return count; }
  size_t max_size() const { return capacity; }
  T operator[](size_t i) const { // 0为最旧，count-1为最新
    if (i >= count)
      return T();
    size_t idx = (head + capacity - count + i) % capacity;
    return buf[idx];
  }

private:
  std::vector<T> buf;
  size_t capacity;
  size_t head;
  size_t count;
};

class AccelAnalyzer {
public:
  // 构造函数，historySize为分析窗口长度，stillThreshold为静止判定阈值（g），jumpThreshold为跳变判定阈值（g）
  AccelAnalyzer(size_t historySize = 50, float stillThreshold = 0.03f,
                float jumpThreshold = 0.5f);

  // 添加一条新的总加速度数据
  void addSample(float totalAccel);

  // 判断过去一段时间是否静止
  bool isStill() const;

  // 判断过去一段时间是否有跳变
  bool hasJump() const;

  // 可选：设置参数
  void setStillThreshold(float threshold);
  void setJumpThreshold(float threshold);
  void setHistorySize(size_t size);

private:
  Ring<float> history;
  float stillThreshold;
  float jumpThreshold;
};

#endif // ACCEL_ANALYZER_H
