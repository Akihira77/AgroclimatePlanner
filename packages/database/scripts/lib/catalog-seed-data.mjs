/**
 * The v1 catalogue as data: four crops, one cultivar each, one rulebook each.
 *
 * Kept separate from `scripts/seed-catalog.mjs` so the content can be checked
 * without a database. The shape rules are enforced twice on purpose — here by the
 * SQL constraints and triggers, and in `test/unit/catalog-seed-data.test.mjs` by
 * assertions a reviewer can read. A seed that fails a CHECK halfway through a
 * transaction is a rollback; a seed that fails a test is a diff comment.
 */

/** Evidence date of the matrix; the rule version names its source, not a build. */
const RULE_VERSION = "agronomic-matrix-2026-11-18";

const ACCESSED_AT = "2026-11-28";

const SOURCES = {
  fao56: {
    title:
      "Crop evapotranspiration: Guidelines for computing crop water requirements (FAO Irrigation and Drainage Paper 56)",
    authors: "Allen, R.G.; Pereira, L.S.; Raes, D.; Smith, M.",
    publicationYear: 1998,
    publisher: "Food and Agriculture Organization of the United Nations",
    url: "https://www.fao.org/3/x0490e/x0490e00.htm",
    grade: "A",
  },
  faoIrrigationNeeds: {
    title: "Irrigation Water Management: Irrigation Water Needs (Training manual no. 3)",
    authors: "Brouwer, C.; Heibloem, M.",
    publicationYear: 1986,
    publisher: "FAO Land and Water Development Division",
    url: "https://www.fao.org/4/s2022e/s2022e00.htm",
    grade: "A",
  },
  // The next two are institutional homepages, not the documents. The variety
  // descriptions and the SOP exist but are not published at a stable URL, so the
  // title says so: a link that opens a homepage satisfies "resolves" while telling
  // the reader nothing, and calling it the document would be a lie the interface
  // repeats next to a grade A tag.
  brmp: {
    title: "BRMP official site — variety descriptions not published at a stable URL",
    authors: null,
    publicationYear: 2024,
    publisher: "Balai Penelitian Tanaman Aneka Kacang dan Umbi (BRMP), Kementerian Pertanian RI",
    url: "https://brmp.pertanian.go.id/",
    grade: "A",
  },
  balitsa: {
    title:
      "Kementerian Pertanian RI official site — Balitsa SOP Cabai Merah 2014 not published at a stable URL",
    authors: null,
    publicationYear: 2014,
    publisher: "Balai Penelitian Tanaman Sayuran (Balitsa), Kementerian Pertanian RI",
    url: "https://www.pertanian.go.id/",
    grade: "A",
  },
};

/**
 * Day offsets are in the cultivar's own cycle units: `transplant` for padi and
 * cabai, `sowing` for jagung and kedelai. Each profile has exactly one critical
 * stage — the SQL partial unique index enforces it.
 */
