import type { CropCycle } from "@agroclimate/contracts";
import { useState } from "react";

import { api } from "../api.js";
import { Link } from "../router.js";
import { ErrorNotice, Empty, Loading, Mono, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

/**
 * A cycle plan, from one field and one rulebook.
 *
 * This is the projection the catalog already serves, moved to where a planting
 * decision is made: a field, a cultivar, and a start date. Nothing is stored —
 * there is no `plantings` writer and no field→cell mapping (`OPEN-27`, `OPEN-18`),
 * so the screen says "rencana" and never claims the cycle exists.
 *
 * The one thing it adds over the catalog panel is *today*: which stage the plan is
 * in, from date arithmetic alone. It is deliberately not a verdict — no weather is
 * consulted, and "the plan is on schedule" is not a claim a calendar can make.
 */
export function PlanPage() {
  const state = useAsync("plan-fields", async () => {
    const [fields, catalog] = await Promise.all([api.listFields(), api.listCrops()]);
    return { fields, crops: catalog.crops };
  });

  const [fieldId, setFieldId] = useState("");
  const [cropSlug, setCropSlug] = useState("");
  const [date, setDate] = useState(today());

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const { fields, crops } = state.data;
  const field = fields.find((entry) => entry.id === fieldId) ?? fields[0];
  const crop = crops.find((entry) => entry.slug === cropSlug) ?? crops[0];

  if (crops.length === 0) {
    return (
      <Empty>
        Katalog kosong. Jalankan <Mono>pnpm db:seed:catalog</Mono> lebih dulu.
      </Empty>
    );
  }

  return (
    <div className="stack">
      <p className="lede">
        Pilih lahan, komoditas, dan tanggal mulai tanam. Tanggal tahap dan panen dihitung dari
        rulebook terbit; rencana ini tidak disimpan.
      </p>

      <form className="panel" onSubmit={(event) => event.preventDefault()}>
        <div className="panel-body form-grid">
          <div className="field">
            <label htmlFor="plan-field">Lahan</label>
            {fields.length === 0 ? (
              <p className="muted">
                Belum ada lahan. <Link to="/lahan">Buat lahan</Link> dulu, atau tetap pilih
                komoditas untuk melihat kalender rulebook.
              </p>
            ) : (
              <select
                id="plan-field"
                value={field?.id ?? ""}
                onChange={(event) => setFieldId(event.target.value)}
              >
                {fields.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.areaHa} ha
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <label htmlFor="plan-crop">Komoditas</label>
            <select
              id="plan-crop"
              value={crop?.slug ?? ""}
              onChange={(event) => setCropSlug(event.target.value)}
            >
              {crops.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.nameId}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="plan-date">Tanggal mulai tanam</label>
            <input
              id="plan-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>
        </div>
      </form>

      {crop === undefined ? null : (
        <CropPlan slug={crop.slug} date={date} fieldName={field?.name} />
      )}
    </div>
  );
}

/**
 * One crop's published profiles, newest first. A cultivar with no published version
 * is shown as unavailable rather than hidden: an empty catalog row is information.
 */
function CropPlan({
  slug,
  date,
  fieldName,
}: {
  readonly slug: string;
  readonly date: string;
  readonly fieldName: string | undefined;
}) {
  const state = useAsync(`plan:${slug}`, () => api.cropDetail(slug));

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const options = state.data.cultivars.flatMap((cultivar) => {
    const published = cultivar.profileVersions.find((version) => version.status === "published");
    return published === undefined ? [] : [{ cultivar, version: published }];
  });

  if (options.length === 0) {
    return (
      <Empty>
        Belum ada rulebook terbit untuk {state.data.nameId}. Katalog tidak dapat membuat jadwal
        tanpa ambang yang disahkan.
      </Empty>
    );
  }

  if (date === "") {
    return <p className="muted">Pilih tanggal mulai untuk melihat kalender.</p>;
  }

  return (
    <div className="stack">
      {fieldName === undefined ? null : (
        <p className="muted">
          Rencana untuk <strong>{fieldName}</strong>.
        </p>
      )}
      {options.map(({ cultivar, version }) => (
        <section className="panel" key={version.id}>
          <div className="panel-body stack">
            <div className="section-head">
              <h2>{cultivar.name}</h2>
              <Tag>{version.ruleVersion}</Tag>
            </div>
            <PlanTimeline profileVersionId={version.id} cultivarName={cultivar.name} date={date} />
          </div>
        </section>
      ))}
    </div>
  );
}

function PlanTimeline({
  profileVersionId,
  cultivarName,
  date,
}: {
  readonly profileVersionId: string;
  readonly cultivarName: string;
  readonly date: string;
}) {
  const state = useAsync(`plan-cycle:${profileVersionId}:${date}`, () =>
    api.cropCycle(profileVersionId, date),
  );

  if (state.loading) return <div className="loading">Menghitung siklus…</div>;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const cycle = state.data;
  const position = locate(cycle);

  return (
    <>
      <p>
        Panen <strong>{cycle.harvest.typical}</strong>
        <span className="muted">
          {" "}
          (rentang {cycle.harvest.earliest} – {cycle.harvest.latest}, {cycle.duration.min}–
          {cycle.duration.max} hari)
        </span>
      </p>

      <div className="panel">
        <div className="panel-body">{position}</div>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>Tahap</th>
            <th className="numeric">Hari</th>
            <th>Mulai</th>
            <th>Selesai</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {cycle.stages.map((stage) => (
            <tr key={stage.stageId}>
              <td>
                {stage.name}
                {stage.isCritical ? (
                  <>
                    {" "}
                    <Tag tone="warn">kritis</Tag>
                  </>
                ) : null}
              </td>
              <td className="numeric">
                {stage.startDayOffset}–{stage.endDayOffset}
              </td>
              <td className="numeric">{stage.startDate}</td>
              <td className="numeric">
                {stage.endDate}
                {stage.clipped ? <Tag>dipotong durasi</Tag> : null}
              </td>
              <td className="muted">{stageStatus(stage)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="faint">
        {cultivarName} diproyeksikan pada durasi khas {cycle.duration.typical} hari. Tanggal bukan
        jaminan: cuaca dan iklim belum dinilai, dan fase kritis tetap perlu dipantau.
      </p>
    </>
  );
}

/** Today's plan position, stated as a calendar fact rather than an assessment. */
function locate(cycle: CropCycle) {
  const now = today();
  const start = cycle.cycleStartDate;

  if (now < start) {
    const days = daysBetween(now, start);
    return (
      <span>
        Belum mulai: {days} hari menuju tanggal mulai {start}.
      </span>
    );
  }

  const offset = daysBetween(start, now);
  const stage = cycle.stages.find(
    (entry) => offset >= entry.startDayOffset && offset <= entry.endDayOffset,
  );

  if (stage !== undefined) {
    return (
      <span>
        Hari ini hari ke-{offset + 1} dari {cycle.duration.typical}. Fase{" "}
        <strong>{stage.name}</strong>
        {stage.isCritical ? " (kritis)" : ""}, berakhir {stage.endDate}.
      </span>
    );
  }

  if (now > cycle.harvest.latest) {
    return <span>Siklus pada rencana ini sudah lewat masa panen.</span>;
  }

  return (
    <span>
      Hari ini hari ke-{offset + 1}. Tidak ada tahap yang dinyatakan rulebook untuk hari ini.
    </span>
  );
}

function stageStatus(stage: CropCycle["stages"][number]): string {
  const todayDate = today();
  if (todayDate < stage.startDate) return "belum";
  if (todayDate > stage.endDate) return "selesai";
  return "berjalan";
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

/** Calendar-day difference on `YYYY-MM-DD`, refused rather than normalised elsewhere. */
function daysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

function utcMidnight(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}
