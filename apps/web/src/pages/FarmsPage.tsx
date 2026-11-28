import type {
  DrainageClass,
  IrrigationAvailability,
  PolygonGeometry,
  SoilType,
} from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { IconPlus } from "../icons.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  Loading,
  Mono,
  Notice,
  PageGuide,
  Tag,
  drainageClassLabel,
  irrigationLabel,
  soilTypeLabel,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

const LOCATION_PRESETS = [
  { label: "Area Simulasi Cuaca (uji grafik)", lat: "0.5000", lon: "0.5000" },
  { label: "Karawang, Jabar", lat: "-6.3020", lon: "107.3020" },
  { label: "Lembang, Bandung", lat: "-6.8140", lon: "107.6180" },
] as const;

const SQUARE_PRESET: readonly SketchPoint[] = [
  { x: 0.25, y: 0.25 },
  { x: 0.75, y: 0.25 },
  { x: 0.75, y: 0.75 },
  { x: 0.25, y: 0.75 },
];

export function FarmsPage() {
  const state = useAsync("farms", async () => {
    const [farms, fields] = await Promise.all([api.listFarms(), api.listFields()]);
    return { farms, fields };
  });

  const [selectedFarmId, setSelectedFarmId] = useState<string | null>(null);
  const [detailFieldId, setDetailFieldId] = useState<string | null>(null);
  const [editingFarmId, setEditingFarmId] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [farmName, setFarmName] = useState("");
  const [farmRegion, setFarmRegion] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [lat, setLat] = useState("0.5000");
  const [lon, setLon] = useState("0.5000");
  const [spanKm, setSpanKm] = useState("1");
  const [vertices, setVertices] = useState<readonly SketchPoint[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [polygonText, setPolygonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  if (state.data === null) {
    if (state.loading) return <Loading />;
    return state.error === null ? null : <ErrorNotice error={state.error} />;
  }

  const { farms, fields } = state.data;
  const selected = farms.find((farm) => farm.id === selectedFarmId) ?? farms[0];
  const selectedFields =
    selected === undefined ? [] : fields.filter((field) => field.farmId === selected.id);

  const name = farmName.trim();
  const region = farmRegion.trim() === "" ? null : farmRegion.trim();

  const frame = frameFrom(lat, lon, spanKm);
  const { geometry, reason } = geometryFor(vertices, frame, polygonText);

  const addVertex = (event: React.PointerEvent<SVGRectElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null) return;
    const point = sketchPoint(svg, event.clientX, event.clientY);
    setVertices((current) => (current.length >= MAX_VERTICES ? current : [...current, point]));
  };

  const moveVertex = (index: number, event: React.PointerEvent<SVGCircleElement>) => {
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null) return;
    const point = sketchPoint(svg, event.clientX, event.clientY);
    setVertices((current) => current.map((vertex, at) => (at === index ? point : vertex)));
  };

  const saveFarm = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      const farm =
        editingFarmId === null
          ? await api.createFarm(name, region)
          : await api.updateFarm(editingFarmId, { name, region });
      setSavedNotice(
        editingFarmId === null
          ? `Kebun "${farm.name}" berhasil ditambahkan.`
          : `Perubahan pada kebun "${farm.name}" tersimpan.`,
      );
      setFarmName("");
      setFarmRegion("");
      setEditingFarmId(null);
      setSelectedFarmId(farm.id);
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const removeFarm = async (farmId: string) => {
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      await api.deleteFarm(farmId);
      if (selectedFarmId === farmId) setSelectedFarmId(null);
      if (editingFarmId === farmId) {
        setEditingFarmId(null);
        setFarmName("");
        setFarmRegion("");
      }
      setSavedNotice("Kebun berhasil dihapus.");
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const saveField = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selected === undefined) return;
    if (geometry === null && (editingFieldId === null || polygonText.trim() !== "")) {
      setError(new Error(reason === "" ? "Bentuk area lahan belum lengkap." : reason));
      return;
    }
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      if (editingFieldId === null && geometry !== null) {
        const created = await api.createField(selected.id, fieldName.trim(), geometry);
        setDetailFieldId(created.id);
        setSavedNotice(
          `Lahan "${created.name}" berhasil disimpan. Anda dapat melengkapi kondisi tanah dan pengairannya di panel Detail di atas.`,
        );
      } else if (editingFieldId !== null) {
        const stored = fields.find((field) => field.id === editingFieldId);
        const unchanged =
          stored === undefined ||
          polygonText.trim() === "" ||
          (geometry !== null && JSON.stringify(geometry) === JSON.stringify(stored.geometry));
        if (unchanged) {
          await api.updateField(editingFieldId, { name: fieldName.trim() });
        } else if (geometry !== null) {
          await api.updateField(editingFieldId, {
            name: fieldName.trim(),
            geometry,
          });
        }
        setSavedNotice("Perubahan data lahan berhasil disimpan.");
      }
      setFieldName("");
      setEditingFieldId(null);
      setVertices([]);
      setPolygonText("");
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const removeField = async (fieldId: string) => {
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      await api.deleteField(fieldId);
      if (editingFieldId === fieldId) {
        setEditingFieldId(null);
        setFieldName("");
        setPolygonText("");
      }
      if (detailFieldId === fieldId) setDetailFieldId(null);
      setSavedNotice("Lahan berhasil dihapus.");
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageGuide
        storageKey="farms"
        title="Panduan Kebun & Lahan"
        summary="Kelola lokasi kebun Anda, petakan batas tiap bidang lahan, dan isi profil tanah serta irigasi untuk penilaian tanam."
        steps={[
          {
            title: "1. Buat Kebun",
            detail:
              "Kebun adalah nama lokasi atau kelompok usaha tani Anda (misalnya: Kebun Karawang).",
          },
          {
            title: "2. Gambar Batas Lahan",
            detail:
              "Pilih titik koordinat atau gunakan contoh wilayah, lalu klik di kotak sketsa minimal 3 sudut (atau pakai tombol persegi otomatis).",
          },
          {
            title: "3. Lengkapi Kondisi Tanah",
            detail:
              "Klik tombol Detail pada lahan untuk mengisi jenis tanah, drainase, pH, dan irigasi.",
          },
        ]}
        glossary={[
          { term: "Kebun", meaning: "Lokasi induk atau kelompok lahan" },
          { term: "Lahan", meaning: "Petak/bidang tanam dengan batas area tertentu" },
          { term: "Drainase", meaning: "Kecepatan air meresap atau mengalir keluar dari lahan" },
        ]}
      />

      {state.error === null ? null : (
        <ErrorNotice
          error={state.error}
          note="Daftar gagal dimuat ulang; perubahan terakhir Anda mungkin sudah tersimpan."
        />
      )}
      {error !== null ? <ErrorNotice error={error} /> : null}
      {savedNotice !== null ? <Notice tone="success">{savedNotice}</Notice> : null}

      <section className="section">
        <div className="section-head">
          <h2>Daftar Kebun</h2>
          <Tag>{farms.length} kebun</Tag>
        </div>
        {farms.length === 0 ? (
          <Empty>Belum ada kebun. Tambahkan kebun pertama Anda melalui formulir di bawah.</Empty>
        ) : (
          <div className="crop-grid">
            {farms.map((farm) => (
              <div
                key={farm.id}
                className="crop-card"
                style={
                  selected?.id === farm.id
                    ? { borderColor: "var(--accent)", background: "var(--accent-tint)" }
                    : undefined
                }
              >
                <button
                  type="button"
                  className="crop-card-select"
                  aria-pressed={selected?.id === farm.id}
                  onClick={() => setSelectedFarmId(farm.id)}
                >
                  <h3>{farm.name}</h3>
                  <span className="muted">{farm.region ?? "Wilayah belum diisi"}</span>
                  <span className="faint">{countLabel(fields, farm.id)}</span>
                </button>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={() => {
                      setEditingFarmId(farm.id);
                      setFarmName(farm.name);
                      setFarmRegion(farm.region ?? "");
                    }}
                  >
                    Ubah
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={busy}
                    onClick={() => void removeFarm(farm.id)}
                  >
                    Hapus
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <form className="panel" onSubmit={saveFarm}>
          <div className="panel-head">
            <h3>{editingFarmId === null ? "Tambah Kebun Baru" : "Ubah Data Kebun"}</h3>
          </div>
          <div className="panel-body form-grid">
            <div className="field">
              <label htmlFor="farm-name">Nama Kebun</label>
              <input
                id="farm-name"
                required
                maxLength={100}
                placeholder="Contoh: Kebun Subang Timur"
                value={farmName}
                onChange={(event) => setFarmName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="farm-region">Kabupaten / Wilayah (opsional)</label>
              <input
                id="farm-region"
                maxLength={120}
                placeholder="Contoh: Kab. Subang, Jawa Barat"
                value={farmRegion}
                onChange={(event) => setFarmRegion(event.target.value)}
              />
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                <IconPlus size={16} />
                <span>{editingFarmId === null ? "Simpan Kebun" : "Simpan Perubahan"}</span>
              </button>
              {editingFarmId === null ? null : (
                <button
                  type="button"
                  className="btn btn-quiet"
                  onClick={() => {
                    setEditingFarmId(null);
                    setFarmName("");
                    setFarmRegion("");
                  }}
                >
                  Batal
                </button>
              )}
            </div>
          </div>
        </form>
      </section>

      <section className="section">
        <div className="section-head">
          <h2>Daftar Lahan {selected === undefined ? "" : `· ${selected.name}`}</h2>
          {selected !== undefined ? <Tag tone="accent">{selectedFields.length} lahan</Tag> : null}
        </div>

        {selected === undefined ? (
          <Empty>Buat atau pilih salah satu kebun di atas terlebih dahulu.</Empty>
        ) : selectedFields.length === 0 ? (
          <Empty>
            Belum ada lahan di kebun ini. Gunakan formulir di bawah untuk menambahkan lahan.
          </Empty>
        ) : (
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama Lahan</th>
                  <th className="numeric">Luas (ha)</th>
                  <th>Tanggal Dibuat</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {selectedFields.map((field) => (
                  <tr key={field.id}>
                    <td>
                      <strong>{field.name}</strong>
                    </td>
                    <td className="numeric">{field.areaHa.toFixed(2)} ha</td>
                    <td className="muted numeric">{field.createdAt.slice(0, 10)}</td>
                    <td>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          aria-pressed={detailFieldId === field.id}
                          onClick={() =>
                            setDetailFieldId(detailFieldId === field.id ? null : field.id)
                          }
                        >
                          {detailFieldId === field.id ? "Tutup Detail" : "Detail & Profil Tanah"}
                        </button>
                        <button
                          type="button"
                          className="btn btn-quiet btn-sm"
                          disabled={busy}
                          onClick={() => {
                            setEditingFieldId(field.id);
                            setFieldName(field.name);
                            setPolygonText(ringText(field.geometry));
                          }}
                        >
                          Ubah
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={busy}
                          onClick={() => void removeField(field.id)}
                        >
                          Hapus
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(() => {
          const detailField = selectedFields.find((f) => f.id === detailFieldId);
          if (detailField === undefined) return null;
          const ring = detailField.geometry.coordinates[0] ?? [];
          const lons = ring.map(([lo]) => lo);
          const lats = ring.map(([, la]) => la);
          return (
            <div className="panel">
              <div className="panel-head">
                <h3>Detail Lahan · {detailField.name}</h3>
                <Tag tone="accent">{detailField.areaHa.toFixed(2)} ha</Tag>
              </div>
              <div className="panel-body stack">
                <div className="btn-row">
                  <Link className="btn btn-primary btn-sm" to="/rencana">
                    Evaluasi &amp; Rencana Tanam
                  </Link>
                  <Link className="btn btn-quiet btn-sm" to="/aktivitas">
                    Catat Aktivitas &amp; Panen
                  </Link>
                  <Link className="btn btn-quiet btn-sm" to="/iklim">
                    Lihat Cuaca &amp; Iklim
                  </Link>
                </div>

                <FieldAgronomyForm fieldId={detailField.id} />

                <details className="tech-details">
                  <summary>Lihat info koordinat &amp; identitas teknis</summary>
                  <p className="muted">
                    ID Lahan: <Mono>{detailField.id}</Mono> · Jumlah sudut batas:{" "}
                    {Math.max(0, ring.length - 1)} titik · Rentang bujur:{" "}
                    {lons.length > 0
                      ? `${Math.min(...lons).toFixed(4)} s.d. ${Math.max(...lons).toFixed(4)}`
                      : "—"}{" "}
                    · Rentang lintang:{" "}
                    {lats.length > 0
                      ? `${Math.min(...lats).toFixed(4)} s.d. ${Math.max(...lats).toFixed(4)}`
                      : "—"}
                  </p>
                </details>
              </div>
            </div>
          );
        })()}

        {selected !== undefined ? (
          <form className="panel" onSubmit={saveField}>
            <div className="panel-head">
              <h3>{editingFieldId === null ? "Tambah Lahan Baru" : "Ubah Data Lahan"}</h3>
            </div>
            <div className="panel-body form-grid">
              <div className="field">
                <label htmlFor="field-name">Nama Lahan</label>
                <input
                  id="field-name"
                  required
                  maxLength={100}
                  placeholder="Contoh: Petak Sawah A1"
                  value={fieldName}
                  onChange={(event) => setFieldName(event.target.value)}
                />
              </div>

              {editingFieldId === null ? (
                <>
                  <div className="preset-chips">
                    <span className="faint">Contoh lokasi cepat:</span>
                    {LOCATION_PRESETS.map((preset) => (
                      <button
                        key={preset.label}
                        type="button"
                        className="preset-chip"
                        onClick={() => {
                          setLat(preset.lat);
                          setLon(preset.lon);
                        }}
                      >
                        {preset.label}
                      </button>
                    ))}
                  </div>

                  <div className="field">
                    <label htmlFor="field-lat">Koordinat Lintang (Latitude)</label>
                    <input
                      id="field-lat"
                      type="number"
                      step="0.0001"
                      min="-90"
                      max="90"
                      required
                      value={lat}
                      onChange={(event) => setLat(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="field-lon">Koordinat Bujur (Longitude)</label>
                    <input
                      id="field-lon"
                      type="number"
                      step="0.0001"
                      min="-180"
                      max="180"
                      required
                      value={lon}
                      onChange={(event) => setLon(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="field-span">Lebar Area Peta (km)</label>
                    <input
                      id="field-span"
                      type="number"
                      step="0.1"
                      min="0.1"
                      max="50"
                      required
                      value={spanKm}
                      onChange={(event) => setSpanKm(event.target.value)}
                    />
                    <span className="hint">
                      Ukuran kotak sketsa di bawah (1 km cukup untuk 1–20 ha).
                    </span>
                  </div>

                  <div className="sketch-block">
                    <div className="spread">
                      <span className="eyebrow">Gambar Batas Lahan</span>
                      <span className="faint numeric">{vertices.length} titik sudut</span>
                    </div>

                    <div className="btn-row">
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        disabled={busy}
                        onClick={() => setVertices(SQUARE_PRESET)}
                      >
                        Buat bentuk persegi otomatis
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        disabled={busy || vertices.length === 0}
                        onClick={() => setVertices((current) => current.slice(0, -1))}
                      >
                        Hapus titik terakhir
                      </button>
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        disabled={busy || vertices.length === 0}
                        onClick={() => setVertices([])}
                      >
                        Ulangi sketsa
                      </button>
                    </div>

                    <div className="sketch-wrap">
                      <svg
                        className="sketch"
                        viewBox="0 0 100 100"
                        role="group"
                        aria-label={`Sketsa batas lahan, ${vertices.length} titik`}
                      >
                        <rect
                          className="sketch-frame"
                          x={PLOT_MIN}
                          y={PLOT_MIN}
                          width={PLOT_SIZE}
                          height={PLOT_SIZE}
                          onPointerDown={addVertex}
                        />
                        {[0.25, 0.5, 0.75].map((ratio) => {
                          const pos = plot(ratio);
                          return (
                            <g key={ratio}>
                              <line
                                className="sketch-grid-line"
                                x1={pos}
                                y1={PLOT_MIN}
                                x2={pos}
                                y2={PLOT_MIN + PLOT_SIZE}
                              />
                              <line
                                className="sketch-grid-line"
                                x1={PLOT_MIN}
                                y1={pos}
                                x2={PLOT_MIN + PLOT_SIZE}
                                y2={pos}
                              />
                            </g>
                          );
                        })}
                        <text
                          x={90}
                          y={13}
                          fontSize="4.5"
                          fontWeight="700"
                          fill="var(--ink-faint)"
                          textAnchor="end"
                          pointerEvents="none"
                        >
                          U ↑
                        </text>
                        {vertices.length < 2 ? null : (
                          <polygon
                            className="sketch-area"
                            points={vertices
                              .map((vertex) => `${plot(vertex.x)},${plot(vertex.y)}`)
                              .join(" ")}
                          />
                        )}
                        {vertices.map((vertex, index) => (
                          <circle
                            key={index}
                            className="sketch-vertex"
                            cx={plot(vertex.x)}
                            cy={plot(vertex.y)}
                            r={4.8}
                            role="img"
                            aria-label={`Titik ${index + 1}`}
                            onPointerDown={(event) => {
                              event.currentTarget.setPointerCapture(event.pointerId);
                              setDragging(index);
                            }}
                            onPointerMove={(event) => {
                              if (dragging === index) moveVertex(index, event);
                            }}
                            onPointerUp={(event) => {
                              event.currentTarget.releasePointerCapture(event.pointerId);
                              setDragging(null);
                            }}
                            onPointerCancel={() => setDragging(null)}
                          />
                        ))}
                      </svg>
                      <p className="faint">
                        Klik di dalam kotak untuk menandai sudut lahan (minimal 3 titik), seret
                        titik untuk mengubah posisi, atau klik &ldquo;Buat bentuk persegi
                        otomatis&rdquo;.
                      </p>
                      {reason === "" ? null : <p className="faint">{reason}</p>}
                    </div>

                    <details className="tech-details">
                      <summary>Input koordinat manual (lanjutan)</summary>
                      <div className="field">
                        <label htmlFor="field-polygon">
                          Daftar titik koordinat (bujur, lintang — satu titik per baris)
                        </label>
                        <textarea
                          id="field-polygon"
                          rows={4}
                          value={polygonText}
                          onChange={(event) => setPolygonText(event.target.value)}
                        />
                        <span className="hint">
                          Jika diisi, daftar koordinat ini menggantikan gambar sketsa. Garis batas
                          akan ditutup otomatis dari titik akhir ke titik awal.
                        </span>
                      </div>
                    </details>
                  </div>
                </>
              ) : (
                <div className="sketch-block">
                  <div className="field">
                    <label htmlFor="field-polygon">Daftar titik koordinat (bujur, lintang)</label>
                    <textarea
                      id="field-polygon"
                      rows={5}
                      value={polygonText}
                      onChange={(event) => setPolygonText(event.target.value)}
                    />
                    <span className="hint">
                      Satu titik per baris (bujur, lintang). Kosongkan jika hanya ingin mengubah
                      nama lahan tanpa mengubah bentuk batasnya.
                    </span>
                  </div>
                  {polygonText.trim() === "" || reason === "" ? null : (
                    <p className="faint">{reason}</p>
                  )}
                </div>
              )}

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={
                    busy ||
                    (geometry === null && (editingFieldId === null || polygonText.trim() !== ""))
                  }
                >
                  {editingFieldId === null ? "Simpan Lahan" : "Simpan Perubahan"}
                </button>
                {editingFieldId === null ? null : (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setEditingFieldId(null);
                      setFieldName("");
                      setPolygonText("");
                    }}
                  >
                    Batal
                  </button>
                )}
              </div>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}

function FieldAgronomyForm({ fieldId }: { readonly fieldId: string }) {
  const [soilType, setSoilType] = useState<string>("");
  const [drainageClass, setDrainageClass] = useState<string>("");
  const [irrigation, setIrrigation] = useState<string>("");
  const [soilPh, setSoilPh] = useState<string>("");
  const [elevationM, setElevationM] = useState<string>("");
  const [waterSource, setWaterSource] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedNotice, setSavedNotice] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setSavedNotice(false);
    setError(null);
    api.getFieldAgronomy(fieldId).then(
      (profile) => {
        if (!alive) return;
        setSoilType(profile.soilType ?? "");
        setDrainageClass(profile.drainageClass ?? "");
        setIrrigation(profile.irrigationAvailability ?? "");
        setSoilPh(profile.soilPh === null ? "" : String(profile.soilPh));
        setElevationM(profile.elevationM === null ? "" : String(profile.elevationM));
        setWaterSource(profile.waterSource ?? "");
        setLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [fieldId]);

  if (loading) return <Loading label="Memuat kondisi tanah & pengairan…" />;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSavedNotice(false);
    setError(null);
    try {
      await api.updateFieldAgronomy(fieldId, {
        soilType: soilType === "" ? null : (soilType as SoilType),
        drainageClass: drainageClass === "" ? null : (drainageClass as DrainageClass),
        irrigationAvailability: irrigation === "" ? null : (irrigation as IrrigationAvailability),
        soilPh: soilPh.trim() === "" ? null : Number(soilPh),
        elevationM: elevationM.trim() === "" ? null : Number(elevationM),
        waterSource: waterSource.trim() === "" ? null : waterSource.trim(),
      });
      setSavedNotice(true);
    } catch (err) {
      setError(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="stack" onSubmit={save}>
      <div className="stack-tight">
        <h4>Kondisi Tanah &amp; Pengairan</h4>
        <p className="muted" style={{ fontSize: "0.875rem" }}>
          Lengkapi data ini agar evaluasi kecocokan tanaman di halaman Rencana Tanam lebih akurat.
        </p>
      </div>
      {error !== null ? <ErrorNotice error={error} /> : null}
      {savedNotice ? (
        <Notice tone="success">Profil tanah dan pengairan berhasil disimpan.</Notice>
      ) : null}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="agro-soil">Jenis Tanah</label>
          <select id="agro-soil" value={soilType} onChange={(e) => setSoilType(e.target.value)}>
            <option value="">— Pilih / belum diisi —</option>
            {(
              [
                "clay",
                "loam",
                "sandy",
                "clay_loam",
                "sandy_loam",
                "silt_loam",
                "peat",
                "alluvial",
                "volcanic",
                "unknown",
              ] as const
            ).map((v) => (
              <option key={v} value={v}>
                {soilTypeLabel(v)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="agro-drainage">Aliran Air / Drainase</label>
          <select
            id="agro-drainage"
            value={drainageClass}
            onChange={(e) => setDrainageClass(e.target.value)}
          >
            <option value="">— Pilih / belum diisi —</option>
            {(["poor", "moderate", "well", "excessive", "unknown"] as const).map((v) => (
              <option key={v} value={v}>
                {drainageClassLabel(v)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="agro-irrigation">Ketersediaan Irigasi</label>
          <select
            id="agro-irrigation"
            value={irrigation}
            onChange={(e) => setIrrigation(e.target.value)}
          >
            <option value="">— Pilih / belum diisi —</option>
            {(["irrigated", "partial_irrigation", "rainfed", "unknown"] as const).map((v) => (
              <option key={v} value={v}>
                {irrigationLabel(v)}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label htmlFor="agro-ph">pH Tanah (3.0–10.0)</label>
          <input
            id="agro-ph"
            type="number"
            step="0.1"
            min="3"
            max="10"
            placeholder="Contoh: 6.3"
            value={soilPh}
            onChange={(e) => setSoilPh(e.target.value)}
          />
          <span className="hint">Umumnya tanah subur berada di kisaran 5,5 – 7,0.</span>
        </div>

        <div className="field">
          <label htmlFor="agro-elev">Ketinggian Lokasi (mdpl)</label>
          <input
            id="agro-elev"
            type="number"
            step="1"
            min="-500"
            max="6000"
            placeholder="Contoh: 420"
            value={elevationM}
            onChange={(e) => setElevationM(e.target.value)}
          />
          <span className="hint">Meter di atas permukaan laut.</span>
        </div>

        <div className="field">
          <label htmlFor="agro-water">Sumber Air Utama (opsional)</label>
          <input
            id="agro-water"
            maxLength={200}
            placeholder="Contoh: Irigasi teknis / sumur bor"
            value={waterSource}
            onChange={(e) => setWaterSource(e.target.value)}
          />
        </div>

        <div className="form-actions">
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? "Menyimpan…" : "Simpan profil agronomi"}
          </button>
        </div>
      </div>
    </form>
  );
}

function ringText(geometry: PolygonGeometry): string {
  const ring = geometry.coordinates[0] ?? [];
  const corners = ring.length > 1 ? ring.slice(0, -1) : ring;
  return corners.map(([lon, lat]) => `${String(lon)}, ${String(lat)}`).join("\n");
}

function countLabel(fields: readonly { farmId: string }[], farmId: string): string {
  const count = fields.filter((field) => field.farmId === farmId).length;
  return count === 1 ? "1 lahan" : `${count} lahan`;
}

interface SketchPoint {
  readonly x: number;
  readonly y: number;
}

interface Frame {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

const KM_PER_DEGREE = 111.32;
const MAX_VERTICES = 200;
const MAX_POLYGON_TEXT = 12000;
const PLOT_MIN = 6;
const PLOT_SIZE = 88;

function plot(normalised: number): number {
  return PLOT_MIN + normalised * PLOT_SIZE;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function frameFrom(latText: string, lonText: string, spanText: string): Frame | null {
  if (latText.trim() === "" || lonText.trim() === "" || spanText.trim() === "") return null;
  return frameBounds(Number(latText), Number(lonText), Number(spanText));
}

function frameBounds(lat: number, lon: number, spanKm: number): Frame | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(spanKm)) return null;
  if (spanKm <= 0 || Math.abs(lat) >= 90) return null;

  const dLat = spanKm / KM_PER_DEGREE;
  const dLon = spanKm / (KM_PER_DEGREE * Math.cos((lat * Math.PI) / 180));
  const frame: Frame = {
    top: lat + dLat / 2,
    bottom: lat - dLat / 2,
    left: lon - dLon / 2,
    right: lon + dLon / 2,
  };

  return frame.top > 90 || frame.bottom < -90 || frame.left < -180 || frame.right > 180
    ? null
    : frame;
}

function sketchPoint(svg: SVGSVGElement, clientX: number, clientY: number): SketchPoint {
  const rect = svg.getBoundingClientRect();
  const x = ((clientX - rect.left) / rect.width) * 100;
  const y = ((clientY - rect.top) / rect.height) * 100;
  return {
    x: clamp01((x - PLOT_MIN) / PLOT_SIZE),
    y: clamp01((y - PLOT_MIN) / PLOT_SIZE),
  };
}

function positionOf(point: SketchPoint, frame: Frame): [number, number] {
  return [
    frame.left + point.x * (frame.right - frame.left),
    frame.top - point.y * (frame.top - frame.bottom),
  ];
}

type RingResult =
  | { readonly geometry: PolygonGeometry; readonly reason?: undefined }
  | { readonly geometry?: undefined; readonly reason: string };

function ringOf(positions: readonly (readonly [number, number])[]): RingResult {
  const ring: [number, number][] = [];
  for (const [lon, lat] of positions) {
    const last = ring[ring.length - 1];
    if (last !== undefined && last[0] === lon && last[1] === lat) continue;
    ring.push([lon, lat]);
  }

  const first = ring[0];
  if (first !== undefined) {
    while (ring.length > 1) {
      const last = ring[ring.length - 1];
      if (last === undefined || last[0] !== first[0] || last[1] !== first[1]) break;
      ring.pop();
    }
  }

  for (const [index, [lon, lat]] of ring.entries()) {
    if (ring.findIndex(([seenLon, seenLat]) => seenLon === lon && seenLat === lat) !== index) {
      return { reason: `Titik ${lon}, ${lat} muncul lebih dari sekali; tiap titik harus berbeda.` };
    }
  }

  const start = ring[0];
  if (ring.length < 3 || start === undefined) {
    return { reason: "Area lahan membutuhkan minimal 3 titik sudut berbeda." };
  }
  return { geometry: { type: "Polygon", coordinates: [[...ring, [start[0], start[1]]]] } };
}

type Parsed = { readonly positions: [number, number][] } | { readonly error: string };

function parsePositions(text: string): Parsed {
  const positions: [number, number][] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim();
    if (line === "") continue;
    const parts = line.split(/[\s,]+/);
    if (parts.length !== 2 || parts.some((part) => part === ""))
      return { error: `Baris "${line}" membutuhkan tepat dua angka: bujur, lintang.` };

    const lon = Number(parts[0]);
    const lat = Number(parts[1]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      return { error: `Baris "${line}" bukan angka yang sah.` };
    }
    if (lon < -180 || lon > 180 || lat < -90 || lat > 90) {
      return { error: `Baris "${line}" di luar batas ±180 bujur atau ±90 lintang.` };
    }
    positions.push([lon, lat]);
  }
  return { positions };
}

function geometryFor(
  vertices: readonly SketchPoint[],
  frame: Frame | null,
  text: string,
): { readonly geometry: PolygonGeometry | null; readonly reason: string } {
  if (text.length > MAX_POLYGON_TEXT) {
    return {
      geometry: null,
      reason: `Daftar koordinat terlalu panjang (${text.length} karakter, maksimum ${MAX_POLYGON_TEXT}).`,
    };
  }
  if (text.trim() !== "") {
    const parsed = parsePositions(text);
    if ("error" in parsed) return { geometry: null, reason: parsed.error };
    const ring = ringOf(parsed.positions);
    return ring.reason === undefined
      ? { geometry: ring.geometry, reason: "" }
      : { geometry: null, reason: ring.reason };
  }

  if (frame === null) {
    return { geometry: null, reason: "Koordinat pusat atau lebar peta belum valid." };
  }
  if (vertices.length < 3) {
    if (vertices.length === 0) {
      return {
        geometry: null,
        reason: "Belum ada titik batas; klik minimal 3 titik atau gunakan persegi otomatis.",
      };
    }
    return {
      geometry: null,
      reason: `Baru ${vertices.length} titik sudut; butuh minimal 3 titik berbeda.`,
    };
  }

  const ring = ringOf(vertices.map((vertex) => positionOf(vertex, frame)));
  return ring.reason === undefined
    ? { geometry: ring.geometry, reason: "" }
    : { geometry: null, reason: ring.reason };
}
