# Future React frontend handoff

The web application is intentionally not implemented in this backend delivery. The planned Member 1 stack is React, Vite, TypeScript, Tailwind CSS, and PWA/IndexedDB support.

- API base URL: `VITE_API_BASE_URL` (for example, `http://localhost:3000/api`).
- Set the API `ALLOWED_ORIGINS` to the exact Vite origin; browser requests that use refresh cookies must set `credentials: 'include'`.
- Import DTOs and Zod schemas from `@harvestguard/contracts` in the npm workspace.
- Use `Authorization: Bearer <accessToken>` for protected requests. Keep the access token in memory where practical. Refresh with `POST /auth/refresh`; a secure HttpOnly cookie is set for browser use. The JSON refresh-token field exists for non-browser clients and should not be placed in local storage.
- Send an `Idempotency-Key: <stable UUID>` on retryable writes and reuse that key only for the same logical operation/payload.
- Include record `expectedVersion` on versioned updates. Handle `409 VERSION_CONFLICT` by showing current safe version data and asking the user to resolve, never auto-overwrite.
- Every paginated list returns `meta.page`, `meta.pageSize`, and `meta.total`.

Implement a cached application shell and IndexedDB outbox client-side; the API cannot store drafts while a device is disconnected. Show distinct states: “Saved on this device”, “Waiting to sync”, “Synced”, and “Sync failed”. Retry transient errors using the same operation ID. Do not present queued writes as server-confirmed.

Screens to build: landing/pilot disclaimer; registration/sign-in; farmer dashboard and batch entry; storage chart/quality/trial comparison with experimental warning; source/time/freshness-labelled prices and target rules; marketplace search/details/contact consent/offers; admin reference/moderation/metrics/export.

Mobile usability: large touch targets, concise field labels, community-language planning, low-bandwidth pagination, and explicit stale/offline timestamps. Keyboard accessibility: logical focus order, visible focus, semantic headings/labels, keyboard-operable dialogs/menus, and status announcements for errors and sync state.

Team workflow: define shared API contracts early; use feature branches and pull requests; review changes to the single Prisma schema/migrations together; integrate one complete farmer-to-buyer flow before parallel screen completion; run the end-to-end flow across both workspaces.
