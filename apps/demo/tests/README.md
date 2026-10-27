# N5 isolated consultation checks

With the normal demo Vite server running, open `/tests/sales-test.html`. This development-only entry uses the real `ConsultationController` and exported game UI CSS with an explicit fixture `PaperEnginePort`. It supplies no prices, bets, wallet, IndexedDB or provider connection. It is not linked from the production index; Vite's index-only build excludes it and the production Docker stage copies only that build's `dist`.

In the browser console, execute `await mayaSalesTest.runRound1()`, `await mayaSalesTest.runRound2()` and `await mayaSalesTest.runRound3()`. Each returns named PASS/FAIL results. Run the harness typecheck with `pnpm --filter @maya/demo exec tsc -p tests/tsconfig.json --noEmit`.

Use `mayaSalesTest.setup(9)` then `mayaSalesTest.accept()` to inspect the tenth-notification offer. Resize between desktop, tablet and mobile and call `mayaSalesTest.inspect()` to capture unchanged page/count/presentation identity and action dimensions. The fixture acceptance helper intentionally simulates notifications; it does not test engine acceptance or real price-driven settlement. Actual ledger refresh, shared tabs and live settlement are integrated N6 gates.

Evidence is under `artifacts/verification/n5`. Agent-browser session `maya-n5` was used for the saved records. The actual dummy `https://example.com/` link was clicked once; no booking was made.
