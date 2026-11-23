# Benchmark

Written by `npm run bench` (`bench/run.ts`) on 2026-11-23, Node v24.14.1, seed 20261123.
All terrain here is synthetic with a known answer. No real parcel is used.

## Slope (Horn method, 2 m cells)

200 surfaces, each a random plane (up to 40% each way) plus a random Gaussian hill, compared with the exact gradient at 320,000 interior cells.

| Measure | Result |
| --- | --- |
| Mean absolute error | 0.01 slope points |
| 99th percentile error | 0.13 slope points |
| Same class as the exact slope (under 15 / 15 to 25 / over 25) | 100.0% of 320,000 cells |

## Balanced-pad cut and fill (2 m cells)

200 pads of 60 x 50 ft on planes up to 30% slope at random aspect. Truth is the same mean-grade pad integrated at 0.05 m. 195 pads with more than 5 CY of cut are scored.

| Measure | Result |
| --- | --- |
| Mean error in cut CY, area-weighted cells (what the app uses) | 3.9% |
| 90th percentile error, area-weighted | 8.2% |
| Mean error with plain 2 m x 2 m cells (before v0.2.0) | 9.7% |

The rest of the error comes from the pad edge: on a 2 m grid the cells whose centers fall inside the pad do not trace its outline exactly.

## Lot layout on turned ridges

100 flat strips (45 to 90 m wide, 250 to 450 m long) at random angles, with 30 m of steep ground around them inside the boundary. Half-acre lots, 25 ft setback, 60 x 50 ft pads.

| Measure | Result |
| --- | --- |
| Lots, north-aligned grid only | 1,275 |
| Lots, grid turned to the best candidate angle | 1,560 |
| Ridges where turning the grid added lots | 85 of 100 |
| Pads at least 85% on truly flat ground (checked at 0.5 m against the strip, not the class grid) | 1560 of 1560 |
| Lot corners outside the boundary | 0 |
| Layout time, north plus best angle, per ridge | 18.2 ms |

The app requires 90% flat on the 2 m class grid; the 85% check allows for cells cut by the strip edge.

## Pro forma bookkeeping

1000 random assumption sets x 4 exits x 3 cases = 12,000 runs.

| Measure | Result |
| --- | --- |
| Largest gap between profit and the sum of equity cash flows | $8.2e-8 |
| Largest gap between sources and uses | $7.5e-8 |
| Runs where sales did not repay the loan (equity covers the shortfall) | 2,731 |

## Speed

| Measure | Result |
| --- | --- |
| Slope pass on a 900 x 900 grid | 25 ms |
