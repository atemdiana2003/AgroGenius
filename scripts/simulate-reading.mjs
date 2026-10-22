import { randomUUID } from 'node:crypto';

const [, , batchId, token] = process.argv;
const baseUrl = process.env.API_BASE_URL ?? 'http://localhost:3000';

if (!batchId || !token) {
  console.error('Usage: npm run simulate:reading -- <batchId> <accessToken>');
  process.exit(2);
}

const payload = {
  batchId,
  recordedAt: new Date().toISOString(),
  temperatureC: Number((20 + Math.random() * 8).toFixed(2)),
  relativeHumidityPercent: Number((70 + Math.random() * 20).toFixed(2)),
  source: 'SIMULATED',
  clientOperationId: randomUUID(),
};

const response = await fetch(`${baseUrl}/api/readings`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'idempotency-key': payload.clientOperationId,
  },
  body: JSON.stringify(payload),
});
const body = await response.json();
console.log(JSON.stringify({ simulated: true, status: response.status, result: body }, null, 2));
if (!response.ok) process.exitCode = 1;
