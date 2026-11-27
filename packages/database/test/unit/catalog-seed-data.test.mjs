/**
 * The catalogue seed's content, checked without a database.
 *
 * Every assertion here mirrors a constraint the database already enforces. That is
 * the point: the SQL refuses a malformed row at insert time, which is late and only
 * on a machine that runs the seed. These fail in `pnpm test`, before anyone's
 * environment has half a catalogue in it — and a failure names the row instead of
 * printing a `CHECK` violation from a transaction that has already rolled back.
 *
 * The one assertion that is not a mirror is the OPEN-20 decision itself: kedelai and
 * cabai must carry no water rule. That is a judgement, so it needs a test or it is
 * only a comment.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ACCESSED_AT,
  CATALOGUE,
  RULE_VERSION,
  SOURCES,
} from "../../scripts/lib/catalog-seed-data.mjs";

const DIMENSIONS = new Set(["climate", "water", "soil", "timing", "risk"]);
const COMPARATORS = new Set(["min", "max", "range", "count", "window"]);
const GRADES = new Set(["A", "B", "C", "D"]);
const SEVERITIES = new Set(["hard", "soft", "risk"]);
const CYCLE_STARTS = new Set(["sowing", "transplant"]);

const bySlug = new Map(CATALOGUE.map((entry) => [entry.crop.slug, entry]));

describe("catalogue seed identity", () => {
  test("four crops, unique slugs that satisfy the SQL slug shape", () => {
    assert.equal(CATALOGUE.length, 4);
    assert.equal(bySlug.size, 4);
    for (const { crop } of CATALOGUE) {
      assert.match(crop.slug, /^[a-z][a-z0-9-]*$/, `${crop.slug} violates crops_slug_shape_check`);
      assert.notEqual(crop.nameId.trim(), "");
      assert.notEqual(crop.nameEn.trim(), "");
    }
  });

  test("the rule version names the evidence it came from, not a build number", () => {
    assert.match(RULE_VERSION, /^[a-z0-9-]+-\d{4}-\d{2}-\d{2}$/);
  });
});

describe("cultivars", () => {
  test("duration order and positivity hold, as cultivars_duration_order_check requires", () => {
    for (const { crop, cultivar } of CATALOGUE) {
      assert.ok(cultivar.durationDaysMin > 0, `${crop.slug} duration min must be > 0`);
      assert.ok(
        cultivar.durationDaysMin <= cultivar.durationDaysTypical &&
          cultivar.durationDaysTypical <= cultivar.durationDaysMax,
        `${crop.slug} duration must be ordered min <= typical <= max`,
      );
    }
  });

  test("cycle start is a known value and the nursery stage is absent or positive", () => {
    for (const { crop, cultivar } of CATALOGUE) {
      assert.ok(CYCLE_STARTS.has(cultivar.cycleStart), `${crop.slug} has an unknown cycleStart`);
      assert.ok(
        cultivar.nurseryDays === null || cultivar.nurseryDays > 0,
        `${crop.slug} nurseryDays must be null or > 0`,
      );
      assert.ok(
        cultivar.altitudeMinM === null ||
          cultivar.altitudeMaxM === null ||
          cultivar.altitudeMinM <= cultivar.altitudeMaxM,
        `${crop.slug} altitude range is inverted`,
      );
    }
  });
});

describe("growth stages", () => {
  test("exactly one critical stage per profile, as growth_stages_one_critical_key requires", () => {
    for (const { crop, stages } of CATALOGUE) {
      const critical = stages.filter((stage) => stage.critical);
      assert.equal(critical.length, 1, `${crop.slug} must have exactly one critical stage`);
    }
  });

  test("stage names are unique and offsets are ordered and non-overlapping", () => {
    for (const { crop, stages } of CATALOGUE) {
      assert.equal(
        new Set(stages.map((stage) => stage.name)).size,
        stages.length,
        `${crop.slug} repeats a stage name`,
      );
      for (const [index, stage] of stages.entries()) {
        assert.ok(stage.start >= 0, `${crop.slug}/${stage.name} starts before day 0`);
        assert.ok(stage.end >= stage.start, `${crop.slug}/${stage.name} ends before it starts`);
        const previous = stages[index - 1];
        if (previous !== undefined) {
          assert.ok(
            stage.start > previous.end,
            `${crop.slug}/${stage.name} overlaps ${previous.name}`,
          );
        }
      }
    }
  });

  test("the last stage ends within the cultivar's slowest cycle", () => {
    for (const { crop, cultivar, stages } of CATALOGUE) {
      const last = stages[stages.length - 1];
      assert.ok(
        last.end <= cultivar.durationDaysMax,
        `${crop.slug}: last stage ends at ${last.end}, beyond the ${cultivar.durationDaysMax}-day maximum`,
      );
    }
  });
});

describe("constraints", () => {
  test("every rule matches constraints_shape_check for its comparator", () => {
    for (const { crop, constraints } of CATALOGUE) {
      for (const rule of constraints) {
        const label = `${crop.slug}/${rule.dimension}/${rule.comparator}`;
        assert.ok(DIMENSIONS.has(rule.dimension), `${label} has an unknown dimension`);
        assert.ok(COMPARATORS.has(rule.comparator), `${label} has an unknown comparator`);
        assert.notEqual(rule.comparator, "window", `${label} uses the rejected window comparator`);
        assert.ok(GRADES.has(rule.grade), `${label} has an unknown grade`);
        assert.ok(SEVERITIES.has(rule.severity), `${label} has an unknown severity`);

        const lower = rule.lower ?? null;
        const upper = rule.upper ?? null;
        const unit = rule.unit ?? null;
        switch (rule.comparator) {
          case "min":
            assert.deepEqual(
              [lower !== null, upper === null, unit !== null],
              [true, true, true],
              label,
            );
            break;
          case "max":
            assert.deepEqual(
              [upper !== null, lower === null, unit !== null],
              [true, true, true],
              label,
            );
            break;
          case "range":
            assert.deepEqual(
              [lower !== null, upper !== null, unit !== null],
              [true, true, true],
              label,
            );
            assert.ok(lower <= upper, `${label} lower exceeds upper`);
            break;
          default:
            assert.fail(`${label}: the seed ships no count rules`);
        }
      }
    }
  });

  test("each dimension carries a unit that can measure it", () => {
    // A copy-paste that put `unit: "mm"` on a soil rule still satisfies the SQL, and
    // still satisfies every other assertion here. It is nonsense to a reader.
    const UNITS = {
      water: new Set(["cm", "mm"]),
      soil: new Set(["pH"]),
      climate: new Set(["°C"]),
    };
    for (const { crop, constraints } of CATALOGUE) {
      for (const rule of constraints) {
        // A dimension with no unit rule is a decision this test refuses to make
        // silently: `timing` and `risk` are legal in the schema and the seed ships
        // none, so the day one appears is the day someone states its unit.
        const allowed = UNITS[rule.dimension];
        assert.ok(
          allowed !== undefined,
          `${crop.slug}: no unit rule for the ${rule.dimension} dimension`,
        );
        assert.ok(
          allowed.has(rule.unit),
          `${crop.slug}: a ${rule.dimension} rule is measured in ${rule.unit}`,
        );
      }
    }
  });

  test("a stage-scoped rule names a stage that exists in the same profile", () => {
    for (const { crop, stages, constraints } of CATALOGUE) {
      const names = new Set(stages.map((stage) => stage.name));
      for (const rule of constraints) {
        if (rule.stage !== null) {
          assert.ok(
            names.has(rule.stage),
            `${crop.slug} rule points at missing stage ${rule.stage}`,
          );
        }
      }
    }
  });

  test("only a grade A threshold may be a hard gate", () => {
    // The matrix's rule: hard requires an A source; B may soften, C may caveat.
    for (const { crop, constraints } of CATALOGUE) {
      for (const rule of constraints) {
        if (rule.severity === "hard") {
          assert.equal(rule.grade, "A", `${crop.slug} gates on a grade ${rule.grade} threshold`);
        }
      }
    }
  });

  test("kedelai and cabai ship no water rule, which is what OPEN-20 decided", () => {
    // Their water dimension is `insufficient_data` in the matrix. A constraint row
    // cannot say "unknown", so the absence is the decision, and an absence no test
    // states is how a later seed quietly fills the gap with an invented number.
    for (const slug of ["kedelai", "cabai"]) {
      const water = bySlug.get(slug).constraints.filter((rule) => rule.dimension === "water");
      assert.deepEqual(water, [], `${slug} must carry no water threshold in v1`);
    }
  });

  test("every profile has at least one rule, because an empty rulebook cannot be assessed", () => {
    for (const { crop, constraints } of CATALOGUE) {
      assert.ok(constraints.length > 0, `${crop.slug} publishes an empty rulebook`);
    }
  });
});

describe("sources", () => {
  test("every citation is resolvable: http(s), in-range year, dated access, graded", () => {
    for (const { crop, sources } of CATALOGUE) {
      assert.ok(sources.length > 0, `${crop.slug} cites nothing`);
      for (const source of sources) {
        const label = `${crop.slug}/${source.publisher}`;
        assert.match(source.url, /^https?:\/\//, `${label} has a non-http url`);
        assert.ok(
          source.publicationYear >= 1900 && source.publicationYear <= 2100,
          `${label} has an out-of-range year`,
        );
        assert.ok(GRADES.has(source.grade), `${label} has an unknown grade`);
        assert.notEqual(source.title.trim(), "", `${label} has a blank title`);
        assert.notEqual(source.publisher.trim(), "", `${label} has a blank publisher`);
      }
    }
  });

  test("a bare-origin citation says it is a site, not the document", () => {
    // A homepage answers 200 and contains none of the thresholds it is cited for.
    // The rule is not "never cite a homepage" — sometimes that is all there is —
    // but the title has to admit it, because the interface renders the title next
    // to a grade and a clickable link.
    for (const { crop, sources } of CATALOGUE) {
      for (const source of sources) {
        const { pathname } = new URL(source.url);
        if (pathname === "/" || pathname === "") {
          assert.match(
            source.title,
            /not published at a stable URL/,
            `${crop.slug}: ${source.url} is a site root, so the title must say the document is not linked`,
          );
        }
      }
    }
  });

  test("the access date is a real calendar date, and it is shared", () => {
    assert.match(ACCESSED_AT, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(!Number.isNaN(Date.parse(`${ACCESSED_AT}T00:00:00Z`)));
  });

  test("a profile cites only sources from the shared table", () => {
    const known = new Set(Object.values(SOURCES));
    for (const { crop, sources } of CATALOGUE) {
      for (const source of sources) {
        assert.ok(known.has(source), `${crop.slug} cites an object outside SOURCES`);
      }
    }
  });
});
