# Rakibs_crypto_trade_bot-   
| Priority    | Finding                                                                     | Impact                                                                                 |
| ----------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 🔴 Critical | `/api/scanner/run` and `/api/strategy/run` public, kono auth/rate-limit nai | Keu public site theke repeatedly expensive Binance scan trigger korte parbe → 418/429  |
| 🔴 High     | Scanner-e `asyncio.Lock` nai                                                | Auto scan + Manual Scan same time-e overlap korte pare → duplicate 200-symbol requests |
| 🔴 High     | Every deploy-e hardcoded **1 hour startup cooldown**                        | Deploy hole Scanner/Strategy almost 1h useless hoye jay                                |
| 🔴 High     | Strategy artificial Scanner cooldown-er sathe fully tied                    | Persisted Top30 thakleo Strategy startup cooldown-e run korte pare na                  |
| 🟠 High     | Manual Scanner refresh same 15m slot-e Strategy abar trigger korte pare     | Extra 15m API batch → rate-limit pressure                                              |
| 🟠 Medium   | Persistence shudhu latest Scanner result-er                                 | Strategy logs/results restart-e hariye jay                                             |
| 🟠 Medium   | `.gitignore` repository-te nai                                              | Future-e `.env`, credentials accidentally commit howar risk                            |
| 🟠 Medium   | Automated tests nai                                                         | Regression easily production-e chole jacche                                            |
| 🟠 Medium   | GitHub Actions/CI nai                                                       | TypeScript/build error push-er age dhora pore na                                       |
| 🟡 Low      | Stale naming/docs ache                                                      | Code bole “multi-timeframe”, “locked Top30”, kintu current logic different             |
| 🟡 Low      | README basically empty                                                      | Architecture/operations documented nai                                                 |
