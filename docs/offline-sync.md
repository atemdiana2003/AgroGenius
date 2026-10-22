# Offline synchronization contract

The API supports safe retries; it does not implement a browser cache, IndexedDB, service worker, or offline UI. The future PWA must keep drafts and a durable outbox locally. Display `Saved on this device`, `Waiting to sync`, `Synced`, and `Sync failed` distinctly. Mark `Synced` only after a successful server response that follows a committed transaction.

## Recommended sequence

1. Create the draft locally with a UUID `clientOperationId`, entity, operation, payload, and local timestamp.
2. On connectivity, obtain/refresh auth, then send the request with `Idempotency-Key` equal to the saved operation ID (or body `clientOperationId` where defined).
3. A first committed operation returns 201 and `Idempotency-Replayed: false`. Record the response and remove/mark the outbox item synced.
4. If the connection drops after commit, retry the identical payload/key. The server returns the original stored response and `Idempotency-Replayed: true`, without repeating the transaction's effects.
5. For `409 VERSION_CONFLICT`, retain both local draft and returned safe current-version details; ask the user to review/reconcile. Do not overwrite automatically.
6. For `409 TRANSACTION_CONFLICT`, retry with the same key using bounded backoff. `400/401/403/404` require user correction/re-auth and should not retry blindly. `429/5xx` use exponential backoff and a visible queued state.

An operation that reaches the idempotency transaction and fails with a business/constraint error is recorded as `FAILED` or `CONFLICT` after its business transaction rolls back. Query `/api/sync/operations/:clientOperationId` for the safe state/error code. Replaying a failed/conflicted key does not run it again; after correcting the request or resolving the conflict, submit a new operation ID. Input rejected before the route enters idempotent processing has no operation record. A transient `409 TRANSACTION_CONFLICT` remains retryable with the same key.

Example:

```http
POST /api/readings
Authorization: Bearer <access-token>
Idempotency-Key: 6873aa9d-b1c4-47f4-b1a5-78c6742a1f0b
Content-Type: application/json

{
  "batchId": "e1b7b7c9-6518-4e27-bfb6-88871baeb8de",
  "recordedAt": "2026-10-21T08:00:00.000Z",
  "temperatureC": 22.4,
  "relativeHumidityPercent": 83,
  "source": "MANUAL",
  "clientOperationId": "6873aa9d-b1c4-47f4-b1a5-78c6742a1f0b"
}
```

`SyncOperation` stores actor, operation ID, entity/operation, request fingerprint, state, safe error code, and committed result. A key reused with a different payload/entity/operation returns `409 IDEMPOTENCY_KEY_REUSED`. Database unique constraints protect actor+operation ID and alert deduplication. The helper supports batch/listing/offer/price/reading/quality create paths where a key is supplied; other mutations rely on `expectedVersion` or database state. Do not assume every API write has replay storage.

Access tokens expire; call `/api/auth/refresh` when online. Browser refresh cookie is HttpOnly/SameSite=Lax; offline requests cannot renew it. Keep any outbox payload protected from other users of a shared device and provide logout/account isolation. Contact details and auth secrets should not be persisted in drafts. SMS cannot be sent until internet/network and a configured SMS provider are reachable.
