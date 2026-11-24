# Seasonal ensemble spread — investigation

**Status:** investigation only. No spread is computed, persisted, or served. Nothing in
this document is implemented, and the last section is a list of decisions an owner has
to make, not a record of decisions made.

**Scope:** which descriptor of the 50-member SEAS5 ensemble's dispersion belongs in
`monthly_outlooks.ensemble_spread_mm`, over which member population, with which
missing-data and provenance rules, and how the read contract should carry it.

**Out of scope:** the seasonal aggregation rule, mean→total conversion, probabilities
and terciles, skill, bias correction, and any UI.

Evidence is tagged:

- **Verified** — read from this repository or produced by a command in it.
- **Reported** — received from a provider or a source outside the repository.
- **Concern** — a risk or gap identified here, not a defect in shipped code.

---

## 1. What exists today

| Item | State | Evidence |
|---|---|---|
| `monthly_outlooks.ensemble_spread_mm` | `double precision`, `CHECK (>= 0)`, nullable. **One scalar.** No writer | Verified — `20261118030000_domain_tables/migration.sql` |
| `monthly_outlooks.spread_unavailable_reason` | `text`, nullable. `monthly_outlooks_spread_check` forces `(ensemble_spread_mm IS NULL) = (spread_unavailable_reason IS NOT NULL)`. **No CHECK on the value**, and `outlookMonthSchema` types it `z.string().min(1)`, so any token is representable | Verified — same migration; `packages/contracts/src/climate.ts` |
| Reason tokens in use | `no_value`, `climatology_has_no_ensemble` | Verified — `packages/climate-core/src/aggregate.ts` |
| Member-level source rows | `weather_records` holds one row per `(forecast_run, cell_key, variable, valid_at, ensemble_member)`; `ensemble_member` and `ensemble_size` exist; `aggregation_level` in use includes `monthly_sum` | Verified — same migration, `weather_records_live_key` |
| Provider member series | SEAS5 monthly adapter returns the provider's `precipitation_mean`; the 50-member monthly series is what the cross-check was measured on | Verified/Reported — `packages/weather-core/src/adapters/open-meteo-seasonal.ts:85-92` records the member aggregation evidence; the 50-member shape is the provider response, not a repository constant |
| A spread derivation | none | Verified — no code writes `ensemble_spread_mm` |

Two facts follow from that table, and they bound every option below:

1. **The storage is one non-negative scalar in millimetres.** Any descriptor whose natural
   output is two numbers (an interval) fits the column only if the *width* is stored and the
   endpoints are recomputed or dropped.
2. **The spread reason is unenumerated.** A second writer can introduce a token nothing
   renders, and nothing stops it. **Concern:** any new reason (`insufficient_members`,
   say) should be added to the contract enum and the database CHECK in the same change, or
   the honesty rule becomes a convention.

---

## 2. The five candidate descriptors

`x₁…x_m` are the members' **monthly totals** for one calendar month of one
initialisation, in mm. The budget quantity is a monthly accumulation, so every statistic
below is in mm per month, not mm per day.

### 2.1 Population standard deviation (÷ m)

- **Definition.** `σ = sqrt(Σ(xᵢ − x̄)² / m)` over all `m` members present.
- **Reading.** The RMS departure of a member from the ensemble mean. It describes *this
  ensemble's* dispersion — the 50 members are the whole population of interest, so ÷ m is
  the descriptive statistic, not a correction.
- **Pros.** One number; symmetric, so it composes with the mean as `x̄ ± σ`; the smallest
  storage footprint; the current column is exactly this shape.
- **Cons.** Not robust: one wild member moves it. And `x̄ ± σ` invites a probability
  reading (≈68 % under normality) that the ensemble does not license — members are
  perturbations, not a random sample from a distribution with a known family.
- **Outlier sensitivity.** Moderate. Squared deviations mean one 3σ member contributes
  9× its share.
- **Interpretability.** Familiar to anyone who has seen a mean and a spread. Frequently
  misread as a confidence interval.
- **Fit for 50 SEAS5 members.** Good arithmetically; the `÷50` vs `÷49` question is moot
  beyond 1.01× but must still be labelled (see §3).

