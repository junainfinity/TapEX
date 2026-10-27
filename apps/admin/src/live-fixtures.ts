/**
 * Responses captured from the real house server (apps/house-server dist, 2026-09-26: MAYA_NETWORK=offline, MAYA_FEED=replay ×10,
 * all SPEC-10 defenses on, SPEC-11 chain wiring), trimmed to a few rows. They pin the console decoders to what the server
 * actually sends. Addresses are the offline vault's seeded addresses, not testnet wallets. Test-only (not bundled).
 * Regenerate: run the server as in docs/maya-live/DEVIATIONS.md (console-engineer), capture each endpoint, rebuild this file.
 */
/* eslint-disable */
export const LIVE: Readonly<Record<string, unknown>> & { readonly stream: Readonly<Record<string, unknown>> } = {
 "overview": {
  "network": "offline",
  "chainId": 0,
  "operator": "0xa4f055c11ee3e816b10e326174f909cc1609ecb7",
  "vault": "0x59d8574581250385570e41d8d66823113b954bfe",
  "token": "0xe02596708a77590086881fb61abfdf02883d8cec",
  "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
  "feedMode": "replay",
  "speed": 10,
  "clockMs": 1790159499700,
  "equityCenti": "10004803610",
  "playerBalancesCenti": "950743",
  "openLiabilityCenti": "1327427",
  "limitUsage": {
   "global": 0.006633948316586645,
   "maxColumn": 0.008220371262460365,
   "maxCell": 0.034751708754285314,
   "maxAccount": 0.017375853508767063
  },
  "registeredPlayers": 4669,
  "activePlayers5m": 338,
  "launch": {
   "enabled": true,
   "active": true,
   "edge": 0.03,
   "untilPlayers": 10000,
   "standardEdge": 0.08
  },
  "breakers": [
   {
    "id": "feedStale",
    "market": "btc-usd",
    "state": "ok",
    "since": 1790128800250,
    "reason": "fresh price"
   },
   {
    "id": "feedStale",
    "market": "eth-usd",
    "state": "ok",
    "since": 1790128800250,
    "reason": "fresh price"
   },
   {
    "id": "drawdown",
    "state": "ok",
    "since": 1790128800000,
    "reason": ""
   },
   {
    "id": "equityFloor",
    "state": "ok",
    "since": 1790128800250,
    "reason": "equity at or above floor"
   },
   {
    "id": "manual",
    "state": "ok",
    "since": 1790151789490,
    "reason": "Console live contract test (scratch server)"
   },
   {
    "id": "manual",
    "market": "btc-usd",
    "state": "ok",
    "since": 1790151789490,
    "reason": "Console live contract test (scratch server)"
   },
   {
    "id": "manual",
    "market": "eth-usd",
    "state": "ok",
    "since": 1790128800000,
    "reason": ""
   }
  ],
  "markets": [
   {
    "id": "btc-usd",
    "enabled": true,
    "paused": false,
    "lastPriceMs": 1790159498000,
    "spot": "85776.41621421",
    "sigma": 0.00007096734649471935,
    "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
    "quoteReason": null
   },
   {
    "id": "eth-usd",
    "enabled": true,
    "paused": false,
    "lastPriceMs": 1790159499000,
    "spot": "2731.6683096",
    "sigma": 0.00008777298508315593,
    "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
    "quoteReason": null
   }
  ],
  "handle24hCenti": "551944890",
  "ggr24hCenti": "4813310",
  "rtp24h": 0.9912712471055792,
  "betsPerMin": 1370,
  "pricing": {
   "standardEdge": 0.08,
   "capX100": 5000,
   "aboveCap": "hide",
   "impactK": 0.02,
   "z": 0
  },
  "limits": {
   "cellFraction": 0.001,
   "columnFraction": 0.005,
   "globalFraction": 0.02,
   "accountFraction": 0.002,
   "maxStakePerBetCenti": "1000000",
   "maxStakePerCellCenti": "5000000"
  },
  "sim": {
   "running": true,
   "speed": 10,
   "arrivalsPerMin": 8
  },
  "equityOnchainCenti": "10000134517",
  "simPnlCenti": "4669093",
  "simBalancesCenti": "553511937",
  "simCreditIssuedCenti": "558689300",
  "dustWei": "0",
  "openLegs": 381,
  "drawdown1h": 0.000010060965831716145,
  "runId": "console-qa-1",
  "journalSeq": 2207078,
  "lastRefitMs": 1790151816620,
  "simArrived": 4083,
  "simTarget": 12000,
  "feed": {
   "mode": "replay",
   "clockMs": 1790159499700,
   "speed": 10,
   "done": false,
   "markets": [
    {
     "market": "btc-usd",
     "lastT": 1790159498
    },
    {
     "market": "eth-usd",
     "lastT": 1790159499
    }
   ]
  },
  "chainAlerts": [],
  "holdPending": 20,
  "holdRejectRate": 0.08532868959512407,
  "holdLatencyP95Ms": 1500,
  "toxicFlowShare": 0.02746186824882163,
  "defenses": {
   "hold": true,
   "quoteValidity": true,
   "minLeadS": 4,
   "ramp": true,
   "toxicity": "graduated",
   "controller": true,
   "reference": false
  },
  "controller": {
   "enabled": true,
   "ranges": [
    {
     "key": "1.01-2",
     "adjust": 0.003921,
     "effective": 0.003921,
     "realized": 0.966462201061287,
     "target": 0.97,
     "bets": 98239
    },
    {
     "key": "2-5",
     "adjust": 0.04,
     "effective": 0.04,
     "realized": 0.9972594682874004,
     "target": 0.9700000000000005,
     "bets": 99132
    },
    {
     "key": "5-10",
     "adjust": 0.02,
     "effective": 0.02,
     "realized": 0.9855903369816402,
     "target": 0.9700000000000002,
     "bets": 10194
    },
    {
     "key": "10-20",
     "adjust": 0,
     "effective": 0,
     "realized": 0.7372344592262142,
     "target": 0.9699999999999996,
     "bets": 2344
    },
    {
     "key": "20-50",
     "adjust": 0,
     "effective": 0,
     "realized": 1.4156562200629534,
     "target": 0.9700000000000001,
     "bets": 697
    },
    {
     "key": "50-100",
     "adjust": 0,
     "effective": 0,
     "realized": null,
     "target": null,
     "bets": 0
    }
   ]
  }
 },
 "defenses": {
  "config": {
   "hold": {
    "enabled": true,
    "maxHoldMs": 1500,
    "tolScale": "logit",
    "tolRel": 1.3,
    "tolAbs": 0.002,
    "onTimeout": "reject",
    "flaggedTolRel": 0.05,
    "newAccountHolds": 10,
    "newAccountTolRel": 0.12,
    "newAccountMaxZ": 2
   },
   "quoteValidity": {
    "enabled": true,
    "graceMs": 500,
    "maxTtlMs": 2500
   },
   "minLeadS": 4,
   "ramp": {
    "enabled": true,
    "startCenti": "25000",
    "perSettledBetCenti": "2500",
    "handleFraction": 0.25
   },
   "toxicity": {
    "enabled": true,
    "minBets": 20,
    "minWins": 5,
    "surchargeZ": 3,
    "surchargeEdge": 0.06,
    "blockZ": 6,
    "blockMinBets": 60,
    "unflagZ": 1,
    "holdMinN": 10,
    "holdZ": 4,
    "holdBlockMinN": 25,
    "holdBlockZ": 6
   },
   "controller": {
    "enabled": true,
    "windowMs": 10800000,
    "evalEveryMs": 900000,
    "minBets": 1000,
    "zGate": 2,
    "deadband": 0.005,
    "maxStepPerEval": 0.01,
    "maxStepPerHour": 0.03,
    "minAdjust": -0.02,
    "maxAdjust": 0.05,
    "cleanHoldZ": 2,
    "overrides": {}
   },
   "reference": {
    "enabled": true,
    "moveSigma": 4
   }
  },
  "hold": {
   "enabled": true,
   "pending": 9,
   "created": 559986,
   "accepted": 507161,
   "rejected": 52816,
   "byDetail": {
    "blocked": 9,
    "fair-value": 45676,
    "fair-value-unavailable": 1993,
    "flag-variant": 63,
    "ok": 507161,
    "ramp": 206,
    "timeout": 4869
   },
   "rejectRate1h": 0.08535064812854354,
   "rejectRateAll": 0.09431815949583644,
   "latencyMs": {
    "p50": 860,
    "p95": 1500,
    "max": 1740,
    "n": 50000
   }
  },
  "quoteValidity": {
   "enabled": true,
   "graceMs": 500,
   "maxTtlMs": 2500
  },
  "minLeadS": 4,
  "ramp": {
   "enabled": true,
   "startCenti": "25000",
   "perSettledBetCenti": "2500",
   "handleFraction": 0.25,
   "accountLimitCenti": "20009496"
  },
  "toxicity": {
   "enabled": true,
   "mode": "graduated",
   "flowEdge": 0.06,
   "flagged": 866,
   "flaggedByMonitor": 866,
   "blocked": 210,
   "blockedByMonitor": 210,
   "toxicFlowShare1h": 0.027465098675347813,
   "toxicFlowShareAll": 0.017325162212782734
  },
  "controller": {
   "enabled": true,
   "nextEvalMs": 1790160302940,
   "ranges": [
    {
     "key": "1.01-2",
     "adjust": 0.003921,
     "effective": 0.003921,
     "bets": 98291,
     "handleCenti": "79454430",
     "realized": 0.9668995674627582,
     "target": 0.97,
     "se": 0.00828950608753316,
     "avgAdjust": 0.02177495087045495,
     "lastChangeMs": 1790156702790
    },
    {
     "key": "2-5",
     "adjust": 0.04,
     "effective": 0.04,
     "bets": 99151,
     "handleCenti": "133766110",
     "realized": 0.9973611851312713,
     "target": 0.9700000000000005,
     "se": 0.024768294735406902,
     "avgAdjust": 0.03953176480948719,
     "lastChangeMs": 1790147701890
    },
    {
     "key": "5-10",
     "adjust": 0.02,
     "effective": 0.02,
     "bets": 10194,
     "handleCenti": "37271170",
     "realized": 0.9855903369816402,
     "target": 0.9700000000000002,
     "se": 0.0743929642576013,
     "avgAdjust": 0.020000000000000007,
     "lastChangeMs": 1790134200570
    },
    {
     "key": "10-20",
     "adjust": 0,
     "effective": 0,
     "bets": 2344,
     "handleCenti": "3012720",
     "realized": 0.7372344592262142,
     "target": 0.9699999999999996,
     "se": 0.33183889163707814,
     "avgAdjust": 0
    },
    {
     "key": "20-50",
     "adjust": 0,
     "effective": 0,
     "bets": 697,
     "handleCenti": "146140",
     "realized": 1.4156562200629534,
     "target": 0.9700000000000001,
     "se": 0.36189700482687304,
     "avgAdjust": 0
    },
    {
     "key": "50-100",
     "adjust": 0,
     "effective": 0,
     "bets": 0,
     "handleCenti": "0",
     "realized": null,
     "target": null,
     "se": null,
     "avgAdjust": null
    }
   ]
  },
  "reference": {
   "enabled": true,
   "moveSigma": 4,
   "invalidations": 0,
   "lastObservationMs": null
  },
  "referenceFeed": null,
  "clockMs": 1790159500790
 },
 "chain": {
  "network": "offline",
  "chainId": 0,
  "vault": {
   "address": "0x59d8574581250385570e41d8d66823113b954bfe",
   "token": "0xe02596708a77590086881fb61abfdf02883d8cec",
   "paused": false,
   "assetsCenti": "10001090300",
   "houseFundedCenti": "10000000300",
   "totalPlayerDepositsCenti": "1100000",
   "totalPlayerWithdrawalsCenti": "0",
   "houseWithdrawnCenti": "10000",
   "surplusCenti": "10000129292",
   "maxVoucherAmountCenti": "10000000",
   "dailyOutflowCapCenti": "100000000",
   "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
   "serverSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
   "signerMismatch": false,
   "pendingSigner": null,
   "signerChangeDelaySec": 172800,
   "pendingSignerChangeDelay": null,
   "maxAttestationAgeSec": 600,
   "houseBufferBps": 1000,
   "houseDailyCapCenti": "1000000000",
   "pendingHouseLimits": null,
   "houseWithdrawableCenti": "999990000",
   "houseWithdrawableWei": "9999900000000000000000000",
   "excessWei": "0",
   "excessCenti": "0",
   "escape": {
    "mode": false,
    "available": false,
    "lastAttestationAtMs": 1790159405000,
    "escapeDelaySec": 604800,
    "availableAtMs": 1790764205000,
    "secondsUntilAvailable": 604703,
    "poolWei": "0",
    "claimedWei": "0",
    "poolCenti": "0",
    "claimedCenti": "0"
   }
  },
  "lastAttestation": {
   "seq": 55,
   "asOfMs": 1790159405000,
   "liabilitiesCenti": "961008",
   "ledgerRoot": "0x7d80ada481cbc30f5399ad7f3f83212e57d4dce7263efd2f64ad1a3efb02c605",
   "txHash": "0x8a1c36829de10a816d0eedf1fe2252e54e471b5060de1038e21f0894fb8411f4",
   "tree": {
    "leaves": 11,
    "leafTotalWei": "9610080000000000000000",
    "treeFile": "attest-55-0x7d80ada481cbc30f5399ad7f3f83212e57d4dce7263efd2f64ad1a3efb02c605.json",
    "treeSha256": "496af8ab7cd3291427ebb40ea842b7b38f20e43fac4d124513b8af2b94aee865"
   }
  },
  "alerts": [],
  "withdrawals": {
   "indexed": 0,
   "anomalies": []
  },
  "operator": {
   "address": "0xa4f055c11ee3e816b10e326174f909cc1609ecb7",
   "ethWei": "1000000000000000000",
   "tokenCenti": "89989009700"
  },
  "pendingVouchers": {
   "count": 0,
   "totalCenti": "0",
   "items": []
  },
  "indexer": {
   "lagBlocks": 0
  },
  "reconciliation": {
   "match": true,
   "vaultAssetsWei": "100010903000000000000000000",
   "ledgerAssetsWei": "100010903000000000000000000",
   "deltaWei": "0",
   "dustWei": "0",
   "components": {
    "playerBalancesCenti": "951450",
    "escrowCenti": "4570",
    "vouchersCenti": "0",
    "houseEquityCenti": "10000134280",
    "externalVaultCenti": "-10001090300",
    "anomalousWithdrawals": "0",
    "anomalousWithdrawalsWei": "0"
   }
  },
  "explorer": {
   "vault": null,
   "token": null,
   "operator": null
  },
  "receipts": [
   {
    "kind": "attest",
    "txHash": "0x39ad58c4effe2bca5dc80c9fca5b0d429272bd180badaaeff72450df3e6255a9",
    "amountWei": "9674980000000000000000",
    "explorerUrl": null,
    "atMs": 1790158805780
   },
   {
    "kind": "attest",
    "txHash": "0x8a1c36829de10a816d0eedf1fe2252e54e471b5060de1038e21f0894fb8411f4",
    "amountWei": "9610080000000000000000",
    "explorerUrl": null,
    "atMs": 1790159405820
   }
  ],
  "centiWei": "10000000000000000"
 },
 "rtp": {
  "byRange": [
   {
    "key": "1.01-2",
    "phase": "launch",
    "bets": 230853,
    "handleCenti": "185244020",
    "returnedCenti": "179990193",
    "expected": 0.9508131690514267,
    "realized": 0.9716383449247107,
    "expectedLow": 0.9405282048612433,
    "expectedHigh": 0.96109813324161,
    "wins": 140735,
    "refunds": 0,
    "policyTarget": 0.9699999999999863
   },
   {
    "key": "1.01-2",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   },
   {
    "key": "2-5",
    "phase": "launch",
    "bets": 237489,
    "handleCenti": "274319710",
    "returnedCenti": "276654735",
    "expected": 0.944011747897681,
    "realized": 1.008512056971772,
    "expectedLow": 0.911189807401555,
    "expectedHigh": 0.9768336883938071,
    "wins": 79675,
    "refunds": 0,
    "policyTarget": 0.9699999999999258
   },
   {
    "key": "2-5",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   },
   {
    "key": "5-10",
    "phase": "launch",
    "bets": 29492,
    "handleCenti": "83206760",
    "returnedCenti": "81988629",
    "expected": 0.9505612292511635,
    "realized": 0.9853601918882552,
    "expectedLow": 0.8532233561591939,
    "expectedHigh": 1.047899102343133,
    "wins": 4824,
    "refunds": 0,
    "policyTarget": 0.9699999999999972
   },
   {
    "key": "5-10",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   },
   {
    "key": "10-20",
    "phase": "launch",
    "bets": 6637,
    "handleCenti": "7906920",
    "returnedCenti": "7134838",
    "expected": 0.9609660127892825,
    "realized": 0.9023536345378479,
    "expectedLow": 0.5861736699137867,
    "expectedHigh": 1.3357583556647783,
    "wins": 493,
    "refunds": 0,
    "policyTarget": 0.9700000000000022
   },
   {
    "key": "10-20",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   },
   {
    "key": "20-50",
    "phase": "launch",
    "bets": 2452,
    "handleCenti": "1025580",
    "returnedCenti": "961086",
    "expected": 0.9676545314083971,
    "realized": 0.937114608319195,
    "expectedLow": 0.5311955012716845,
    "expectedHigh": 1.4041135615451097,
    "wins": 75,
    "refunds": 0,
    "policyTarget": 0.9700000000000039
   },
   {
    "key": "20-50",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   }
  ],
  "byMarket": [
   {
    "key": "btc-usd",
    "bets": 300447,
    "handleCenti": "318649530",
    "returnedCenti": "313206400",
    "expected": 0.9480822650491441,
    "realized": 0.9829181295199149,
    "expectedLow": 0.9182762254699641,
    "expectedHigh": 0.977888304628324,
    "wins": 133462,
    "refunds": 0,
    "policyTarget": 0.9699999999999073
   },
   {
    "key": "eth-usd",
    "bets": 206476,
    "handleCenti": "233053460",
    "returnedCenti": "233523081",
    "expected": 0.9468699716041324,
    "realized": 1.0020150784287862,
    "expectedLow": 0.9112094246790327,
    "expectedHigh": 0.9825305185292322,
    "wins": 92340,
    "refunds": 0,
    "policyTarget": 0.9699999999999817
   }
  ],
  "byPhase": [
   {
    "key": "launch",
    "phase": "launch",
    "bets": 506923,
    "handleCenti": "551702990",
    "returnedCenti": "546729481",
    "expected": 0.9475701612776775,
    "realized": 0.9909851693934085,
    "expectedLow": 0.9246947329316944,
    "expectedHigh": 0.9704455896236606,
    "wins": 225802,
    "refunds": 0,
    "policyTarget": 0.9699999999998151
   },
   {
    "key": "standard",
    "phase": "standard",
    "bets": 0,
    "handleCenti": "0",
    "returnedCenti": "0",
    "expected": 0,
    "realized": null,
    "expectedLow": 0,
    "expectedHigh": 0,
    "wins": 0,
    "refunds": 0,
    "policyTarget": null
   }
  ],
  "calibration": [
   {
    "predicted": 0.06604825463829155,
    "observed": 0.0658862529783487,
    "n": 9653
   },
   {
    "predicted": 0.16277558061646696,
    "observed": 0.17640374702067513,
    "n": 36082
   },
   {
    "predicted": 0.25087922369049265,
    "observed": 0.2580923354337962,
    "n": 102041
   },
   {
    "predicted": 0.34536831584343275,
    "observed": 0.35658452570217275,
    "n": 75480
   },
   {
    "predicted": 0.45299835833735624,
    "observed": 0.4781610121685873,
    "n": 74454
   },
   {
    "predicted": 0.5508764392767255,
    "observed": 0.5771877892537368,
    "n": 109117
   },
   {
    "predicted": 0.6439244215019131,
    "observed": 0.6450818999699198,
    "n": 73138
   },
   {
    "predicted": 0.7354733662988261,
    "observed": 0.7298211882330321,
    "n": 26005
   },
   {
    "predicted": 0.8075414626726609,
    "observed": 0.8488982161594963,
    "n": 953
   }
  ],
  "tables": [
   {
    "market": "btc-usd",
    "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
    "previousTableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:20:52.000Z:8a3819d4",
    "builtMs": 1790151803710,
    "source": "refit",
    "trainedThrough": "2026-09-23T08:22:32.000Z"
   },
   {
    "market": "eth-usd",
    "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
    "previousTableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:21:07.000Z:0705c050",
    "builtMs": 1790151816620,
    "source": "refit",
    "trainedThrough": "2026-09-23T08:22:47.000Z"
   }
  ],
  "lastRefitMs": 1790151816620,
  "phaseLog": [
   {
    "atMs": 1790128800000,
    "phase": "launch",
    "registered": 0
   }
  ]
 },
 "exposure": {
  "market": "eth-usd",
  "t": 1790159503,
  "generatedAtMs": 1790159503540,
  "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
  "windows": [
   1790159510000,
   1790159515000,
   1790159520000,
   1790159525000,
   1790159530000,
   1790159535000
  ],
  "bands": [
   {
    "index": 5460,
    "lower": "2730",
    "upper": "2730.5"
   },
   {
    "index": 5461,
    "lower": "2730.5",
    "upper": "2731"
   },
   {
    "index": 5462,
    "lower": "2731",
    "upper": "2731.5"
   },
   {
    "index": 5463,
    "lower": "2731.5",
    "upper": "2732"
   },
   {
    "index": 5464,
    "lower": "2732",
    "upper": "2732.5"
   },
   {
    "index": 5465,
    "lower": "2732.5",
    "upper": "2733"
   },
   {
    "index": 5466,
    "lower": "2733",
    "upper": "2733.5"
   }
  ],
  "cells": [
   {
    "start": 1790159510000,
    "bandIndex": 5460,
    "x100": 1007,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159510000,
    "bandIndex": 5461,
    "x100": 428,
    "liabilityCenti": "1765",
    "limitCenti": "10004963",
    "legs": 2
   },
   {
    "start": 1790159510000,
    "bandIndex": 5462,
    "x100": 207,
    "liabilityCenti": "2647",
    "limitCenti": "10004963",
    "legs": 7
   },
   {
    "start": 1790159510000,
    "bandIndex": 5463,
    "x100": 181,
    "liabilityCenti": "8706",
    "limitCenti": "10004963",
    "legs": 19
   },
   {
    "start": 1790159510000,
    "bandIndex": 5464,
    "x100": 352,
    "liabilityCenti": "3382",
    "limitCenti": "10004963",
    "legs": 5
   },
   {
    "start": 1790159510000,
    "bandIndex": 5465,
    "x100": 952,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159510000,
    "bandIndex": 5466,
    "x100": 1949,
    "liabilityCenti": "621",
    "limitCenti": "10004963",
    "legs": 1
   },
   {
    "start": 1790159515000,
    "bandIndex": 5460,
    "x100": 697,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159515000,
    "bandIndex": 5461,
    "x100": 384,
    "liabilityCenti": "72266",
    "limitCenti": "10004963",
    "legs": 1
   },
   {
    "start": 1790159515000,
    "bandIndex": 5462,
    "x100": 243,
    "liabilityCenti": "4284",
    "limitCenti": "10004963",
    "legs": 5
   },
   {
    "start": 1790159515000,
    "bandIndex": 5463,
    "x100": 223,
    "liabilityCenti": "2635",
    "limitCenti": "10004963",
    "legs": 7
   },
   {
    "start": 1790159515000,
    "bandIndex": 5464,
    "x100": 325,
    "liabilityCenti": "1196",
    "limitCenti": "10004963",
    "legs": 4
   },
   {
    "start": 1790159515000,
    "bandIndex": 5465,
    "x100": 664,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159515000,
    "bandIndex": 5466,
    "x100": 1515,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159520000,
    "bandIndex": 5460,
    "x100": 617,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159520000,
    "bandIndex": 5461,
    "x100": 409,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159520000,
    "bandIndex": 5462,
    "x100": 278,
    "liabilityCenti": "20422",
    "limitCenti": "10004963",
    "legs": 3
   },
   {
    "start": 1790159520000,
    "bandIndex": 5463,
    "x100": 286,
    "liabilityCenti": "1075",
    "limitCenti": "10004963",
    "legs": 2
   },
   {
    "start": 1790159520000,
    "bandIndex": 5464,
    "x100": 356,
    "liabilityCenti": "1139",
    "limitCenti": "10004963",
    "legs": 1
   },
   {
    "start": 1790159520000,
    "bandIndex": 5465,
    "x100": 567,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159520000,
    "bandIndex": 5466,
    "x100": 1139,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159525000,
    "bandIndex": 5460,
    "x100": 631,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159525000,
    "bandIndex": 5461,
    "x100": 409,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159525000,
    "bandIndex": 5462,
    "x100": 308,
    "liabilityCenti": "1776",
    "limitCenti": "10004963",
    "legs": 2
   },
   {
    "start": 1790159525000,
    "bandIndex": 5463,
    "x100": 325,
    "liabilityCenti": "2410",
    "limitCenti": "10004963",
    "legs": 2
   },
   {
    "start": 1790159525000,
    "bandIndex": 5464,
    "x100": 372,
    "liabilityCenti": "355",
    "limitCenti": "10004963",
    "legs": 1
   },
   {
    "start": 1790159525000,
    "bandIndex": 5465,
    "x100": 551,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159525000,
    "bandIndex": 5466,
    "x100": 1051,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5460,
    "x100": 646,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5461,
    "x100": 401,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5462,
    "x100": 328,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5463,
    "x100": 340,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5464,
    "x100": 421,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5465,
    "x100": 578,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159530000,
    "bandIndex": 5466,
    "x100": 904,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5460,
    "x100": 656,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5461,
    "x100": 380,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5462,
    "x100": 343,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5463,
    "x100": 362,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5464,
    "x100": 447,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5465,
    "x100": 609,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   },
   {
    "start": 1790159535000,
    "bandIndex": 5466,
    "x100": 1038,
    "liabilityCenti": "0",
    "limitCenti": "10004963",
    "legs": 0
   }
  ],
  "columns": [
   {
    "start": 1790159510000,
    "liabilityCenti": "17121"
   },
   {
    "start": 1790159515000,
    "liabilityCenti": "80381"
   },
   {
    "start": 1790159520000,
    "liabilityCenti": "22636"
   },
   {
    "start": 1790159525000,
    "liabilityCenti": "4541"
   },
   {
    "start": 1790159530000,
    "liabilityCenti": "0"
   },
   {
    "start": 1790159535000,
    "liabilityCenti": "0"
   }
  ],
  "columnLimitCenti": "50024819",
  "globalLimitCenti": "200099276",
  "globalLiabilityCenti": "953441"
 },
 "players": {
  "rows": [
   {
    "account": "sim:01857",
    "kind": "sim",
    "strategy": "whale",
    "balanceCenti": "3202098",
    "handleCenti": "7173520",
    "pnlCenti": "-78202",
    "bets": 245,
    "openBets": 0,
    "wins": 72,
    "rtp": 0.9890985178824343,
    "flagged": false,
    "blocked": false,
    "firstSeenMs": 1790142298920,
    "lastBetMs": 1790158361030,
    "holds": 255,
    "latencyZ": -1.2586225414656265,
    "excessReturnZ": 0.14404642718859834
   },
   {
    "account": "sim:00297",
    "kind": "sim",
    "strategy": "whale",
    "balanceCenti": "632116",
    "handleCenti": "7106060",
    "pnlCenti": "-30084",
    "bets": 252,
    "openBets": 0,
    "wins": 62,
    "rtp": 0.9957664303425527,
    "flagged": false,
    "blocked": false,
    "firstSeenMs": 1790130775720,
    "lastBetMs": 1790152647200,
    "holds": 264,
    "latencyZ": -1.6337804363414996,
    "excessReturnZ": 0.4109999494794848
   }
  ],
  "total": 4669,
  "nextCursor": "2"
 },
 "playersOnchain": {
  "rows": [
   {
    "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
    "kind": "onchain",
    "balanceCenti": "107828",
    "handleCenti": "682960",
    "pnlCenti": "7938",
    "bets": 1068,
    "openBets": 1,
    "wins": 396,
    "rtp": 1.0116248077908765,
    "flagged": false,
    "blocked": false,
    "firstSeenMs": 1790128800000,
    "lastBetMs": 1790159497450,
    "holds": 1095,
    "latencyZ": -0.37425435739227003,
    "excessReturnZ": 0.6624168362238754
   }
  ],
  "total": 11,
  "nextCursor": "1"
 },
 "playerDetail": {
  "player": {
   "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
   "kind": "onchain",
   "balanceCenti": "107828",
   "handleCenti": "682960",
   "pnlCenti": "7938",
   "bets": 1068,
   "openBets": 1,
   "wins": 396,
   "rtp": 1.0116248077908765,
   "flagged": false,
   "blocked": false,
   "firstSeenMs": 1790128800000,
   "lastBetMs": 1790159497450,
   "holds": 1095,
   "latencyZ": -0.37425435739227003,
   "excessReturnZ": 0.6624168362238754
  },
  "bets": [
   {
    "legId": "L507075",
    "requestId": "onchain:player-7:4557f91b:1095",
    "quoteId": "4557f91b.btc-usd.1790159495.24",
    "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
    "kind": "onchain",
    "market": "btc-usd",
    "cellId": "maya-cell-v1:btc-usd:1790159515000:1790159520000:85770:85780",
    "start": 1790159515000,
    "end": 1790159520000,
    "bandIndex": 8577,
    "lower": "85770",
    "upper": "85780",
    "stakeCenti": "110",
    "x100": 316,
    "payoutCenti": "347",
    "status": "open",
    "placedMs": 1790159497450,
    "phase": "launch",
    "edge": 0.07,
    "p": 0.2937135018918313,
    "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
    "requestedMs": 1790159496830,
    "heldMs": 620,
    "pFresh": 0.31459380167800705,
    "ctlAdjust": 0.04,
    "flagged": false
   },
   {
    "legId": "L506316",
    "requestId": "onchain:player-7:4557f91b:1094",
    "quoteId": "4557f91b.eth-usd.1790159462.18",
    "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
    "kind": "onchain",
    "market": "eth-usd",
    "cellId": "maya-cell-v1:eth-usd:1790159475000:1790159480000:2733.5:2734",
    "start": 1790159475000,
    "end": 1790159480000,
    "bandIndex": 5467,
    "lower": "2733.5",
    "upper": "2734",
    "stakeCenti": "450",
    "x100": 329,
    "payoutCenti": "1480",
    "status": "lost",
    "placedMs": 1790159464000,
    "phase": "launch",
    "edge": 0.07,
    "p": 0.28185672562084063,
    "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
    "requestedMs": 1790159463660,
    "heldMs": 340,
    "pFresh": 0.14301749462007038,
    "ctlAdjust": 0.04,
    "flagged": false,
    "settledMs": 1790159481030,
    "creditCenti": "0",
    "evidenceSampleIds": [
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159475000",
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159476000",
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159477000",
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159478000",
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159479000",
     "maya-observed-v2:lynx:bsc:0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace:1790159480000"
    ],
    "settlementReason": "The completed recorded path missed your square."
   },
   {
    "legId": "L506259",
    "requestId": "onchain:player-7:4557f91b:1093",
    "quoteId": "4557f91b.btc-usd.1790159460.23",
    "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
    "kind": "onchain",
    "market": "btc-usd",
    "cellId": "maya-cell-v1:btc-usd:1790159480000:1790159485000:85780:85790",
    "start": 1790159480000,
    "end": 1790159485000,
    "bandIndex": 8578,
    "lower": "85780",
    "upper": "85790",
    "stakeCenti": "160",
    "x100": 401,
    "payoutCenti": "641",
    "status": "lost",
    "placedMs": 1790159462410,
    "phase": "launch",
    "edge": 0.07,
    "p": 0.231442519925679,
    "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
    "requestedMs": 1790159461540,
    "heldMs": 870,
    "pFresh": 0.2518399820981828,
    "ctlAdjust": 0.04,
    "flagged": false,
    "settledMs": 1790159486300,
    "creditCenti": "0",
    "evidenceSampleIds": [
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159480000",
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159481000",
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159482000",
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159483000",
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159484000",
     "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159485000"
    ],
    "settlementReason": "The completed recorded path missed your square."
   }
  ],
  "deposits": [
   {
    "id": "0xc3efad3c9380cc1e1b55255b9d119bba77032e6de393f74e9eb1a1a574a5fdde:0",
    "amountCenti": "100000",
    "amountWei": "1000000000000000000000",
    "dustWei": "0",
    "ms": 1790128800000,
    "txHash": "0xc3efad3c9380cc1e1b55255b9d119bba77032e6de393f74e9eb1a1a574a5fdde",
    "blockNumber": "9",
    "status": "credited"
   }
  ],
  "withdrawals": [],
  "flags": []
 },
 "bets": {
  "rows": [
   {
    "legId": "L507354",
    "requestId": "sim:03720:413",
    "quoteId": "4557f91b.eth-usd.1790159507.10",
    "account": "sim:03720",
    "kind": "sim",
    "strategy": "grinder",
    "market": "eth-usd",
    "cellId": "maya-cell-v1:eth-usd:1790159515000:1790159520000:2731.5:2732",
    "start": 1790159515000,
    "end": 1790159520000,
    "bandIndex": 5463,
    "lower": "2731.5",
    "upper": "2732",
    "stakeCenti": "1000",
    "x100": 191,
    "payoutCenti": "1910",
    "status": "open",
    "placedMs": 1790159508740,
    "phase": "launch",
    "edge": 0.07,
    "p": 0.48495504013144,
    "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
    "requestedMs": 1790159508620,
    "heldMs": 120,
    "pFresh": 0.5315647130381214,
    "ctlAdjust": 0.04,
    "flagged": false
   },
   {
    "legId": "L507353",
    "requestId": "sim:00324:1451",
    "quoteId": "4557f91b.eth-usd.1790159507.10",
    "account": "sim:00324",
    "kind": "sim",
    "strategy": "grinder",
    "market": "eth-usd",
    "cellId": "maya-cell-v1:eth-usd:1790159515000:1790159520000:2731.5:2732",
    "start": 1790159515000,
    "end": 1790159520000,
    "bandIndex": 5463,
    "lower": "2731.5",
    "upper": "2732",
    "stakeCenti": "270",
    "x100": 191,
    "payoutCenti": "515",
    "status": "open",
    "placedMs": 1790159508740,
    "phase": "launch",
    "edge": 0.07,
    "p": 0.48495504013144,
    "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
    "requestedMs": 1790159508370,
    "heldMs": 370,
    "pFresh": 0.5315647130381214,
    "ctlAdjust": 0.04,
    "flagged": false
   }
  ],
  "nextCursor": "507353"
 },
 "audit": {
  "rows": [
   {
    "id": "A1134",
    "ms": 1790156702790,
    "kind": "system",
    "actor": "edge-controller",
    "action": "controller-adjust",
    "target": "1.01-2",
    "before": 0.011057,
    "after": 0.003921,
    "result": "ok",
    "reason": "realized RTP 94.60% vs target 97.00% over 90473 non-flagged bets (SE 0.85 pts, window-average adjustment 2.79 pts)"
   },
   {
    "id": "A1085",
    "ms": 1790155802790,
    "kind": "system",
    "actor": "edge-controller",
    "action": "controller-adjust",
    "target": "1.01-2",
    "before": 0.02,
    "after": 0.011057,
    "result": "ok",
    "reason": "realized RTP 95.21% vs target 97.00% over 87391 non-flagged bets (SE 0.89 pts, window-average adjustment 2.89 pts)"
   },
   {
    "id": "A902",
    "ms": 1790151790570,
    "kind": "admin",
    "actor": "admin",
    "action": "defenses",
    "before": {
     "hold": {
      "enabled": true,
      "maxHoldMs": 1500,
      "tolScale": "logit",
      "tolRel": 1.3,
      "tolAbs": 0.002,
      "onTimeout": "reject",
      "flaggedTolRel": 0.05,
      "newAccountHolds": 10,
      "newAccountTolRel": 0.12,
      "newAccountMaxZ": 2
     },
     "quoteValidity": {
      "enabled": true,
      "graceMs": 500,
      "maxTtlMs": 2500
     },
     "minLeadS": 5,
     "ramp": {
      "enabled": true,
      "startCenti": "25000",
      "perSettledBetCenti": "2500",
      "handleFraction": 0.25
     },
     "toxicity": {
      "enabled": true,
      "minBets": 20,
      "minWins": 5,
      "surchargeZ": 3,
      "surchargeEdge": 0.06,
      "blockZ": 6,
      "blockMinBets": 60,
      "unflagZ": 1,
      "holdMinN": 10,
      "holdZ": 4,
      "holdBlockMinN": 25,
      "holdBlockZ": 6
     },
     "controller": {
      "enabled": true,
      "windowMs": 10800000,
      "evalEveryMs": 900000,
      "minBets": 1000,
      "zGate": 2,
      "deadband": 0.005,
      "maxStepPerEval": 0.01,
      "maxStepPerHour": 0.03,
      "minAdjust": -0.02,
      "maxAdjust": 0.05,
      "cleanHoldZ": 2,
      "overrides": {}
     },
     "reference": {
      "enabled": true,
      "moveSigma": 4
     }
    },
    "after": {
     "hold": {
      "enabled": true,
      "maxHoldMs": 1500,
      "tolScale": "logit",
      "tolRel": 1.3,
      "tolAbs": 0.002,
      "onTimeout": "reject",
      "flaggedTolRel": 0.05,
      "newAccountHolds": 10,
      "newAccountTolRel": 0.12,
      "newAccountMaxZ": 2
     },
     "quoteValidity": {
      "enabled": true,
      "graceMs": 500,
      "maxTtlMs": 2500
     },
     "minLeadS": 4,
     "ramp": {
      "enabled": true,
      "startCenti": "25000",
      "perSettledBetCenti": "2500",
      "handleFraction": 0.25
     },
     "toxicity": {
      "enabled": true,
      "minBets": 20,
      "minWins": 5,
      "surchargeZ": 3,
      "surchargeEdge": 0.06,
      "blockZ": 6,
      "blockMinBets": 60,
      "unflagZ": 1,
      "holdMinN": 10,
      "holdZ": 4,
      "holdBlockMinN": 25,
      "holdBlockZ": 6
     },
     "controller": {
      "enabled": true,
      "windowMs": 10800000,
      "evalEveryMs": 900000,
      "minBets": 1000,
      "zGate": 2,
      "deadband": 0.005,
      "maxStepPerEval": 0.01,
      "maxStepPerHour": 0.03,
      "minAdjust": -0.02,
      "maxAdjust": 0.05,
      "cleanHoldZ": 2,
      "overrides": {}
     },
     "reference": {
      "enabled": true,
      "moveSigma": 4
     }
    },
    "reason": "Console live contract test (scratch server)",
    "result": "ok"
   },
   {
    "id": "A1262",
    "ms": 1790159405820,
    "kind": "system",
    "actor": "system",
    "action": "treasury-attest",
    "before": {
     "seq": "54",
     "liabilitiesWei": "9674980000000000000000"
    },
    "after": {
     "seq": "55",
     "liabilitiesWei": "9610080000000000000000",
     "liabilitiesCenti": "961008",
     "ledgerRoot": "0x7d80ada481cbc30f5399ad7f3f83212e57d4dce7263efd2f64ad1a3efb02c605",
     "asOf": "1790159405",
     "leaves": 11,
     "leafTotalWei": "9610080000000000000000"
    },
    "reason": "periodic attestation",
    "result": "ok",
    "txHash": "0x8a1c36829de10a816d0eedf1fe2252e54e471b5060de1038e21f0894fb8411f4"
   },
   {
    "id": "A1265",
    "ms": 1790159503290,
    "kind": "system",
    "actor": "toxicity-monitor",
    "action": "player-flag",
    "target": "sim:03551.s14",
    "before": {
     "flagged": false,
     "blocked": false
    },
    "after": {
     "flagged": true,
     "blocked": false
    },
    "reason": "latency evidence z=4.08 over 25 held placements (mean fair-value move 25.0 pts above the population); excess return z=-0.33 over 1 settled bets; flow surcharge 0.06",
    "result": "ok"
   },
   {
    "id": "A900",
    "ms": 1790151790040,
    "kind": "admin",
    "actor": "admin",
    "action": "vault-signer-cancel",
    "before": {
     "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "serverSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "pendingSigner": {
      "address": "0x2222222222222222222222222222222222222222",
      "eta": "1790324590",
      "etaMs": 1790324590000
     }
    },
    "after": {
     "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "serverSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "pendingSigner": null
    },
    "reason": "Console live contract test (scratch server)",
    "result": "ok",
    "txHash": "0x6c2306570929bf359bef68378daddf9943b0b6e0f2e2517aacc2d87218af1627"
   },
   {
    "id": "A899",
    "ms": 1790151790040,
    "kind": "admin",
    "actor": "admin",
    "action": "vault-signer-accept",
    "before": {
     "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "serverSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
     "pendingSigner": {
      "address": "0x2222222222222222222222222222222222222222",
      "eta": "1790324590",
      "etaMs": 1790324590000
     }
    },
    "reason": "Console live contract test (scratch server)",
    "result": "failed: TimelockNotElapsed: 1790324590 > 1790151790"
   }
  ]
 },
 "metrics": {
  "t": [
   1790128911250,
   1790129811250,
   1790130711250,
   1790131611250,
   1790132511250,
   1790133411250,
   1790134311250,
   1790135211250,
   1790136111250,
   1790137011250,
   1790137911250,
   1790138811250,
   1790139711250,
   1790140611250,
   1790141511250,
   1790142411250,
   1790143311250,
   1790144211250,
   1790145111250,
   1790146011250,
   1790146911250,
   1790147811250,
   1790148711250,
   1790149611250,
   1790150511250,
   1790151411250,
   1790152311250,
   1790153211250,
   1790154111250,
   1790155011250,
   1790155911250,
   1790156811250,
   1790157711250,
   1790158611250,
   1790159511250
  ],
  "equity": [
   "9999997802",
   "10000027853",
   "10000398755",
   "9999972573",
   "9999331910",
   "9998586496",
   "9998478620",
   "9998854599",
   "9999282616",
   "10000411166",
   "10000458172",
   "9999701071",
   "9999175827",
   "9999243644",
   "9998471517",
   "9997586960",
   "9998555927",
   "9997092218",
   "9997718935",
   "9998057076",
   "9997745817",
   "9997572415",
   "9999668444",
   "10002032710",
   "10002262065",
   "10003323187",
   "10001346266",
   "10002046143",
   "10004250068",
   "10004821632",
   "10004661774",
   "10000664920",
   "10003354882",
   "10003497637",
   "10004569724"
  ],
  "ggr": [
   "-2198",
   "27853",
   "398755",
   "-27427",
   "-668090",
   "-1413504",
   "-1521380",
   "-1145401",
   "-717384",
   "411166",
   "458172",
   "-298929",
   "-824173",
   "-756356",
   "-1528483",
   "-2413040",
   "-1444073",
   "-2907782",
   "-2281065",
   "-1942924",
   "-2254183",
   "-2427585",
   "-331556",
   "2032710",
   "2262065",
   "3333187",
   "1355966",
   "2055843",
   "4259768",
   "4831332",
   "4671474",
   "674620",
   "3364582",
   "3507337",
   "4579424"
  ],
  "handle": [
   "4360",
   "1966620",
   "7264090",
   "14673250",
   "23424350",
   "33942880",
   "45516130",
   "61450770",
   "76008710",
   "86212940",
   "95939990",
   "106972120",
   "118987130",
   "133536010",
   "146141240",
   "160561530",
   "174780890",
   "191049640",
   "209246280",
   "230881460",
   "251435490",
   "271218440",
   "289695900",
   "309322020",
   "335111120",
   "359689280",
   "382046590",
   "402602290",
   "422325440",
   "442585940",
   "462076340",
   "481078440",
   "500825680",
   "525644870",
   "550828630"
  ],
  "rtp": [
   1.923529411764706,
   0.9848984482590356,
   0.9435804161767598,
   1.0018791305312977,
   1.0287538519806496,
   1.0417313793990166,
   1.0336574124157973,
   1.0187873462560333,
   1.0094683609260249,
   0.9952240391939946,
   0.995213972627724,
   1.0027994335372754,
   1.006940839656888,
   1.0056698134062605,
   1.0104883393552464,
   1.0150657835629096,
   1.0082684515999962,
   1.0152437537338987,
   1.0109210260914119,
   1.0084286064122816,
   1.0089811816092127,
   1.0089567901936045,
   1.0011462137447538,
   0.9934219244654762,
   0.9932383424467117,
   0.9907232539251682,
   0.9964476277339085,
   0.9948878792231898,
   0.989901176444259,
   0.9890781991511285,
   0.9898840276298486,
   0.9985964903520934,
   0.9932778449222134,
   0.9933194408069234,
   0.99167954153086
  ],
  "openLiability": [
   "3759",
   "174261",
   "642646",
   "171641",
   "375535",
   "229812",
   "1074871",
   "1213861",
   "1043258",
   "268196",
   "509240",
   "522729",
   "721986",
   "324012",
   "1118089",
   "888560",
   "322435",
   "1058639",
   "1668071",
   "1067645",
   "1121091",
   "455209",
   "1418628",
   "746620",
   "1825592",
   "981024",
   "873232",
   "1060513",
   "1140050",
   "972490",
   "539223",
   "1872257",
   "557478",
   "2438824",
   "1198652"
  ],
  "players": [
   18,
   168,
   297,
   432,
   559,
   681,
   798,
   937,
   1063,
   1177,
   1318,
   1439,
   1573,
   1711,
   1838,
   2001,
   2149,
   2291,
   2424,
   2564,
   2709,
   2869,
   2997,
   3142,
   3306,
   3435,
   3559,
   3720,
   3868,
   3999,
   4138,
   4283,
   4416,
   4553,
   4662
  ],
  "betsPerMin": [
   10,
   421,
   573,
   603,
   766,
   704,
   783,
   913,
   899,
   767,
   885,
   975,
   921,
   993,
   1022,
   1223,
   1032,
   1082,
   809,
   972,
   1035,
   1086,
   1090,
   1083,
   1189,
   1254,
   1165,
   1140,
   1187,
   1251,
   1409,
   1134,
   1262,
   1462,
   1242
  ]
 },
 "proof": {
  "account": "0x8d5b991e6ee7526a18665db1d7e97f4709d94f9c",
  "chainId": 0,
  "vault": "0x59d8574581250385570e41d8d66823113b954bfe",
  "attestation": {
   "seq": "55",
   "root": "0x7d80ada481cbc30f5399ad7f3f83212e57d4dce7263efd2f64ad1a3efb02c605",
   "asOf": "1790159405",
   "asOfMs": 1790159405000,
   "liabilitiesWei": "9610080000000000000000",
   "source": "vault",
   "txHash": "0x8a1c36829de10a816d0eedf1fe2252e54e471b5060de1038e21f0894fb8411f4"
  },
  "included": true,
  "balanceWei": "1085480000000000000000",
  "proof": [
   "0xac371680a3d0976282cd489c4337ee7014b0d4ce09c6dbb7eea9dc181ff0e9ae",
   "0x65a13db14faabd5ba934cd395d10dd3028fbf09be661fc71c18ee782b1e5d4fe",
   "0x8551789f3e6a223577d7197e685880d8a2d06b5881c286f89787ef62b90df1b3"
  ],
  "currentOwedWei": "1081750000000000000000",
  "claim": {
   "function": "claimEscape(uint256,bytes32[])",
   "attestedBalance": "1085480000000000000000",
   "proof": [
    "0xac371680a3d0976282cd489c4337ee7014b0d4ce09c6dbb7eea9dc181ff0e9ae",
    "0x65a13db14faabd5ba934cd395d10dd3028fbf09be661fc71c18ee782b1e5d4fe",
    "0x8551789f3e6a223577d7197e685880d8a2d06b5881c286f89787ef62b90df1b3"
   ]
  },
  "escape": {
   "mode": false,
   "available": false,
   "lastAttestationAtMs": 1790159405000,
   "escapeDelaySec": 604800,
   "availableAtMs": 1790764205000,
   "secondsUntilAvailable": 604693,
   "poolWei": "0",
   "claimedWei": "0"
  }
 },
 "proofNone": {
  "account": "0x000000000000000000000000000000000000dead",
  "chainId": 0,
  "vault": "0x59d8574581250385570e41d8d66823113b954bfe",
  "attestation": {
   "seq": "55",
   "root": "0x7d80ada481cbc30f5399ad7f3f83212e57d4dce7263efd2f64ad1a3efb02c605",
   "asOf": "1790159405",
   "asOfMs": 1790159405000,
   "liabilitiesWei": "9610080000000000000000",
   "source": "vault",
   "txHash": "0x8a1c36829de10a816d0eedf1fe2252e54e471b5060de1038e21f0894fb8411f4"
  },
  "included": false,
  "balanceWei": "0",
  "proof": [],
  "currentOwedWei": "0",
  "claim": {
   "function": "claimEscape(uint256,bytes32[])",
   "attestedBalance": "0",
   "proof": []
  },
  "escape": {
   "mode": false,
   "available": false,
   "lastAttestationAtMs": 1790159405000,
   "escapeDelaySec": 604800,
   "availableAtMs": 1790764205000,
   "secondsUntilAvailable": 604692,
   "poolWei": "0",
   "claimedWei": "0"
  },
  "note": "No leaf for this account in the attested tree: claim with attestedBalance 0 and an empty proof."
 },
 "stream": {
  "overview": {
   "network": "offline",
   "chainId": 0,
   "operator": "0xa4f055c11ee3e816b10e326174f909cc1609ecb7",
   "vault": "0x59d8574581250385570e41d8d66823113b954bfe",
   "token": "0xe02596708a77590086881fb61abfdf02883d8cec",
   "ledgerSigner": "0xd89c1ab7b635216cd63366f8bc19250964169023",
   "feedMode": "replay",
   "speed": 10,
   "clockMs": 1790159513750,
   "equityCenti": "10004957555",
   "playerBalancesCenti": "947290",
   "openLiabilityCenti": "565718",
   "limitUsage": {
    "global": 0.002827188407211183,
    "maxColumn": 0.005523941561210445,
    "maxCell": 0.014308507272944802,
    "maxAccount": 0.007133763436776218
   },
   "registeredPlayers": 4672,
   "activePlayers5m": 338,
   "launch": {
    "enabled": true,
    "active": true,
    "edge": 0.03,
    "untilPlayers": 10000,
    "standardEdge": 0.08
   },
   "breakers": [
    {
     "id": "feedStale",
     "market": "btc-usd",
     "state": "ok",
     "since": 1790128800250,
     "reason": "fresh price"
    },
    {
     "id": "feedStale",
     "market": "eth-usd",
     "state": "ok",
     "since": 1790128800250,
     "reason": "fresh price"
    },
    {
     "id": "drawdown",
     "state": "ok",
     "since": 1790128800000,
     "reason": ""
    },
    {
     "id": "equityFloor",
     "state": "ok",
     "since": 1790128800250,
     "reason": "equity at or above floor"
    },
    {
     "id": "manual",
     "state": "ok",
     "since": 1790151789490,
     "reason": "Console live contract test (scratch server)"
    },
    {
     "id": "manual",
     "market": "btc-usd",
     "state": "ok",
     "since": 1790151789490,
     "reason": "Console live contract test (scratch server)"
    },
    {
     "id": "manual",
     "market": "eth-usd",
     "state": "ok",
     "since": 1790128800000,
     "reason": ""
    }
   ],
   "markets": [
    {
     "id": "btc-usd",
     "enabled": true,
     "paused": false,
     "lastPriceMs": 1790159512000,
     "spot": "85771.17592963",
     "sigma": 0.00007086636028693033,
     "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
     "quoteReason": null
    },
    {
     "id": "eth-usd",
     "enabled": true,
     "paused": false,
     "lastPriceMs": 1790159512000,
     "spot": "2731.20905196",
     "sigma": 0.00008780723104524424,
     "tableId": "maya-calibrated-v3:eth-usd:2026-09-23T08:22:47.000Z:2ee66da4",
     "quoteReason": null
    }
   ],
   "handle24hCenti": "552177430",
   "ggr24hCenti": "4967255",
   "rtp24h": 0.9910000593200989,
   "betsPerMin": 1399,
   "pricing": {
    "standardEdge": 0.08,
    "capX100": 5000,
    "aboveCap": "hide",
    "impactK": 0.02,
    "z": 0
   },
   "limits": {
    "cellFraction": 0.001,
    "columnFraction": 0.005,
    "globalFraction": 0.02,
    "accountFraction": 0.002,
    "maxStakePerBetCenti": "1000000",
    "maxStakePerCellCenti": "5000000"
   },
   "sim": {
    "running": true,
    "speed": 10,
    "arrivalsPerMin": 8
   },
   "equityOnchainCenti": "10000136790",
   "simPnlCenti": "4820765",
   "simBalancesCenti": "553701085",
   "simCreditIssuedCenti": "558772200",
   "dustWei": "0",
   "openLegs": 323,
   "drawdown1h": 6.250897174034945e-7,
   "runId": "console-qa-1",
   "journalSeq": 2208477,
   "lastRefitMs": 1790151816620,
   "simArrived": 4086,
   "simTarget": 12000,
   "feed": {
    "mode": "replay",
    "clockMs": 1790159513750,
    "speed": 10,
    "done": false,
    "markets": [
     {
      "market": "btc-usd",
      "lastT": 1790159512
     },
     {
      "market": "eth-usd",
      "lastT": 1790159512
     }
    ]
   },
   "chainAlerts": [],
   "holdPending": 36,
   "holdRejectRate": 0.08509117329958281,
   "holdLatencyP95Ms": 1500,
   "toxicFlowShare": 0.027454678845498067,
   "defenses": {
    "hold": true,
    "quoteValidity": true,
    "minLeadS": 4,
    "ramp": true,
    "toxicity": "graduated",
    "controller": true,
    "reference": false
   },
   "controller": {
    "enabled": true,
    "ranges": [
     {
      "key": "1.01-2",
      "adjust": 0.003921,
      "effective": 0.003921,
      "realized": 0.9669726139887223,
      "target": 0.9700000000000001,
      "bets": 98398
     },
     {
      "key": "2-5",
      "adjust": 0.04,
      "effective": 0.04,
      "realized": 0.9965609861534567,
      "target": 0.9700000000000006,
      "bets": 99308
     },
     {
      "key": "5-10",
      "adjust": 0.02,
      "effective": 0.02,
      "realized": 0.9828346889835018,
      "target": 0.9700000000000002,
      "bets": 10200
     },
     {
      "key": "10-20",
      "adjust": 0,
      "effective": 0,
      "realized": 0.7372344592262142,
      "target": 0.9699999999999996,
      "bets": 2344
     },
     {
      "key": "20-50",
      "adjust": 0,
      "effective": 0,
      "realized": 1.4156562200629534,
      "target": 0.9700000000000001,
      "bets": 697
     },
     {
      "key": "50-100",
      "adjust": 0,
      "effective": 0,
      "realized": null,
      "target": null,
      "bets": 0
     }
    ]
   }
  },
  "settlement": {
   "legId": "L506783",
   "requestId": "sim:03748:141",
   "quoteId": "4557f91b.btc-usd.1790159483.40",
   "account": "sim:03748",
   "kind": "sim",
   "strategy": "chaser",
   "market": "btc-usd",
   "cellId": "maya-cell-v1:btc-usd:1790159515000:1790159520000:85780:85790",
   "start": 1790159515000,
   "end": 1790159520000,
   "bandIndex": 8578,
   "lower": "85780",
   "upper": "85790",
   "stakeCenti": "40",
   "x100": 553,
   "payoutCenti": "221",
   "status": "lost",
   "placedMs": 1790159485050,
   "phase": "launch",
   "edge": 0.05,
   "p": 0.17164558146506217,
   "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
   "requestedMs": 1790159484800,
   "heldMs": 250,
   "pFresh": 0.18082181513625883,
   "ctlAdjust": 0.02,
   "flagged": false,
   "settledMs": 1790159521220,
   "creditCenti": "0",
   "evidenceSampleIds": [
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159515000",
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159516000",
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159517000",
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159518000",
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159519000",
    "maya-observed-v2:lynx:bsc:0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43:1790159520000"
   ],
   "settlementReason": "The completed recorded path missed your square."
  },
  "bet": {
   "legId": "L507654",
   "requestId": "sim:03126:97",
   "quoteId": "4557f91b.btc-usd.1790159520.11",
   "account": "sim:03126",
   "kind": "sim",
   "strategy": "casual",
   "market": "btc-usd",
   "cellId": "maya-cell-v1:btc-usd:1790159530000:1790159535000:85760:85770",
   "start": 1790159530000,
   "end": 1790159535000,
   "bandIndex": 8576,
   "lower": "85760",
   "upper": "85770",
   "stakeCenti": "130",
   "x100": 277,
   "payoutCenti": "360",
   "status": "open",
   "placedMs": 1790159521950,
   "phase": "launch",
   "edge": 0.07,
   "p": 0.33531119701695805,
   "tableId": "maya-calibrated-v3:btc-usd:2026-09-23T08:22:32.000Z:1c5f0b64",
   "requestedMs": 1790159520660,
   "heldMs": 1290,
   "pFresh": 0.3632270813857375,
   "ctlAdjust": 0.04,
   "flagged": false
  }
 }
};
