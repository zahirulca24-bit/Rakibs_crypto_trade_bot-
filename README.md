# Rakibs_crypto_trade_bot-

## Approved Plan Record

- **Date:** 11 September 2026
- **Day:** Friday
- **Time:** 01:12 PM
- **Timezone:** Asia/Dhaka

## Scanner Approved Plan

| # | Stage / Rule | Approved Plan |
| --- | --- | --- |
| 1 | **1H Scanner** | Binance USD-M Futures থেকে সর্বোচ্চ **200 symbols** scan করবে |
| 2 | **1H Logic** | Existing 1H filter/scoring logic থাকবে |
| 3 | **1H Output** | 1H filter + ranking শেষে **Top 30 symbols** থাকবে |
| 4 | **Auto Scan** | **প্রতি 1 ঘণ্টায় Auto Scan হবে** |
| 5 | **Manual Scan** | **Manual Scan থাকবে** |
| 6 | **15m Setup** | 1H Top 30 symbols existing **15m Strategy/Setup Engine**-এ যাবে |
| 7 | **15m Logic** | Existing 15m setup logic use করা হবে |
| 8 | **15m Output** | 15m PASS symbols **5m Entry** stage-এ যাবে |
| 9 | **5m Entry** | নতুন **5m Entry stage** implement হবে |
| 10 | **Final Scanner Flow** | **1H Scanner → Top 30 → 15m Setup → 5m Entry** |
| 11 | **Scanner End** | Scanner flow **5m Entry result**-এ শেষ হবে |
| 12 | **Replacement Rule** | Existing code-এর যে অংশ approved architecture-এর সাথে conflict করবে, শুধু সেই অংশ replace/refactor হবে; existing approved 1H/15m logic অযথা rewrite করা হবে না |

## Current Architecture

```text
1H Scanner Engine
→ Scan Pool
→ 1H Trend
→ 1H Quality
→ Current Top 30

15m Strategy Engine
→ uses current Scanner Top30 only
→ PASS / HOLD

5m Signal Engine
→ planned

Trade Execution
→ Risk Engine
→ Position Engine
→ Execution Engine
→ Trade Management
```

## Implemented / Fixed

- ✅ Indicator Engine implemented.
- ✅ 1H-only Binance USD-M Futures Scanner implemented.
- ✅ Scanner ends at Top30; 15m/5m logic removed from Scanner ownership.
- ✅ Manual Scanner button added.
- ✅ Manual Scanner can run again in the same hour when Binance cooldown is clear.
- ✅ Manual rerun may return the same symbols; same-symbol results are allowed.
- ✅ UI changed from locked Top30 wording to current Top30 refresh behavior.
- ✅ 15m Strategy Engine implemented with PASS/HOLD output.
- ✅ Strategy Engine preserves Scanner LONG/SHORT bias and does not create its own symbol universe.
- ✅ Strategy frontend proxy added.
- ✅ Strategy Engine Working Log added.
- ✅ Scanner latest state persistence support added through `DATABASE_URL` / PostgreSQL.
- ✅ **Artificial 1-hour startup cooldown removed.**
- ✅ Normal deploy/restart now starts with `blocked_until = 0`.
- ✅ Real Binance HTTP 418/429 responses still activate dynamic Retry-After/backoff protection.
- ✅ Trade Execution page exists in planning/safe mode; live order placement remains disabled.

## Current Audit Findings

| Priority | Finding | Status / Impact |
| --- | --- | --- |
| 🔴 Critical | `/api/scanner/run` and `/api/strategy/run` are public with no auth/rate-limit | Open — repeated calls can create Binance request pressure |
| 🔴 High | Scanner has no `asyncio.Lock` | Open — Auto Scan + Manual Scan may overlap |
| ✅ Fixed | Hardcoded 1-hour startup cooldown on every deploy | **Resolved** — removed; only real 418/429 creates cooldown |
| 🟠 High | Manual Scanner refresh can cause Strategy to re-evaluate in the same 15m slot | Open — extra 15m API batch possible |
| 🟠 Medium | Persistence currently focuses on latest Scanner result | Open — Strategy state/history is not durable yet |
| 🟠 Medium | `.gitignore` is missing | Open — credential / local artifact commit risk |
| 🟠 Medium | Automated tests are missing | Open — regressions can reach production |
| 🟠 Medium | GitHub Actions / CI is missing | Open — build/type errors are not caught before deploy |
| 🟡 Low | Some stale wording/docstrings still mention locked or multi-timeframe Scanner behavior | Open — documentation cleanup needed |

## Production Safety Notes

- Live trading is **not enabled**.
- Binance API keys, secrets, and database credentials must never be committed to Git.
- Scanner and Strategy use Binance public USD-M Futures market-data endpoints.
- Real Binance 418/429 responses trigger backoff/cooldown protection.
- Render Free may spin down during inactivity, so the service should not be treated as guaranteed 24/7 execution infrastructure.

## Development Rule

Build and validate one engine at a time:

```text
Build engine
→ inspect Engine Working Log
→ validate/fix
→ mark stable
→ only then implement the next engine
```
