# OpenZeppelin relayer: readiness, rate limits, and deployment guidance

**Status:** operational / architecture notes  
**Audience:** maintainers of `clearmacro-provider` in **dev, test, and production**, Docker/Kubernetes operators for the OZ relayer, and API consumers (e.g. dashboard live smoke).

## Summary

Live relay smoke and `GET /readyz` surfaced **`ready: false`** with per-chain reason **`RELAYER_UNAVAILABLE`**, while **`GET /healthz`** remained OK. Investigation showed the OpenZeppelin Relayer HTTP API sometimes responding with **`429 Too Many Requests`** to endpoints the provider calls during readiness (e.g. `GET /api/v1/ready`). The provider maps **any thrown error** from those calls into **`RELAYER_UNAVAILABLE`**, so **transient rate limiting** is indistinguishable from **“relayer actually down.”**

This document records **observed behavior**, **why it happens**, and **recommended changes** for both **local/single-tenant** stacks and **production** (where traffic, replicas, and blast radius differ).

## Observed behavior

1. **`GET /readyz`** returns **`503`** when any configured chain is not ready; body includes `chains[]` with `ready: false` and `reasonCode` (e.g. `RELAYER_UNAVAILABLE`).
2. **`GET /healthz`** can still return **`200`** — the process is up; readiness is stricter.
3. Direct calls to the relayer (e.g. **`GET http://<host>:8080/api/v1/ready`** with the configured API key) returned **`429`** with a JSON payload including `TooManyRequests` and an **`after`** hint (retry-style), matching OpenZeppelin Relayer’s documented rate-limit behavior.
4. **`clearmacro-provider-app`** logs showed long periods of **`/readyz` → 200**, then a switch to **`/readyz` → 503**, consistent with **intermittent relayer API failures** from the app’s perspective, not a permanent misconfiguration at startup.

## Mechanism (our code)

### Readiness → multiple OZ HTTP calls per probe

`GET /readyz` uses `evaluateChainReadiness` (`src/chain/readiness.ts`), which in sequence:

- Calls **`OzRelayerClient.ready()`** → `GET /api/v1/ready`
- Calls **`getRelayer(relayerId)`**
- Optionally **`getNetwork(...)`** when the relayer exposes network metadata

So **each** readiness probe is **several** HTTP requests to OZ, not one.

### Errors → `RELAYER_UNAVAILABLE`

On **any exception** from `ready()` / `getRelayer()` / `getNetwork()`, `evaluateChainReadiness` returns **`RELAYER_UNAVAILABLE`** (same bucket for HTTP **429**, timeouts, 5xx, etc.).

### `OzRelayerClient`

`src/relayer/client.ts` throws on **`!response.ok`**, so **429** is an **exception**, not a soft “try again” signal at the readiness layer.

### Steady load besides `readyz`

The relayer worker (`src/relayer/worker.ts`, interval from env, default **2s**) issues OZ calls for batched executions (e.g. **`getTransaction`** per pollable row, **`getRelayer`** / **`submitTransaction`** on submit paths). That traffic is **independent** of dashboard smoke tests and can be significant when queues are full.

## Is the smoke test “unreasonable”?

**Mostly no.** Consumer smoke tests that:

- Call **`/readyz` once** (or a few times in CI), and  
- Poll **`/v1/relay-executions/:id`** on the **provider**,

