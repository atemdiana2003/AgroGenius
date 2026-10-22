# Demo script

1. Explain the post-harvest pilot and identify which groups are genuinely measured cooler-test and shaded-control. If none exist yet, explicitly say so; do not invent a result.
2. Register/sign in as the farmer and create a tomato batch with harvest date, starting mass, unit, community, storage method and baseline.
3. Record a manual temperature/RH reading or use explicitly `SIMULATED` data. State provenance aloud and show the experimental-threshold disclaimer.
4. Display a sourced, timestamped price entered by a participant. Never call the seeded `DEMO ONLY` market price an official/live price.
5. Create a farmer target rule and demonstrate an alert only with a labelled test observation that meets it.
6. Publish a listing from an available batch. Sign in as a separate buyer and submit an offer. Show phone details remain hidden; if consented, demonstrate the request/owner approval flow.
7. Accept the offer, then use the separate confirm-sale action to record a sale and show inventory movement/history update. Explain acceptance alone is not a completed sale.
8. Repeat the same create request with the same idempotency key and show replay behavior. Submit a stale `expectedVersion` and show a conflict requiring review.
9. In a future PWA, save a draft offline and synchronize after reconnection. This repo has backend contracts only; do not claim to demonstrate client offline storage.
10. Present real experiment results only if collected using the field protocol. Include missing observations, failures, sample size, and limitations; otherwise present the blank results template and next measurement step.

Track proposed KPIs without pre-filled values: farmers/buyers interviewed and willing to test; batch completeness and observation-log completeness; cooler/control temperature and RH differences; remaining saleable mass and observed spoilage over equal periods; sourced price observations; alerts triggered/acknowledged; active listings/offers/completed buyer connections; offline operations synchronized/failed/retried.