### 2.2 Sample standard deviation (÷ (m − 1))

- **Definition.** `s = sqrt(Σ(xᵢ − x̄)² / (m − 1))`.
- **Reading.** An unbiased-ish estimator of the dispersion of a wider population the
  members are assumed to sample.
- **Pros.** Standard in statistics packages; larger, so it looks conservative.
- **Cons.** It makes a claim the ensemble does not support: 50 perturbed members are not a
  random sample from a population of possible forecasts. `s` answers "how variable would
  forecasts be if we drew more", which is not the question an outlook asks.
- **Outlier sensitivity.** Same as 2.1, scaled by `sqrt(m/(m−1))` = 1.0101 at m = 50.
- **Interpretability.** Indistinguishable from σ to a reader, which is the problem: the
  label carries a modelling assumption the number cannot show.
- **Fit.** Arithmetically fine, conceptually the weaker choice.

### 2.3 Min–max range

- **Definition.** `max(x) − min(x)`.
- **Reading.** "The wettest member minus the driest member."
- **Pros.** Trivially explainable; no distributional assumption at all; cheap.
- **Cons.** The most outlier-sensitive statistic available — a single 1-in-50 extreme sets
  it, and with 50 members the extremes are exactly the noisiest order statistics. It also
  grows with `m` for a fixed underlying dispersion, so it is not comparable across
  products with different ensemble sizes.
- **Outlier sensitivity.** Maximal.
- **Interpretability.** High, and honest as a range, but it overstates typical dispersion,
  which is what a planner cares about.
- **Fit.** Poor for 50 members; the extremes are the two least stable values in the set.

### 2.4 P10–P90 interval

- **Definition.** The 10th and 90th percentiles of the member totals, by a pinned
  interpolation rule. With `m = 50` and linear interpolation on the sorted values, P10 sits
  between the 5th and 6th smallest and P90 between the 45th and 46th.
- **Reading.** "80 % of the members were between these two amounts." That sentence is true
  of the ensemble by construction, with no normality assumption.
- **Pros.** Robust to a single wild member; assumption-free; directly interpretable as a
  member-coverage statement; naturally asymmetric, which is what monthly precipitation
  actually is.
- **Cons.** **Two numbers**, so it does not fit the single column unless only the width
  (`P90 − P10`) is stored — and the width alone loses the asymmetry that made the interval
  worth serving. The percentile itself is an estimate from 50 points, so P10/P90 have
  their own sampling noise.
- **Outlier sensitivity.** Low at the tails: 5 members would have to move before P10
  changes value.
- **Interpretability.** Highest of the five, and the hardest to misread as a probability
  for the realised month.
- **Fit for 50 members.** Adequate: 5 order statistics per tail. Not adequate for
  P05/P95, which would sit on a single order statistic.

### 2.5 Interquartile range (P75 − P25)

- **Definition.** The middle 50 % of member totals; `P75 − P25`.
- **Reading.** "Half the members were within this band around the median."
- **Pros.** The most robust single width; one scalar; comparable across ensemble sizes;
  the standard robust dispersion measure.
- **Cons.** Discards the tails entirely, which for rainfall is where the agronomic risk
  lives (a dry tail matters more than a wet one). Not symmetric with the served mean:
  `x̄ ± IQR/2` is not an IQR, and serving it that way would be wrong.
- **Outlier sensitivity.** Lowest.
- **Interpretability.** Good for statistically literate users, weaker for farmers — "half
  the members were within 60 mm of each other" needs a sentence of explanation.
- **Fit for 50 members.** Good.

### 2.6 Side-by-side

| Descriptor | Numbers | Robust | Assumption-free | Fits one column | Reads as a probability it is not | Best for |
|---|---|---|---|---|---|---|
| Population SD | 1 | no | descriptive only | yes | often | a symmetric error bar |
| Sample SD | 1 | no | no (population claim) | yes | often | nothing this product needs |
| Min–max | 1 | no | yes | yes | no, but overstates | a worst case |
| P10–P90 | 2 (or width) | yes | yes | width only | rarely | honest "80 % of members" |
| IQR | 1 | yes | yes | yes | no | a stable single width |

