export const DATA_README = `# Maya market log

Written by apps/recorder in the Q-Maya repository. One new price point per second per market.
Files are cut into five-hour segments counted from the Unix epoch and named by their UTC start, e.g. \`prices-btc-usd-20260921T0700Z.csv.gz\`.
A closed segment is gzipped once and never changes. Read with \`pandas.read_csv(path)\` or \`zcat\`.

## prices-<market>-<segment>.csv.gz
| column | meaning |
| --- | --- |
| t | source time of the price point, Unix seconds |
| first | first value the recorder saw for that second. The game plays on this value and ignores later revisions |
| final | value after the three-second stabilization; empty when the source gave conflicting finals |
| lag_ms | source-clock delay between t and the first sighting. Above 3000 means the row was backfilled after a restart, so first equals final |

A restart can repeat up to 70 seconds of rows across a segment boundary. De-duplicate on t, keeping the first row.

## odds-<market>-<segment>.csv.gz
One row per new price point: the odds the game shows once that point is its newest.
When one poll delivers two points, both get a row; the older one then shows an age_ms near 2000.
| column | meaning |
| --- | --- |
| t | source time of the latest price point used, Unix seconds |
| age_ms | source-clock age of that point when the odds were calculated |
| spot | price used as spot (the first-seen value) |
| sigma | EWMA volatility per square-root second, 9 significant digits |
| start | start of window 0, Unix seconds. Window w starts at start + 5*w and lasts 5 seconds |
| bucket | index of the price band that contains spot. Band b covers [ (bucket+b)*band, (bucket+b+1)*band ]; band is 10 for BTC/USD and 0.5 for ETH/USD |
| w0b-3 ... w5b3 | payout multiplier times 100 for window w and band offset b (185 means 1.85x). A negative value is an unavailability code, listed in the meta file |

The win probability is not stored. It is exactly recomputable from spot, sigma, the cell and the
pinned table and config named in the meta file, using packages/pricing in the repository.

## meta-<segment>.jsonl.gz
One JSON line at the start of each segment and after each recorder restart: model, table hash, provider config
(house edge, minimum payout, lead time), policies, market definitions, column list and unavailability codes.
`;
