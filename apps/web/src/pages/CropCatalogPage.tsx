import { useState } from "react";

import { api } from "../api.js";
import { Link } from "../router.js";
import { ErrorNotice, Empty, Loading, Mono, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

/**
 * The catalog, read-only.
 *
 * Two levels only: the crops, and one crop's cultivars with their version history.
 * A version is opened in place rather than on a third route, because the profile's
 * content is what the version *is* — a separate URL would imply the summary is
 * useful on its own, and it is not.
 *
 * Nothing here presents a threshold as a recommendation. The grade travels with
 * every row, and the header says what the catalog is: the rulebook the engine will
 * read, not one it has already applied.
 */
export function CropCatalogPage({ slug }: { readonly slug?: string }) {
  if (slug === undefined) return <CropList />;
  return <CropDetail slug={slug} />;
}

function CropList() {
  const state = useAsync("crops", () => api.listCrops());

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  if (state.data.crops.length === 0) {
    return (
      <Empty>
        Katalog kosong. Baris komoditas diisi oleh seed `migration_owner`; cakupan seed v1 masih
        menunggu keputusan <Mono>OPEN-20</Mono>.
      </Empty>
    );
  }

  return (
    <div className="crop-grid">
      {state.data.crops.map((crop) => (
        <Link key={crop.id} to={`/katalog/${crop.slug}`} className="crop-card">
          <h3>{crop.nameId}</h3>
          <span className="muted">{crop.nameEn}</span>
          <span className="faint">{crop.category}</span>
        </Link>
      ))}
    </div>
  );
}

function CropDetail({ slug }: { readonly slug: string }) {
  const state = useAsync(`crop:${slug}`, () => api.cropDetail(slug));
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const crop = state.data;

  return (
    <div className="stack">
      <div className="spread">
        <div className="stack-tight">
          <span className="eyebrow">{crop.category}</span>
          <h2>{crop.nameId}</h2>
          <p className="muted">{crop.nameEn}</p>
        </div>
        <Link className="btn btn-quiet" to="/katalog">
          Semua komoditas
        </Link>
      </div>

      {crop.cultivars.length === 0 ? (
        <Empty>Belum ada kultivar untuk komoditas ini.</Empty>
      ) : (
        <div className="stack">
          {crop.cultivars.map((cultivar) => (
            <section className="cultivar" key={cultivar.id}>
              <header>
                <div>
                  <h3>{cultivar.name}</h3>
                  <p className="muted">
                    {cultivar.durationDaysMin}–{cultivar.durationDaysMax} hari · mulai{" "}
                    {cultivar.cycleStart === "sowing" ? "tanam benih" : "pindah tanam"}
                    {cultivar.nurseryDays === null
                      ? ""
                      : ` · persemaian ${cultivar.nurseryDays} hari`}
                  </p>
                </div>
                <Tag>{cultivar.profileVersions.length} versi</Tag>
              </header>

              {cultivar.profileVersions.length === 0 ? (
                <div className="panel-body muted">Belum ada rulebook untuk kultivar ini.</div>
              ) : (
                <div className="version-list">
                  {cultivar.profileVersions.map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      className="version-row"
                      aria-pressed={openVersionId === version.id}
                      onClick={() =>
                        setOpenVersionId(openVersionId === version.id ? null : version.id)
                      }
                    >
                      <span className="row">
                        <Mono>{version.ruleVersion}</Mono>
                        <Tag tone={version.status === "published" ? "accent" : undefined}>
                          {version.status === "draft"
                            ? "draf"
                            : version.status === "published"
                              ? "terbit"
                              : "pensiun"}
                        </Tag>
                        {version.supersedesId !== null ? <Tag>menggantikan versi lama</Tag> : null}
                      </span>
                      <span className="faint numeric">
                        {version.publishedAt === null
                          ? "belum diterbitkan"
                          : version.publishedAt.slice(0, 10)}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {openVersionId !== null &&
              cultivar.profileVersions.some((version) => version.id === openVersionId) ? (
                <VersionDetail id={openVersionId} />
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionDetail({ id }: { readonly id: string }) {
  const state = useAsync(`profile:${id}`, () => api.profileVersion(id));

  if (state.loading) return <div className="panel-body loading">Memuat rulebook…</div>;
  if (state.error !== null) {
    return (
      <div className="panel-body">
        <ErrorNotice error={state.error} />
      </div>
    );
  }
  if (state.data === null) return null;

  const profile = state.data;

  return (
    <div className="panel-body stack">
      <section>
        <h4>Tahap pertumbuhan</h4>
        {profile.growthStages.length === 0 ? (
          <p className="muted">Tidak ada tahap tercatat.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Nama</th>
                <th>Hari</th>
                <th>Kritis</th>
                <th>Profil kebutuhan</th>
              </tr>
            </thead>
            <tbody>
              {profile.growthStages.map((stage) => (
                <tr key={stage.id}>
                  <td>{stage.name}</td>
                  <td className="numeric">
                    {stage.startDayOffset}–{stage.endDayOffset}
                  </td>
                  <td>{stage.isCritical ? <Tag tone="warn">kritis</Tag> : "—"}</td>
                  <td className="muted">{stage.requirementProfile ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>Ambang batas</h4>
        {profile.constraints.length === 0 ? (
          <p className="muted">Tidak ada ambang tercatat.</p>
        ) : (
          <table className="table">
            <thead>
              <tr>
                <th>Dimensi</th>
                <th>Bentuk</th>
                <th className="numeric">Nilai</th>
                <th>Tahap</th>
                <th>Bukti</th>
                <th>Kekuatan</th>
              </tr>
            </thead>
            <tbody>
              {profile.constraints.map((constraint) => {
                const stage = profile.growthStages.find(
                  (candidate) => candidate.id === constraint.growthStageId,
                );
                return (
                  <tr key={constraint.id}>
                    <td>{constraint.dimension}</td>
                    <td className="muted">{constraint.comparator}</td>
                    <td className="numeric">{thresholdLabel(constraint)}</td>
                    <td className="muted">{stage?.name ?? "seluruh siklus"}</td>
                    <td>
                      <Tag tone={constraint.grade === "A" ? "accent" : undefined}>
                        {constraint.grade}
                      </Tag>
                    </td>
                    <td>
                      <Tag tone={constraint.severity === "hard" ? "warn" : undefined}>
                        {constraint.severity}
                      </Tag>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <section>
        <h4>Kutipan</h4>
        {profile.sourceRefs.length === 0 ? (
          <p className="muted">Tidak ada sumber tercatat.</p>
        ) : (
          <ul className="stack-tight">
            {profile.sourceRefs.map((source) => (
              <li key={source.id}>
                <span>{source.title}</span>
                <span className="muted">
                  {" "}
                  — {source.authors ?? "tanpa penulis"}, {source.publisher} {source.publicationYear}
                </span>{" "}
                <a href={source.url} target="_blank" rel="noreferrer">
                  sumber
                </a>{" "}
                <Tag tone={source.grade === "A" ? "accent" : undefined}>{source.grade}</Tag>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="faint">
        Rulebook ini menggambarkan isi katalog, bukan rekomendasi. Mesin agronomi belum
        mengevaluasinya, dan tidak ada angka yang boleh dibaca sebagai keputusan tanam.
      </p>
    </div>
  );
}

function thresholdLabel(constraint: {
  readonly comparator: string;
  readonly thresholdLower: number | null;
  readonly thresholdUpper: number | null;
  readonly thresholdCount: number | null;
  readonly unit: string | null;
}): string {
  const unit = constraint.unit ?? "";
  switch (constraint.comparator) {
    case "min":
      return `≥ ${constraint.thresholdLower ?? "?"} ${unit}`;
    case "max":
      return `≤ ${constraint.thresholdUpper ?? "?"} ${unit}`;
    case "range":
      return `${constraint.thresholdLower ?? "?"}–${constraint.thresholdUpper ?? "?"} ${unit}`;
    case "count":
      return `${constraint.thresholdCount ?? "?"}×`;
    default:
      return "—";
  }
}