**Concern:** whichever descriptor is chosen, the column name `ensemble_spread_mm` is
generic enough to hide the choice. Two deployments computing different statistics would
both satisfy the schema and both render as "spread". The descriptor has to be named in
provenance (§6), not only in a document.

---

## 3. Population policy

Four questions, with a proposed answer each. These are proposals for an owner decision,
not decisions.

1. **All 50 members, or fewer when some are missing?** Propose: compute over the members
   actually present, and record how many. Never substitute the provider's
   `precipitation_mean` for a missing member, and never fill a missing member with the
   ensemble mean — both would shrink the spread while keeping the member count.
2. **Is a partial ensemble allowed?** Propose: yes, down to a floor, because a month with
   43 usable members carries real information and refusing it would leave the horizon
   emptier than the data justifies.
3. **What floor?** Propose `m ≥ 45` (90 % of 50). Rationale: the percentile positions stay
   inside the interior order statistics, and `sqrt(49/45)` is a 4 % effect on SD — small
   enough that the number still means what the label says. Below the floor, no spread is
   served and the row carries a reason (which needs a new token, §5).
4. **Same population for mean and spread?** **Yes, mandatorily.** The served `valueMm` and
   the served spread must be computed over the identical member set, or the centre does
   not describe the dispersion beside it. This is the rule that most needs to be in the
   contract: it is invisible in the output when violated.

**Concern:** `monthly_outlooks` has no member-count column, and `input_refs` is the only
place the count could live. If the count is not recorded, a later reader cannot tell
whether a spread was computed over 50 members or 45 — the two are not the same claim.

---

## 4. Missing-data policy

Three distinct situations, three distinct answers. Collapsing them is how a fabricated
value gets served.

| Situation | Rule | Why |
|---|---|---|
| No row for the month | `ensemble_spread_mm = NULL`, `spread_unavailable_reason = 'no_value'` | Already the aggregate's behaviour; nothing was computed |
| Climatology month | `NULL`, `'climatology_has_no_ensemble'` | A normal has no members; a spread there would be invented |
| Seasonal month, too few members | `NULL`, new token (`'insufficient_members'`) | Honest absence, distinguishable from "no value at all" and from "climatology" |
| Seasonal month, member present but `NULL` value | The member is excluded from `m`, not from the mean only | Excluding it from the spread but not the mean would break §3.4 |
| Seasonal month where the *mean* exists but a member total is unrecoverable | No spread **and** no value | The value and the spread share a population; a mean over 50 with a spread over 47 is not one population |

The last row is the one that will be argued about. Weaker alternative: serve the mean over
whatever is present and the spread over the same subset — that is defensible, but only if
the member count is served alongside, so the reader knows the population was partial.

---

## 5. Contract and schema impact

| Change | Needed for | Migration? |
|---|---|---|
| `spreadUnavailableReason` enumerated (`z.enum`), and a matching DB `CHECK` | a token vocabulary that two writers cannot diverge on | yes, if the CHECK is added |
| A way to name the descriptor (`spread_kind` column, or the derivation version string) | §2.6: "spread" alone does not say which statistic | no, if encoded in `derivation_version`; yes, if a column |
| A member count (`ensemble_members` column, or inside `input_refs`) | §3.4 and §4: a spread without its population size is a weaker claim than it appears | no, if inside `input_refs`; yes, if a column |
| Interval endpoints, if P10–P90 is chosen with both numbers | §2.4: the asymmetry is the point | yes, two columns or a JSONB |

The current single `ensemble_spread_mm` column is sufficient **only** for a width-shaped
descriptor (population SD, sample SD, range width, IQR, or `P90 − P10`). Choosing an
interval with its endpoints is therefore a schema change, and that is a reason to decide
the descriptor before writing any code.

---

## 6. Provenance

The derivation identity must change whenever the member inputs change, and it must name
the statistic.

