# Limitations

This is a first-pass screening tool. It helps decide whether a tract is worth paying professionals to look at. It is not a survey, an engineering design, a geotechnical report, an appraisal or legal advice.

## Terrain and slope

- **DEM resolution.** Analysis uses USGS 3DEP at about 2 m cells where it is available. 3DEP coverage and quality vary; some areas only have 10 m or 30 m data, which smooths out benches, ditches and small knobs. The terrarium fallback is coarser still (about 3.8 m at zoom 15 near Pikeville, before resampling) and blends several sources.
- **Bare earth, not today's ground.** 3DEP is a bare-earth model from the date of the LiDAR flight. Recent grading, fill, spoil piles, strip-mine benches and buildings may not match.
- **Slope limits are rules of thumb.** 15% and 25% are common screening breaks, not code. Local rules and the actual house plan decide what is buildable.
- The 3D surface you see comes from AWS Terrain Tiles; the numbers come from the 3DEP grid. They can differ slightly.

## Layout and earthwork

- Lots are squares on a north-aligned grid. Real plats follow roads, ridgelines and frontage rules, and usually fit a different count.
- No road, driveway, culvert or utility route is designed or graded. The road frontage note assumes a new internal road.
- Pads are set at the mean grade under them, so cut about equals fill per pad. There is no shrink or swell factor, no side slopes beyond the pad edge, no rock, no haul-off, no retaining walls and no compaction testing.
- Cut and fill in cubic yards are rough quantities for comparing options, not bid quantities.

## Site facts

- FEMA NFHL and USGS NHD are queried live and can be slow, down or out of date. "No flood polygon returned" can mean an unmapped area, not a safe one. Always check the effective FIRM panel.
- There is **no zoning, setback, utility, soils, septic, mineral rights, title or right-of-way data**. Those items are shown as "check with county" placeholders on purpose.
- A boundary drawn on a map is not a legal description.

## Pro forma

- Every price, cost, timeline and financing term is an illustrative assumption. The defaults are not comps or quotes for any market.
- The model is monthly and simple: costs spread evenly over set windows, one loan with a single loan-to-cost and rate, interest capitalized, sale proceeds repay the loan first. No taxes, carrying costs beyond interest, absorption risk, phasing, impact fees or contingency unless you add them through the sliders.
- Downside and upside cases are fixed multipliers on prices, costs and months, shown in the app.

## Example boundary

The demo boundary near Pikeville, Kentucky is invented for illustration. It is not a real parcel, and the app shows no ownership or parcel records.
