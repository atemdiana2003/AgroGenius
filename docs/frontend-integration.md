# Frontend integration guide

This is a frontend handoff, not an implementation of the React application. See [apps/web README](../apps/web/README.md) for screen map, mobile/accessibility, and team workflow.

## Connect

Install/use the root npm workspace and import from `@harvestguard/contracts`. Set `VITE_API_BASE_URL=http://localhost:3000/api`. Add the exact browser origin (commonly `http://localhost:5173`) to API `ALLOWED_ORIGINS`. Use `credentials: 'include'` for login, refresh, and logout so the default HttpOnly cookie is stored and sent. Send `Authorization: Bearer <accessToken>` to protected routes. Access token is short-lived; refresh at `/auth/refresh`. Prefer keeping access credential in memory; never put refresh tokens or device keys in frontend source/local storage. Production password reset returns `503 RESET_DELIVERY_UNAVAILABLE` until a real delivery provider is configured.

Non-browser clients that cannot use cookies may send `X-Refresh-Transport: body` on login, refresh, and logout. This explicitly opts into returning/accepting the refresh token in JSON; protect it as a credential and do not use this transport in browser code.

Password-reset UI should handle `503 RESET_DELIVERY_UNAVAILABLE` in production and direct users to the service administrator; do not claim that a reset message was sent.

## Profile, farm, and unit references

Use `GET /me` to load the authenticated profile and its `version`. `PATCH /me` accepts profile/preferences fields and optionally `expectedVersion`; stale versions return `409 VERSION_CONFLICT`. Quiet-hour values use 24-hour `HH:mm`; both boundaries must be set or cleared together. SMS consent and opt-out cannot both be enabled. The response omits password hashes and all authentication tokens. `/auth/me` remains a compatibility alias.

Farm endpoints are farmer-only: `GET|POST /farms` and `GET|PATCH|DELETE /farms/:id`. Coordinates are optional; send both latitude and longitude together, or omit both. Updates can include the returned version as `expectedVersion`; DELETE archives the farm. Other farmers' farms return 404.

Load unit choices from public `GET /units`, not from a duplicated client enum. Only active codes may be used for new records. `KG`, `CRATE`, and `PIECE` are stable pilot codes; the API defines no conversions between them. Unit metadata is administered at `/admin/units`.

## Example calls

Registration:

```ts
import { RegisterSchema } from '@harvestguard/contracts';

const input = RegisterSchema.parse({
  displayName: 'Farmer name',
  phone: '+237670000000',
  password: 'a-unique-long-password',
  role: 'FARMER',
  community: 'Buea',
  smsConsent: false,
});
await fetch(`${import.meta.env.VITE_API_BASE_URL}/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(input),
});
```

Idempotent offline-compatible write:

```ts
const operationId = crypto.randomUUID(); // persist with the IndexedDB outbox item
await fetch(`${import.meta.env.VITE_API_BASE_URL}/readings`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${accessToken}`,
    'content-type': 'application/json',
    'Idempotency-Key': operationId,
  },
  body: JSON.stringify({
    batchId,
    recordedAt: new Date().toISOString(),
    temperatureC: 22.4,
    relativeHumidityPercent: 83,
    source: 'MANUAL',
    clientOperationId: operationId,
  }),
});
```

Example success is `{data: <resource>, meta: {}}`; list `meta` contains `page,pageSize,total`. Errors use `error.code,message,details,requestId`. Validate request inputs using shared Zod schemas, but backend validation/authorization remains authoritative. `409 VERSION_CONFLICT` requires human resolution with safe current-version information. Reuse the same operation ID for safe retry of a request whose response may have been lost. Never assume request queued offline has synchronized.

## Route-to-screen mapping

| Screen                             | API                                                                                                                                          |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Landing/pilot disclaimer           | public `/crops`, `/markets`, `/listings`; communicate pilot limits                                                                           |
| Sign-up/sign-in                    | `/auth/register`, `/auth/login`, `/auth/refresh`, `/auth/logout`; `/auth/password-reset/*`                                                   |
| Farmer dashboard/new batch         | `/me`, `/batches`, `/batches/:id`, `/batches/:id/movements`                                                                                  |
| Storage monitor                    | `/batches/:id/readings`, `/readings`, `/quality-observations`, `/trials/:id/comparison`                                                      |
| Price browser/alerts               | `/prices`, `/price-alert-rules`                                                                                                              |
| Marketplace/details/contact/offers | `/listings`, `/listings/:id`, `/listings/:id/offers`, `/offers`, `/offers/:id`, `/offers/:id/confirm-sale`, `/listings/:id/contact-requests` |
| Notifications                      | `/notifications`, `/notifications/:id`, optional `/notifications/:id/sms`                                                                    |
| Admin                              | `/admin/*`, `/reports`, CSV exports                                                                                                          |

Always show price source, observation timestamp, currency, price unit and freshness. Mark hardware/manual/simulated provenance. Treat experimental threshold notices as prototype warnings, not preservation/safety certification. Public listing response excludes phone/email. The owner must explicitly consent to phone contact and approve a buyer request before the authorized requester can see it.

## Offline, mobile and keyboard

Implement a cached shell and IndexedDB outbox in the PWA. UI states: “Saved on this device”, “Waiting to sync”, “Synced”, and “Sync failed”. Pending drafts are local, not server-confirmed; retain drafts on conflict and ask the user to reconcile. Minimize payload and paginate for low bandwidth; show local time alongside explicit UTC/source freshness where useful. Provide touch-friendly controls, visible keyboard focus, semantic labels/headings, keyboard-operable controls/dialogs and accessible live announcements for errors/sync status.

Integrate one full farmer-to-buyer flow jointly with the backend owner. Review API contract/schema changes through branches and PRs before independently coding UI field assumptions.