- **Input references.** Per-input refs would mean one `DataInputRef` per member per month —
  50 × 12 = 600 refs on a twelve-month row. That is heavy but auditable. The alternative is
  one canonical ref per `(cell, forecast_run, variable, valid_at-range)` plus a canonical
  set hash over the ordered `(ensemble_member, value)` pairs. **Propose the canonical set
  hash**, because it is what `input_snapshot_hash` already does one level up: a hash over
  the exact member rows consumed, such that any changed member value, added member, or
  dropped member changes the identity and forces a supersession rather than an in-place
  edit.
- **Descriptor identity.** The statistic, its interpolation rule (for percentiles), and
  the missing-data floor belong in the derivation identity — `derivation_version` such as
  `seasonal-spread@1.0.0+population_sd` (proposal), or a dedicated `spread_derivation_version`
  if the spread is ever computed separately from the mean.
- **What must not happen.** A re-run that keeps the same `input_snapshot_hash` while the
  member set changed. That is the failure mode `provenance-contract.md` §4 rule 3 exists to
  prevent, and the spread is exactly the kind of derived number that tempts a "just
  recompute the statistic" shortcut.
- **Member-level vs provider-native.** The spread is computed from **member monthly
  totals**, not from `precipitation_mean` and not from the provider's own spread column if
  one exists. **Reported:** the provider does not publish a monthly ensemble spread
  alongside `precipitation_mean` in the verified response shape; even if it did, it would
  be a different statistic with different missing-data rules, and it must not silently
  stand in for ours.

---

## 7. Proposed API response structure

Not implemented, not approved. Two shapes, because the column decision and the response
decision are separable — but if the interval is chosen, the nested form is the only honest
one.

**Single scalar (fits today's columns):**

```json
{
  "leadMonth": 3,
  "month": "2027-01-01",
  "dataClass": "seasonal_forecast",
  "evaluationBasis": "monthly",
  "valueMm": 297.6,
  "unit": "mm",
  "estimator": "ensemble_mean",
  "ensembleSpreadMm": 41.2,
  "spread": {
    "kind": "population_standard_deviation",
    "members": 50
  },
  "spreadUnavailableReason": null
}
```

**Interval (needs two numbers per month):**

```json
{
  "leadMonth": 3,
  "month": "2027-01-01",
  "dataClass": "seasonal_forecast",
  "evaluationBasis": "monthly",
  "valueMm": 297.6,
  "unit": "mm",
  "estimator": "ensemble_mean",
  "spread": {
    "kind": "p10_p90",
    "lowerMm": 210.0,
    "upperMm": 388.5,
    "members": 50,
    "derivationVersion": "seasonal-spread@1.0.0"
  },
  "spreadUnavailableReason": null
}
```

Rules either shape must keep, because they are already true of the served months:

- `unit: "mm"` per month, never inferred from a field name.
- `estimator` stays `ensemble_mean` for the value; the spread's descriptor is separate — a
  mean and a spread are two different estimators.
- A month with no spread carries `spreadUnavailableReason` and **no** `spread` object; the
  existing contract rule that a missing spread must state its reason already enforces this.
- `members` is part of the payload, not a footnote, because the spread is not comparable
  without it.
- Asymmetry is preserved: no `valueMm ± spreadMm` shorthand, and no "confidence" wording.

**Concern:** `ensembleSpreadMm` as a sibling of a nested `spread` object would duplicate
the number. One of them has to go, and the choice decides whether the existing flat
contract survives or is replaced.

---

## 8. What an owner has to decide

1. Which descriptor (one of §2.1–2.5), and if a percentile interval, whether the width or
   the endpoints are stored.
2. Population policy: floor `m`, and the confirmation that mean and spread share one
   population.
3. Whether the member count gets a column or lives in `input_refs`.
4. Whether the descriptor is named in `derivation_version` or in a new column.
5. Which new `spread_unavailable_reason` tokens are admissible, and whether that field
   becomes an enum.

Until those are answered, `ensemble_spread_mm` stays `NULL` with
`spread_unavailable_reason = 'no_value'` for forecast months, which is what the aggregate
already emits — an honest absence, not a placeholder number.
