#include <Arduino.h>
#include <Adafruit_SHT31.h>
#include <ArduinoJson.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <Wire.h>
#include <cstring>
#include <time.h>

#include "secrets.h"

namespace {
constexpr uint8_t kQueueCapacity = 16;
constexpr float kMinTemperatureC = -10.0F;
constexpr float kMaxTemperatureC = 60.0F;

struct QueuedReading {
  String operationId;
  String recordedAt;
  float temperatureC;
  float humidityPercent;
};

Adafruit_SHT31 sensor;
QueuedReading queue[kQueueCapacity];
uint8_t queueHead = 0;
uint8_t queueCount = 0;
uint32_t nextReadingAt = 0;
uint32_t nextUploadAt = 0;
uint32_t uploadBackoffMs = 1000;
WiFiClientSecure apiTls;

constexpr uint32_t kMaxUploadBackoffMs = 5UL * 60UL * 1000UL;

String makeOperationId() {
  char output[37];
  const uint32_t a = esp_random();
  const uint32_t b = esp_random();
  const uint32_t c = esp_random();
  const uint32_t d = esp_random();
  snprintf(output, sizeof(output), "%08lx-%04lx-4%03lx-%04lx-%08lx%04lx",
           static_cast<unsigned long>(a),
           static_cast<unsigned long>((b >> 16) & 0xffff),
           static_cast<unsigned long>(b & 0x0fff),
           static_cast<unsigned long>(((c >> 16) & 0x3fff) | 0x8000),
           static_cast<unsigned long>(c & 0xffffffff),
           static_cast<unsigned long>(d & 0xffff));
  return String(output);
}

bool currentUtc(String &output) {
  struct tm timeInfo;
  if (!getLocalTime(&timeInfo, 1000)) return false;
  if (timeInfo.tm_year + 1900 < 2025) return false;
  char buffer[25];
  if (strftime(buffer, sizeof(buffer), "%Y-%m-%dT%H:%M:%SZ", &timeInfo) == 0) return false;
  output = String(buffer);
  return true;
}

void connectWifi() {
  if (WiFi.status() == WL_CONNECTED) return;
  WiFi.mode(WIFI_STA);
  WiFi.begin(HG_WIFI_SSID, HG_WIFI_PASSWORD);
  const uint32_t started = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - started < 15000) {
    delay(250);
  }
}

void enqueueReading() {
  if (queueCount == kQueueCapacity) {
    Serial.println("Offline queue full; dropping the oldest unsent reading.");
    queueHead = static_cast<uint8_t>((queueHead + 1) % kQueueCapacity);
    --queueCount;
  }
  const uint8_t tail = static_cast<uint8_t>((queueHead + queueCount) % kQueueCapacity);
  String timestamp;
  if (!currentUtc(timestamp)) {
    Serial.println("Clock not synchronized; reading not queued.");
    return;
  }
  queue[tail] = {
      makeOperationId(),
      timestamp,
      sensor.readTemperature(),
      sensor.readHumidity(),
  };
  ++queueCount;
}

bool uploadOldest() {
  if (queueCount == 0 || WiFi.status() != WL_CONNECTED ||
      static_cast<int32_t>(millis() - nextUploadAt) < 0) return false;
  QueuedReading &reading = queue[queueHead];
  if (!isfinite(reading.temperatureC) || !isfinite(reading.humidityPercent) ||
      reading.temperatureC < kMinTemperatureC || reading.temperatureC > kMaxTemperatureC ||
      reading.humidityPercent < 0.0F || reading.humidityPercent > 100.0F) {
    Serial.println("Sensor reading outside configured plausibility bounds; dropping.");
    queueHead = static_cast<uint8_t>((queueHead + 1) % kQueueCapacity);
    --queueCount;
    return true;
  }

  JsonDocument body;
  body["batchId"] = HG_BATCH_ID;
  body["sensorId"] = HG_SENSOR_ID;
  body["recordedAt"] = reading.recordedAt;
  body["temperatureC"] = reading.temperatureC;
  body["relativeHumidityPercent"] = reading.humidityPercent;
  body["source"] = "SENSOR";
  body["clientOperationId"] = reading.operationId;
  String serialized;
  serializeJson(body, serialized);

  HTTPClient http;
  const String url = String(HG_API_BASE_URL) + "/device/readings";
  if (!url.startsWith("https://") || strlen(HG_API_ROOT_CA) == 0) {
    Serial.println("Upload blocked: HTTPS API URL and trusted root CA are required.");
    nextUploadAt = millis() + uploadBackoffMs;
    uploadBackoffMs = min(uploadBackoffMs * 2, kMaxUploadBackoffMs);
    return false;
  }
  apiTls.setCACert(HG_API_ROOT_CA);
  http.setTimeout(8000);
  if (!http.begin(apiTls, url)) {
    nextUploadAt = millis() + uploadBackoffMs;
    uploadBackoffMs = min(uploadBackoffMs * 2, kMaxUploadBackoffMs);
    return false;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("Authorization", String("Device ") + HG_DEVICE_TOKEN);
  const int status = http.POST(serialized);
  http.end();
  if (status == 200 || status == 201) {
    queueHead = static_cast<uint8_t>((queueHead + 1) % kQueueCapacity);
    --queueCount;
    uploadBackoffMs = 1000;
    nextUploadAt = millis();
    Serial.println("Reading synchronized.");
    return true;
  }
  Serial.printf("Reading upload failed with HTTP status %d; keeping it queued.\n", status);
  nextUploadAt = millis() + uploadBackoffMs;
  uploadBackoffMs = min(uploadBackoffMs * 2, kMaxUploadBackoffMs);
  return false;
}
}  // namespace

void setup() {
  Serial.begin(115200);
  Wire.begin();
  if (!sensor.begin(0x44)) {
    Serial.println("SHT31 sensor not found at I2C address 0x44.");
  }
  connectWifi();
  configTime(0, 0, "pool.ntp.org", "time.nist.gov");
  nextReadingAt = millis();
}

void loop() {
  connectWifi();
  if (static_cast<int32_t>(millis() - nextReadingAt) >= 0) {
    nextReadingAt = millis() + HG_READING_INTERVAL_MS;
    enqueueReading();
  }
  uploadOldest();
  delay(100);
}