do not by themselves explain **sustained** violation of OpenZeppelin’s **default** high limits (documented order of magnitude: **100 req/s** token bucket with **burst 300**, plus a separate **concurrency** cap on `/api/v1/relayers/*` — see [OpenZeppelin Relayer 1.4.x configuration](https://docs.openzeppelin.com/relayer/1.4.x/configuration)).

**However:** any extra polling of **`/readyz`**, manual **`curl`** to OZ during debugging, or **many pollable rows** multiplies OZ calls. The smoke test’s value was to reveal **brittleness**: readiness is **strict** and **chatty** to OZ.

## Assessment

| Area | Verdict |
|------|---------|
| **Smoke / E2E** | Reasonable; it correctly fails when `readyz` is not green. |
| **OZ defaults in Docker** | Reasonable for a **generic** upstream image; **not tuned** for “sole client on loopback / docker network.” |
| **Provider readiness design** | **Main improvement target:** each `readyz` multiplies OZ traffic; **429** is folded into **“relayer unavailable”** with no distinction or backoff at the readiness boundary. |

## Recommendations

**Principle:** OZ relayer remains an **external** dependency with its own limits; **we** own how hard we hit it (`readyz` design, worker batching, client retries, compose/Kubernetes env) and how failures are **classified** for operators and dependents.

Split below: **all environments**, **dev/test**, then **production**.

### A. Provider code (dev, test, and production)

These changes improve **correctness of signals** and **cost per probe** everywhere.

1. **Reduce OZ amplification on `readyz`**
   - Add a **TTL cache** of the last successful per-chain readiness result (tune TTL by environment: shorter if you need fresher “paused relayer” detection, longer if `readyz` is scraped often).
   - **Multi-replica production:** in-process cache **per pod** still multiplies OZ calls by **replica count** if every pod serves `readyz` independently. Prefer either:
     - **Shared cache** (Redis) for readiness snapshot with short TTL, or  
     - **Elect one path** for expensive checks (e.g. only worker / only mutation path runs full OZ checks), or  
     - Accept per-pod OZ rate as **N × single-pod** and size OZ limits accordingly.
   - Optionally run a **full** OZ-backed check on **`POST /v1/relay-executions`** (mutation path) even when `readyz` is cached, so user-visible submits do not rely solely on stale readiness.

2. **Treat HTTP 429 distinctly from “relayer down”**
   - In **`OzRelayerClient`**, detect **429** explicitly.
   - In readiness / `readyz`: **bounded retries with backoff** for 429; expose a **`reasonCode`** (or `retryable` flag) that distinguishes **rate limiting** from **paused / missing relayer / network error**, so load balancers and humans do not misread a **transient** limiter as **hard outage**.

3. **Worker: consistent 429 handling on poll path**
   - Align **`getTransaction`** polling with submit-path behavior: treat **429** as transient with backoff / jitter so a limiter spike does not stampede.

4. **Metrics and alerting (production)**
   - Emit counters/histograms for: OZ calls by endpoint, **429 count**, readiness cache hit/miss, worker batch sizes, `readyz` latency.  
   - **Alert** on sustained `RELAYER_UNAVAILABLE` or high 429 rate **after** distinguishing 429 in metrics — avoid paging for a short burst once classification exists.

### B. OZ relayer configuration — dev / test

- In compose (`compose.dashboard-op-sepolia.yaml`, `compose.e2e.yaml`, etc.), set explicit **`RATE_LIMIT_*`** and **`RELAYER_CONCURRENCY_LIMIT`** **above** stock defaults when the relayer is **only** called by `clearmacro-provider` on a **known** network, so local and CI traffic does not flap on 429.
- Comment in compose: **single expected HTTP client** (the provider app).

### C. OZ relayer configuration — production

Stock defaults are a **reasonable starting point**, not a substitute for **capacity planning**.

1. **Derive limits from measured load**
   - Before locking numbers, measure (staging or shadow): OZ RPS from **worker** (poll + submit) + **readiness** (after caching) + any **admin** tooling. Set `RATE_LIMIT_*` and `RELAYER_CONCURRENCY_LIMIT` so normal **P95/P99** traffic stays **below** the knee of 429, with headroom for bursts (deploys, traffic spikes).

2. **Do not “disable” limits without replacement**
   - Extremely high limits remove protection against **runaway bugs** (retry loops, fat-fingered scripts) melting OZ or downstream RPC. Prefer **high but finite** limits plus **provider-side** backoff and caching.

3. **Network placement and access**
   - Restrict OZ’s HTTP port to **private network only** (same VPC / mesh as provider). Production `readyz` should not be the only thing that can reach OZ from the public internet.

4. **Secrets and rotation**
   - `OZ_RELAYER_API_KEY` (and related secrets) should follow normal **rotation** and **least privilege**; rate limits apply **per key** — key reuse across unrelated stacks couples their traffic buckets.

5. **Runbooks**
   - Document: “If `readyz` shows `RELAYER_UNAVAILABLE`, check OZ metrics/logs for **429** vs **5xx** vs **auth**; if 429, scale limits or reduce provider probe rate / improve cache.”

### D. Consumer tests (unchanged intent)

**No change required** to the moral of external smoke tests: they should keep asserting **`readyz`** before spending chain budget. Hardening the provider and production observability makes that guardrail **stable** rather than flaky.

### E. Summary table

| Layer | Dev / test | Production |
|-------|------------|------------|
| **OZ env** | Raise defaults explicitly in compose; single client. | Size from **measured** RPS/concurrency; private network; finite limits. |
| **Provider** | Cache `readyz`, classify 429, worker backoff. | Same + **multi-replica** cache strategy; **metrics/alerts**; mutation-path checks if needed. |
| **Tests** | Keep `readyz` gate. | Same; optional synthetic canary against prod `readyz` with low frequency. |

## References (in-repo)

- Readiness: `src/chain/readiness.ts`
- OZ client: `src/relayer/client.ts`
- Worker: `src/relayer/worker.ts`
- Dashboard OP Sepolia stack: `compose.dashboard-op-sepolia.yaml`
- Earlier relayer notes: `specs/oz-relayer-spike.md`

## External reference

- [OpenZeppelin Relayer 1.4.x — Configuration](https://docs.openzeppelin.com/relayer/1.4.x/configuration) (defaults for `RATE_LIMIT_*`, `RELAYER_CONCURRENCY_LIMIT`, and 429 behavior)
