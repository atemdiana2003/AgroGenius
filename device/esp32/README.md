# ESP32 + SHT31 starter (not hardware verified)

This is an optional starter. It has not been compiled or run on a physical ESP32/SHT31 in this environment. It reads temperature/RH, timestamps using NTP UTC, reconnects Wi-Fi, queues up to 16 readings in RAM, and sends retry-safe device-authenticated requests. A reset/power loss clears the RAM queue; this is not durable storage.

## Setup and wiring

1. Install PlatformIO and open this directory as a PlatformIO project.
2. Connect SHT31 `VIN` to board `3V3`, `GND` to `GND`, `SDA` to GPIO 21 and `SCL` to GPIO 22 (confirm the exact board/sensor breakout documentation; use the correct voltage).
3. Copy `include/secrets.example.h` to `include/secrets.h` locally. Fill Wi-Fi, HTTPS API base URL, trusted root CA PEM, admin-provisioned device token, batch UUID, sensor UUID, and a suitable interval. Never commit that local file.
4. PlatformIO `Build` then `Upload`; inspect serial output. The client requires an `https://` URL and a configured trusted root CA, and fails closed if either is absent.
5. In the API, an administrator creates a storage unit, sensor, and device credential (`POST /api/admin/storage-units`, `/sensors`, `/devices`). Device provisioning returns the raw token once; store it securely on the device. Create a batch for the same farmer/storage unit and supply the IDs.
6. Calibrate/compare against a reference thermometer/hygrometer; record sensor identity, location, calibration method/date and notes. Do not use this sensor for food-safety decisions without appropriate validation.

The device submits `source:SENSOR`, `recordedAt` in UTC, °C, percent RH, and stable `clientOperationId` to `POST /api/device/readings` with `Authorization: Device <token>`. Server validates device-user, sensor, batch-owner and storage-unit relationships. Keep queues small and disable serial token logging in any custom firmware.

TLS certificate validation uses `WiFiClientSecure::setCACert`; never use insecure certificate acceptance in production. Failed uploads use bounded exponential backoff from one second to five minutes. The offline queue remains RAM-only and loses readings on reset/power loss. No firmware compile, real hardware, calibration or connectivity test is claimed.