const CATALOGUE = [
  {
    crop: { slug: "padi", nameId: "Padi", nameEn: "Rice", category: "pangan" },
    cultivar: {
      name: "Ciherang",
      durationDaysMin: 110,
      durationDaysTypical: 115,
      durationDaysMax: 120,
      cycleStart: "transplant",
      nurseryDays: 21,
      altitudeMinM: 0,
      altitudeMaxM: 650,
    },
    // Phase lengths are the matrix's (vegetative ±45–65, reproductive ±35,
    // ripening ±30, all grade A), fitted to a 115-day cycle by taking the middle of
    // the vegetative range: 50 + 35 + 30. The critical window is the reproductive
    // phase, because anthesis sits inside it and no source dates it more precisely
    // for Ciherang.
    stages: [
      { name: "vegetatif", start: 0, end: 49, critical: false },
      { name: "reproduktif", start: 50, end: 84, critical: true },
      { name: "pemasakan", start: 85, end: 114, critical: false },
    ],
    constraints: [
      {
        dimension: "water",
        comparator: "range",
        lower: 5,
        upper: 10,
        unit: "cm",
        stage: null,
        grade: "A",
        severity: "hard",
      },
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.5,
        upper: 6.5,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 450,
        upper: 700,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 35,
        unit: "°C",
        stage: "reproduktif",
        grade: "B",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 20,
        unit: "°C",
        stage: "reproduktif",
        grade: "B",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.faoIrrigationNeeds],
  },
  {
    crop: { slug: "jagung", nameId: "Jagung", nameEn: "Maize", category: "pangan" },
    cultivar: {
      name: "Lamuru",
      durationDaysMin: 90,
      durationDaysTypical: 93,
      durationDaysMax: 95,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: 0,
      altitudeMaxM: 1200,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 50, critical: false },
      { name: "silking", start: 58, end: 67, critical: true },
      { name: "pengisian biji", start: 68, end: 89, critical: false },
      { name: "pemasakan", start: 90, end: 95, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5,
        upper: 7.5,
        unit: "pH",
        stage: null,
        grade: "C",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 500,
        upper: 800,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 38,
        unit: "°C",
        stage: "silking",
        grade: "A",
        severity: "soft",
      },
    ],
    sources: [SOURCES.faoIrrigationNeeds],
  },
  {
    crop: { slug: "kedelai", nameId: "Kedelai", nameEn: "Soybean", category: "pangan" },
    cultivar: {
      name: "Anjasmoro",
      // 82.5–92.5 in the matrix, rounded inward: the columns are integer days and a
      // wider range would claim tolerance the source does not state.
      durationDaysMin: 83,
      durationDaysTypical: 88,
      durationDaysMax: 92,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: null,
      altitudeMaxM: null,
    },
    stages: [
      // Flowering onset for Anjasmoro is 35.7–39.4 HST (grade A); the critical stage
      // starts at 35 so the window is not narrower than the evidence.
      { name: "vegetatif", start: 0, end: 34, critical: false },
      { name: "pembungaan dan pengisian polong", start: 35, end: 75, critical: true },
      { name: "pemasakan", start: 76, end: 88, critical: false },
    ],
    // No water rule: seasonal ETc is unverified and the monthly band is grade C,
    // so the matrix keeps the dimension `insufficient_data`.
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 6,
        upper: 6.8,
        unit: "pH",
        stage: null,
        grade: "C",
        severity: "soft",
      },
    ],
    sources: [SOURCES.brmp],
  },
  {
    crop: { slug: "cabai", nameId: "Cabai", nameEn: "Chili", category: "hortikultura" },
    cultivar: {
      name: "Prima Agrihorti",
      durationDaysMin: 115,
      durationDaysTypical: 130,
      durationDaysMax: 149,
      cycleStart: "transplant",
      nurseryDays: 28,
      altitudeMinM: null,
      altitudeMaxM: 1400,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 43, critical: false },
      { name: "pembungaan", start: 44, end: 71, critical: true },
      { name: "pembuahan", start: 72, end: 114, critical: false },
      // Prima Agrihorti's first harvest is 115–149 HST (grade A); a harvest stage
      // that opens at 101 would tell a planter to pick two weeks before the source does.
      { name: "panen", start: 115, end: 130, critical: false },
    ],
    // No water rule: the only monthly figure in the matrix is `unverified`, and
    // the annual band is a different unit from what the engine compares.
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 6,
        upper: 7,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      // The source gives two figures — day 25–27 °C, night 18–20 °C — and no single
      // band. Stored as two thresholds so neither end is invented.
      {
        dimension: "climate",
        comparator: "max",
        upper: 27,
        unit: "°C",
        stage: "pembungaan",
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 18,
        unit: "°C",
        stage: "pembungaan",
        grade: "A",
        severity: "soft",
      },
    ],
    sources: [SOURCES.balitsa],
  },
  {
    crop: { slug: "bawang-merah", nameId: "Bawang Merah", nameEn: "Shallot", category: "hortikultura" },
    cultivar: {
      name: "Bima Brebes",
      durationDaysMin: 60,
      durationDaysTypical: 65,
      durationDaysMax: 70,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: 0,
      altitudeMaxM: 800,
    },
    stages: [
      { name: "vegetatif awal", start: 0, end: 24, critical: false },
      { name: "pembentukan umbi", start: 25, end: 49, critical: true },
      { name: "pematangan umbi", start: 50, end: 65, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.6,
        upper: 6.5,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 350,
        upper: 550,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 32,
        unit: "°C",
        stage: "pembentukan umbi",
        grade: "B",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 25,
        unit: "°C",
        stage: "pembentukan umbi",
        grade: "B",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.balitsa],
  },
  {
    crop: { slug: "tomat", nameId: "Tomat", nameEn: "Tomato", category: "hortikultura" },
    cultivar: {
      name: "Servo F1",
      durationDaysMin: 70,
      durationDaysTypical: 75,
      durationDaysMax: 85,
      cycleStart: "transplant",
      nurseryDays: 21,
      altitudeMinM: 200,
      altitudeMaxM: 1500,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 24, critical: false },
      { name: "pembungaan dan pembentukan buah", start: 25, end: 54, critical: true },
      { name: "pematangan dan panen", start: 55, end: 75, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.5,
        upper: 6.8,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 400,
        upper: 600,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 28,
        unit: "°C",
        stage: "pembungaan dan pembentukan buah",
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 18,
        unit: "°C",
        stage: "pembungaan dan pembentukan buah",
        grade: "A",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.faoIrrigationNeeds, SOURCES.balitsa],
  },
  {
    crop: { slug: "kacang-tanah", nameId: "Kacang Tanah", nameEn: "Peanut", category: "pangan" },
    cultivar: {
      name: "Hypoma 1",
      durationDaysMin: 85,
      durationDaysTypical: 90,
      durationDaysMax: 95,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: 0,
      altitudeMaxM: 500,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 29, critical: false },
      { name: "pembungaan dan pembentukan ginofor", start: 30, end: 64, critical: true },
      { name: "pengisian polong", start: 65, end: 90, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.5,
        upper: 7.0,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 400,
        upper: 600,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 32,
        unit: "°C",
        stage: "pembungaan dan pembentukan ginofor",
        grade: "B",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 25,
        unit: "°C",
        stage: "pembungaan dan pembentukan ginofor",
        grade: "B",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.brmp],
  },
  {
    crop: { slug: "kentang", nameId: "Kentang", nameEn: "Potato", category: "hortikultura" },
    cultivar: {
      name: "Granola L",
      durationDaysMin: 95,
      durationDaysTypical: 100,
      durationDaysMax: 110,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: 1000,
      altitudeMaxM: 2000,
    },
    stages: [
      { name: "vegetatif", start: 0, end: 34, critical: false },
      { name: "pembentukan umbi", start: 35, end: 74, critical: true },
      { name: "pematangan umbi", start: 75, end: 100, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.0,
        upper: 6.2,
        unit: "pH",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 500,
        upper: 700,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 22,
        unit: "°C",
        stage: "pembentukan umbi",
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 15,
        unit: "°C",
        stage: "pembentukan umbi",
        grade: "A",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.faoIrrigationNeeds, SOURCES.balitsa],
  },
  {
    crop: { slug: "ubi-kayu", nameId: "Ubi Kayu", nameEn: "Cassava", category: "pangan" },
    cultivar: {
      name: "UJ-5 (Kasetsart)",
      durationDaysMin: 240,
      durationDaysTypical: 255,
      durationDaysMax: 270,
      cycleStart: "sowing",
      nurseryDays: null,
      altitudeMinM: 0,
      altitudeMaxM: 1000,
    },
    stages: [
      { name: "pertumbuhan awal", start: 0, end: 59, critical: false },
      { name: "pembentukan akar umbi", start: 60, end: 149, critical: true },
      { name: "akumulasi pati dan panen", start: 150, end: 255, critical: false },
    ],
    constraints: [
      {
        dimension: "soil",
        comparator: "range",
        lower: 5.0,
        upper: 7.5,
        unit: "pH",
        stage: null,
        grade: "B",
        severity: "soft",
      },
      {
        dimension: "water",
        comparator: "range",
        lower: 500,
        upper: 1200,
        unit: "mm",
        stage: null,
        grade: "A",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "max",
        upper: 34,
        unit: "°C",
        stage: "pembentukan akar umbi",
        grade: "B",
        severity: "soft",
      },
      {
        dimension: "climate",
        comparator: "min",
        lower: 22,
        unit: "°C",
        stage: "pembentukan akar umbi",
        grade: "B",
        severity: "soft",
      },
    ],
    sources: [SOURCES.fao56, SOURCES.brmp],
  },
];

export { RULE_VERSION, CATALOGUE, SOURCES, ACCESSED_AT };
