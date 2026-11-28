import type {
  DrainageClass,
  IrrigationAvailability,
  PolygonGeometry,
  SoilType,
} from "@agroclimate/contracts";
import { useEffect, useRef, useState } from "react";

import { api } from "../api.js";
import { CustomSelect } from "../components/CustomSelect.js";
import { FarmOverviewMap } from "../components/FarmOverviewMap.js";
import { SoilProfileVisual } from "../components/Visuals.js";
import { IconCompass, IconPlus } from "../icons.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  FieldLabel,
  Loading,
  Mono,
  Notice,
  PageGuide,
  Tag,
  drainageClassLabel,
  irrigationLabel,
  notifyDataChanged,
  soilTypeLabel,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

interface NominatimHit {
  readonly place_id: number;
  readonly display_name: string;
  readonly lat: string;
  readonly lon: string;
}

const REGION_OPTIONS = [
  {
    value: "subang",
    label: "Subang, Jawa Barat",
    description: "Sentra padi dataran rendah (-6.322°, 107.752°)",
    lat: "-6.3220",
    lon: "107.7520",
  },
  {
    value: "karawang",
    label: "Karawang, Jawa Barat",
    description: "Lumbung padi pantura (-6.302°, 107.302°)",
    lat: "-6.3020",
    lon: "107.3020",
  },
  {
    value: "lembang",
    label: "Lembang, Bandung Barat",
    description: "Sentra hortikultura dataran tinggi (-6.814°, 107.618°)",
    lat: "-6.8140",
    lon: "107.6180",
  },
  {
    value: "indramayu",
    label: "Indramayu, Jawa Barat",
    description: "Pesisir utara Jawa (-6.337°, 108.320°)",
    lat: "-6.3370",
    lon: "108.3200",
  },
  {
    value: "brebes",
    label: "Brebes, Jawa Tengah",
    description: "Sentra bawang merah (-6.873°, 109.042°)",
    lat: "-6.8730",
    lon: "109.0420",
  },
  {
    value: "demak",
    label: "Demak, Jawa Tengah",
    description: "Dataran alluvial (-6.891°, 110.639°)",
    lat: "-6.8910",
    lon: "110.6390",
  },
  {
    value: "batu",
    label: "Batu, Malang",
    description: "Pegunungan Jawa Timur (-7.871°, 112.526°)",
    lat: "-7.8710",
    lon: "112.5260",
  },
  {
    value: "jember",
    label: "Jember, Jawa Timur",
    description: "Perkebunan & pangan (-8.172°, 113.700°)",
    lat: "-8.1720",
    lon: "113.7000",
  },
  {
    value: "tabanan",
    label: "Tabanan, Bali",
    description: "Subak dataran menengah (-8.541°, 115.125°)",
    lat: "-8.5410",
    lon: "115.1250",
  },
  {
    value: "lampung",
    label: "Lampung Tengah, Lampung",
    description: "Sentra jagung & singkong (-4.867°, 105.233°)",
    lat: "-4.8670",
    lon: "105.2330",
  },
  {
    value: "bone",
    label: "Bone, Sulawesi Selatan",
    description: "Sentra padi & jagung (-4.538°, 120.328°)",
    lat: "-4.5380",
    lon: "120.3280",
  },
  {
    value: "simulasi",
    label: "Area Simulasi Cuaca (uji grafik)",
    description: "Di dalam cakupan grid simulasi bawaan (0.500°, 0.500°)",
    lat: "0.5000",
    lon: "0.5000",
  },
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
  const [regionPreset, setRegionPreset] = useState("subang");
  const [mapsInput, setMapsInput] = useState("");
  const [locationFeedback, setLocationFeedback] = useState<string | null>(null);
  const [lat, setLat] = useState("-6.3220");
  const [lon, setLon] = useState("107.7520");
  const [spanKm, setSpanKm] = useState("1");
  const [vertices, setVertices] = useState<readonly SketchPoint[]>([]);
  const [selectedVertex, setSelectedVertex] = useState<number | null>(null);
  const [dragging, setDragging] = useState<number | null>(null);
  const fieldEditorRef = useRef<HTMLFormElement | null>(null);
  const [polygonText, setPolygonText] = useState("");
  const [basemapMode, setBasemapMode] = useState<"none" | "osm" | "satellite">("none");
  const [tileFailed, setTileFailed] = useState(false);
  const [nominatimQuery, setNominatimQuery] = useState("");
  const [nominatimResults, setNominatimResults] = useState<readonly NominatimHit[]>([]);
  const [nominatimLoading, setNominatimLoading] = useState(false);
  const [nominatimError, setNominatimError] = useState<string | null>(null);
  const nominatimCacheRef = useRef<Map<string, readonly NominatimHit[]>>(new Map());
  const nominatimAbortRef = useRef<AbortController | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const runNominatimSearch = async (rawQuery: string) => {
    const q = rawQuery.trim();
    if (q.length < 3) {
      setNominatimResults([]);
      setNominatimError(null);
      return;
    }
    const cacheKey = q.toLowerCase();
    const cached = nominatimCacheRef.current.get(cacheKey);
    if (cached !== undefined) {
      setNominatimResults(cached);
      setNominatimError(null);
      return;
    }
    nominatimAbortRef.current?.abort();
    const controller = new AbortController();
    nominatimAbortRef.current = controller;
    setNominatimLoading(true);
    setNominatimError(null);
    try {
      const url = `https://nominatim.openstreetmap.org/search?format=json&countrycodes=id&limit=5&q=${encodeURIComponent(q)}`;
      const res = await fetch(url, {
        signal: controller.signal,
        headers: { "Accept-Language": "id" },
      });
      if (!res.ok) {
        throw new Error(`Nominatim HTTP ${res.status}`);
      }
      const data = (await res.json()) as NominatimHit[];
      nominatimCacheRef.current.set(cacheKey, data);
      setNominatimResults(data);
      if (data.length === 0) {
        setNominatimError("Lokasi tidak ditemukan. Coba nama kecamatan/kabupaten lain.");
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setNominatimError(
        "Pencarian peta sedang tidak tersedia (offline / dibatasi). Gunakan pilihan wilayah atau koordinat manual.",
      );
    } finally {
      setNominatimLoading(false);
    }
  };

  useEffect(() => {
    const q = nominatimQuery.trim();
    if (q.length < 3) {
      setNominatimResults([]);
      setNominatimError(null);
      return;
    }
    const timer = window.setTimeout(() => {
      void runNominatimSearch(q);
    }, 650);
    return () => window.clearTimeout(timer);
  }, [nominatimQuery]);

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
  const metrics = geometry === null ? null : estimatePolygonMetrics(geometry);

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

  const applyRegionPreset = (value: string) => {
    setRegionPreset(value);
    const found = REGION_OPTIONS.find((opt) => opt.value === value);
    if (found !== undefined) {
      setLat(found.lat);
      setLon(found.lon);
      setLocationFeedback(`Lokasi dipindahkan ke ${found.label}.`);
      setError(null);
    }
  };

  const applyNominatimHit = (hit: NominatimHit) => {
    const parsedLat = Number(hit.lat);
    const parsedLon = Number(hit.lon);
    if (!Number.isFinite(parsedLat) || !Number.isFinite(parsedLon)) return;
    setRegionPreset("custom");
    setLat(parsedLat.toFixed(5));
    setLon(parsedLon.toFixed(5));
    setTileFailed(false);
    setNominatimResults([]);
    setLocationFeedback(`Lokasi dipindahkan ke ${hit.display_name.split(",").slice(0, 2).join(", ")}.`);
    setError(null);
  };

  const applyGoogleMapsInput = () => {
    const parsed = parseGoogleMapsLocation(mapsInput);
    if (parsed === null) {
      setError(
        new Error(
          "Format lokasi tidak dikenali. Tempel tautan Google Maps atau angka seperti -6.3220, 107.7520.",
        ),
      );
      return;
    }
    setError(null);
    setLat(parsed.lat.toFixed(5));
    setLon(parsed.lon.toFixed(5));
    setLocationFeedback(
      `Lokasi diperbarui dari Google Maps (${parsed.lat.toFixed(4)}°, ${parsed.lon.toFixed(4)}°).`,
    );
  };

  const detectCurrentLocation = () => {
    if (!("geolocation" in navigator)) {
      setError(new Error("Peramban Anda tidak mendukung fitur deteksi GPS."));
      return;
    }
    setLocationFeedback("Mencari lokasi GPS Anda…");
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setError(null);
        setLat(pos.coords.latitude.toFixed(5));
        setLon(pos.coords.longitude.toFixed(5));
        setLocationFeedback(
          `Lokasi GPS ditemukan (${pos.coords.latitude.toFixed(4)}°, ${pos.coords.longitude.toFixed(4)}°).`,
        );
      },
      () => {
        setLocationFeedback(null);
        setError(
          new Error(
            "Izin lokasi ditolak atau GPS tidak tersedia. Gunakan Pilih Wilayah atau tempel dari Google Maps.",
          ),
        );
      },
      { enableHighAccuracy: true, timeout: 8000 },
    );
  };

  const startEditingField = (field: (typeof fields)[number]) => {
    const fitted = frameAndVerticesFromGeometry(field.geometry);
    setEditingFieldId(field.id);
    setFieldName(field.name);
    setLat(fitted.lat);
    setLon(fitted.lon);
    setSpanKm(fitted.spanKm);
    setVertices(fitted.vertices);
    setSelectedVertex(null);
    setPolygonText("");
    setLocationFeedback(
      `Mengubah batas lahan "${field.name}". Seret titik sudut di sketsa untuk mengubah bentuknya.`,
    );
    window.requestAnimationFrame(() => {
      fieldEditorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  const cancelEditingField = () => {
    setEditingFieldId(null);
    setFieldName("");
    setVertices([]);
    setSelectedVertex(null);
    setPolygonText("");
    setLocationFeedback(null);
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
      notifyDataChanged();
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
      notifyDataChanged();
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
    if (geometry === null) {
      setError(new Error(reason === "" ? "Bentuk area lahan belum lengkap." : reason));
      return;
    }
    setBusy(true);
    setError(null);
    setSavedNotice(null);
    try {
      if (editingFieldId === null) {
        const created = await api.createField(selected.id, fieldName.trim(), geometry);
        setDetailFieldId(created.id);
        setSavedNotice(
          `Lahan "${created.name}" (${created.areaHa.toFixed(2)} ha) berhasil disimpan. Lengkapi kondisi tanah dan pengairannya di panel Detail di atas.`,
        );
      } else {
        const stored = fields.find((field) => field.id === editingFieldId);
        const unchanged =
          stored !== undefined && JSON.stringify(geometry) === JSON.stringify(stored.geometry);
        if (unchanged) {
          await api.updateField(editingFieldId, { name: fieldName.trim() });
        } else {
          await api.updateField(editingFieldId, {
            name: fieldName.trim(),
            geometry,
          });
        }
        setSavedNotice("Perubahan data dan batas lahan berhasil disimpan.");
      }
      setFieldName("");
      setEditingFieldId(null);
      setVertices([]);
      setSelectedVertex(null);
      setPolygonText("");
      setLocationFeedback(null);
      notifyDataChanged();
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
      if (editingFieldId === fieldId) cancelEditingField();
      if (detailFieldId === fieldId) setDetailFieldId(null);
      setSavedNotice("Lahan berhasil dihapus.");
      notifyDataChanged();
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const edgeLabels =
    geometry !== null && vertices.length >= 3 && polygonText.trim() === ""
      ? computeEdgeLabels(vertices, geometry)
      : [];

  return (
    <div className="stack">
      <PageGuide
        storageKey="farms"
        title="Panduan Kebun & Lahan"
        summary="Kelola lokasi kebun Anda, tandai batas lahan secara visual tanpa perlu paham koordinat teknis, dan isi profil tanah serta irigasi."
        steps={[
          {
            title: "1. Buat Kebun",
            detail: "Kebun adalah nama lokasi usaha tani Anda (misalnya: Kebun Subang Utara).",
          },
          {
            title: "2. Pilih Lokasi & Gambar Batas",
            detail:
              "Pilih wilayah terdekat, tempel titik dari Google Maps, atau gunakan GPS, lalu gambar bentuk lahan dengan melihat ukuran luas & keliling otomatis.",
          },
          {
            title: "3. Lengkapi Profil Tanah",
            detail:
              "Klik tombol Detail & Profil Tanah pada lahan untuk mengisi jenis tanah, drainase, pH, dan irigasi.",
          },
        ]}
        glossary={[
          { term: "Kebun", meaning: "Lokasi induk atau kelompok lahan" },
          { term: "Lahan", meaning: "Petak tanam dengan batas area tertentu" },
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
              <FieldLabel htmlFor="farm-name" label="Nama Kebun" />
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
              <FieldLabel htmlFor="farm-region" label="Kabupaten / Wilayah (opsional)" />
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
                  <th className="col-text">Nama Lahan</th>
                  <th className="col-num">Luas (ha)</th>
                  <th className="col-date">Tanggal Dibuat</th>
                  <th className="col-actions">Aksi</th>
                </tr>
              </thead>
              <tbody>
                {selectedFields.map((field) => (
                  <tr key={field.id}>
                    <td className="col-text">
                      <strong>{field.name}</strong>
                    </td>
                    <td className="col-num">{field.areaHa.toFixed(2)} ha</td>
                    <td className="col-date muted">{field.createdAt.slice(0, 10)}</td>
                    <td className="col-actions">
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
                          onClick={() => startEditingField(field)}
                        >
                          Ubah Batas &amp; Nama
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

        {selected !== undefined && selectedFields.length > 0 ? (
          <FarmOverviewMap
            farmName={selected.name}
            fields={selectedFields}
            selectedFieldId={detailFieldId}
            onSelectField={(id) => setDetailFieldId(id)}
          />
        ) : null}

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
          <form ref={fieldEditorRef} className="panel" onSubmit={saveField}>
            <div className="panel-head">
              <h3>{editingFieldId === null ? "Tambah Lahan Baru" : "Ubah Nama & Batas Lahan"}</h3>
              {editingFieldId !== null ? <Tag tone="warn">Mode Edit Batas</Tag> : null}
            </div>
            <div className="panel-body form-grid">
              <div className="field">
                <FieldLabel htmlFor="field-name" label="Nama Lahan" />
                <input
                  id="field-name"
                  required
                  maxLength={100}
                  placeholder="Contoh: Petak Sawah A1"
                  value={fieldName}
                  onChange={(event) => setFieldName(event.target.value)}
                />
              </div>

              <div className="field">
                <FieldLabel
                  htmlFor="field-span"
                  label="Ukuran Area Kotak Sketsa"
                  tooltip="Mengatur lebar kotak gambar di bawah (misalnya 0,5 km cocok untuk petak kecil, 1–2 km untuk kebun luas)."
                />
                <CustomSelect
                  id="field-span"
                  value={spanKm}
                  onChange={(next) => setSpanKm(next)}
                  options={[
                    { value: "0.3", label: "300 m × 300 m (Petak kecil < 5 ha)" },
                    { value: "0.5", label: "500 m × 500 m (Petak sedang 5–15 ha)" },
                    { value: "1", label: "1 km × 1 km (Standar kebun)" },
                    { value: "2", label: "2 km × 2 km (Kawasan luas)" },
                    { value: "5", label: "5 km × 5 km (Hamparan besar)" },
                  ]}
                />
              </div>

              <div className="location-box">
                <div className="spread">
                  <strong>Lokasi Lahan</strong>
                  <span className="faint numeric">
                    Titik pusat aktif: {Number(lat).toFixed(4)}°, {Number(lon).toFixed(4)}°
                  </span>
                </div>

                <div className="location-row">
                  <div className="field">
                    <FieldLabel
                      htmlFor="field-region-preset"
                      label="Pilih Wilayah Pertanian"
                      tooltip="Cara termudah: pilih kabupaten/daerah terdekat jika Anda belum memiliki titik koordinat persis."
                    />
                    <CustomSelect
                      id="field-region-preset"
                      value={regionPreset}
                      onChange={applyRegionPreset}
                      options={REGION_OPTIONS}
                    />
                  </div>

                  <div className="field">
                    <FieldLabel
                      htmlFor="field-gmaps"
                      label="Atau Tempel dari Google Maps"
                      tooltip="Buka Google Maps di HP/laptop → klik kanan atau tekan lama lokasi sawah Anda → salin angkanya (contoh: -6.3220, 107.7520) atau salin link URL-nya lalu tempel di sini."
                    />
                    <div className="row">
                      <input
                        id="field-gmaps"
                        style={{ flex: "1 1 160px" }}
                        placeholder="Tempel link Maps atau -6.322, 107.752"
                        value={mapsInput}
                        onChange={(e) => setMapsInput(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn btn-quiet btn-sm"
                        onClick={applyGoogleMapsInput}
                      >
                        Terapkan
                      </button>
                    </div>
                  </div>
                </div>

                <div className="field">
                  <FieldLabel
                    htmlFor="field-nominatim-search"
                    label="Cari Desa / Kecamatan"
                    tooltip="Ketik minimal 3 huruf nama desa, kecamatan, atau kabupaten di Indonesia untuk mengarahkan peta secara otomatis."
                  />
                  <div className="row">
                    <input
                      id="field-nominatim-search"
                      style={{ flex: "1 1 200px" }}
                      placeholder="Contoh: Lembang, Bandung Barat"
                      value={nominatimQuery}
                      onChange={(e) => setNominatimQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          void runNominatimSearch(nominatimQuery);
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="btn btn-quiet btn-sm"
                      disabled={nominatimLoading || nominatimQuery.trim().length < 3}
                      onClick={() => void runNominatimSearch(nominatimQuery)}
                    >
                      {nominatimLoading ? "Mencari…" : "Cari Lokasi"}
                    </button>
                  </div>
                  {nominatimError !== null ? (
                    <span className="faint" style={{ fontSize: "0.82rem" }}>
                      {nominatimError}
                    </span>
                  ) : null}
                  {nominatimResults.length > 0 ? (
                    <div className="nominatim-results" role="listbox" aria-label="Hasil pencarian lokasi">
                      {nominatimResults.map((hit) => (
                        <button
                          key={hit.place_id}
                          type="button"
                          className="nominatim-hit"
                          onClick={() => applyNominatimHit(hit)}
                        >
                          <span>{hit.display_name}</span>
                          <span className="faint numeric" style={{ fontSize: "0.75rem" }}>
                            {Number(hit.lat).toFixed(4)}°, {Number(hit.lon).toFixed(4)}°
                          </span>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    onClick={detectCurrentLocation}
                  >
                    <IconCompass size={15} />
                    <span>Gunakan Lokasi Saya (GPS)</span>
                  </button>
                  {locationFeedback !== null ? (
                    <span className="muted" style={{ fontSize: "0.85rem" }}>
                      {locationFeedback}
                    </span>
                  ) : null}
                </div>

                <details className="tech-details">
                  <summary>Ubah angka lintang / bujur secara manual</summary>
                  <div className="form-grid">
                    <div className="field">
                      <FieldLabel htmlFor="field-lat" label="Lintang (Latitude)" />
                      <input
                        id="field-lat"
                        type="number"
                        step="any"
                        min="-90"
                        max="90"
                        value={lat}
                        onChange={(event) => setLat(event.target.value)}
                      />
                    </div>
                    <div className="field">
                      <FieldLabel htmlFor="field-lon" label="Bujur (Longitude)" />
                      <input
                        id="field-lon"
                        type="number"
                        step="any"
                        min="-180"
                        max="180"
                        value={lon}
                        onChange={(event) => setLon(event.target.value)}
                      />
                    </div>
                  </div>
                </details>
              </div>

              <div className="sketch-block">
                <div className="spread">
                  <span className="eyebrow">Gambar Batas Lahan</span>
                  <span className="faint numeric">{vertices.length} titik sudut</span>
                </div>

                <div className="sketch-metrics" role="status">
                  {metrics === null ? (
                    <span className="muted">
                      Tandai minimal 3 titik sudut di kotak untuk menghitung perkiraan luas dan
                      keliling secara otomatis.
                    </span>
                  ) : (
                    <>
                      <Tag tone="accent">Perkiraan Luas: {metrics.areaHa.toFixed(2)} ha</Tag>
                      <span className="muted numeric">
                        ({Math.round(metrics.areaSqm).toLocaleString("id-ID")} m²)
                      </span>
                      <span>·</span>
                      <span className="numeric">
                        Keliling:{" "}
                        <strong>{Math.round(metrics.perimeterM).toLocaleString("id-ID")} m</strong>
                      </span>
                    </>
                  )}
                </div>

                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={busy}
                    onClick={() => {
                      setPolygonText("");
                      setVertices(SQUARE_PRESET);
                    }}
                  >
                    Buat bentuk persegi otomatis
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={busy || vertices.length === 0}
                    onClick={() => {
                      setVertices((current) => current.slice(0, -1));
                      setSelectedVertex(null);
                    }}
                  >
                    Hapus titik terakhir
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={busy || selectedVertex === null || vertices.length <= 3}
                    onClick={() => {
                      if (selectedVertex === null) return;
                      setVertices((current) => current.filter((_, idx) => idx !== selectedVertex));
                      setSelectedVertex(null);
                    }}
                  >
                    Hapus titik terpilih
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet btn-sm"
                    disabled={busy || vertices.length === 0}
                    onClick={() => {
                      setVertices([]);
                      setSelectedVertex(null);
                    }}
                  >
                    Ulangi sketsa
                  </button>
                  <div className="basemap-toggle" role="group" aria-label="Mode latar peta">
                    {(
                      [
                        { id: "none", label: "Sketsa Polos" },
                        { id: "osm", label: "Peta Jalan (OSM)" },
                        { id: "satellite", label: "Citra Satelit (Esri)" },
                      ] as const
                    ).map((opt) => (
                      <button
                        key={opt.id}
                        type="button"
                        className={`btn btn-sm ${basemapMode === opt.id ? "btn-primary" : "btn-quiet"}`}
                        aria-pressed={basemapMode === opt.id}
                        onClick={() => {
                          setTileFailed(false);
                          setBasemapMode(opt.id);
                        }}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </div>
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
                    {basemapMode !== "none" && !tileFailed ? (
                      <image
                        href={basemapTileUrl(basemapMode, Number(lat), Number(lon), spanKm)}
                        x={PLOT_MIN}
                        y={PLOT_MIN}
                        width={PLOT_SIZE}
                        height={PLOT_SIZE}
                        preserveAspectRatio="xMidYMid slice"
                        opacity={basemapMode === "satellite" ? 0.68 : 0.48}
                        pointerEvents="none"
                        onError={() => setTileFailed(true)}
                      />
                    ) : null}
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
                    {edgeLabels.map((edge, idx) => (
                      <text
                        key={`edge-${idx}`}
                        className="sketch-edge-label"
                        x={edge.x}
                        y={edge.y}
                        textAnchor="middle"
                      >
                        {edge.label}
                      </text>
                    ))}
                    {vertices.map((vertex, index) => (
                      <circle
                        key={index}
                        className={`sketch-vertex${selectedVertex === index ? " is-selected" : ""}`}
                        cx={plot(vertex.x)}
                        cy={plot(vertex.y)}
                        r={selectedVertex === index ? 6 : 4.8}
                        role="img"
                        aria-label={`Titik ${index + 1}`}
                        onPointerDown={(event) => {
                          event.currentTarget.setPointerCapture(event.pointerId);
                          setSelectedVertex(index);
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
                  {basemapMode !== "none" ? (
                    <p className="basemap-attribution">
                      {basemapMode === "satellite"
                        ? "Tiles © Esri — World Imagery"
                        : "© OpenStreetMap contributors"}
                    </p>
                  ) : null}
                  <p className="faint">
                    Klik di dalam kotak untuk menandai sudut lahan (minimal 3 titik), seret titik
                    untuk mengubah bentuknya, atau klik &ldquo;Buat bentuk persegi otomatis&rdquo;.
                  </p>
                  {reason === "" ? null : <p className="faint">{reason}</p>}
                </div>

                <details className="tech-details">
                  <summary>Input daftar koordinat poligon manual (lanjutan)</summary>
                  <div className="field">
                    <FieldLabel
                      htmlFor="field-polygon"
                      label="Daftar titik koordinat (bujur, lintang — satu titik per baris)"
                      tooltip="Jika diisi, daftar ini menggantikan sketsa visual di atas. Kosongkan untuk memakai gambar sketsa."
                    />
                    <textarea
                      id="field-polygon"
                      rows={4}
                      value={polygonText}
                      onChange={(event) => setPolygonText(event.target.value)}
                    />
                  </div>
                </details>
              </div>

              <div className="form-actions">
                <button
                  className="btn btn-primary"
                  type="submit"
                  disabled={busy || geometry === null}
                >
                  {editingFieldId === null ? "Simpan Lahan" : "Simpan Perubahan"}
                </button>
                {editingFieldId === null ? null : (
                  <button type="button" className="btn btn-quiet" onClick={cancelEditingField}>
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
      notifyDataChanged();
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
          Ringkasan visual otomatis berubah saat Anda mengisi data di bawah.
        </p>
      </div>
      <SoilProfileVisual
        soilType={soilType || null}
        drainageClass={drainageClass || null}
        irrigationAvailability={irrigation || null}
        soilPh={soilPh.trim() !== "" && Number.isFinite(Number(soilPh)) ? Number(soilPh) : null}
        elevationM={
          elevationM.trim() !== "" && Number.isFinite(Number(elevationM))
            ? Number(elevationM)
            : null
        }
      />
      {error !== null ? <ErrorNotice error={error} /> : null}
      {savedNotice ? (
        <Notice tone="success">Profil tanah dan pengairan berhasil disimpan.</Notice>
      ) : null}
      <div className="form-grid">
        <div className="field">
          <FieldLabel htmlFor="agro-soil" label="Jenis Tanah" />
          <CustomSelect
            id="agro-soil"
            value={soilType}
            onChange={setSoilType}
            options={[
              { value: "", label: "— Belum diisi —" },
              ...(
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
              ).map((v) => ({ value: v, label: soilTypeLabel(v) })),
            ]}
          />
        </div>

        <div className="field">
          <FieldLabel
            htmlFor="agro-drainage"
            label="Aliran Air / Drainase"
            tooltip="Menunjukkan seberapa cepat genangan air surut setelah hujan deras."
          />
          <CustomSelect
            id="agro-drainage"
            value={drainageClass}
            onChange={setDrainageClass}
            options={[
              { value: "", label: "— Belum diisi —" },
              ...(["poor", "moderate", "well", "excessive", "unknown"] as const).map((v) => ({
                value: v,
                label: drainageClassLabel(v),
              })),
            ]}
          />
        </div>

        <div className="field">
          <FieldLabel htmlFor="agro-irrigation" label="Ketersediaan Irigasi" />
          <CustomSelect
            id="agro-irrigation"
            value={irrigation}
            onChange={setIrrigation}
            options={[
              { value: "", label: "— Belum diisi —" },
              ...(["irrigated", "partial_irrigation", "rainfed", "unknown"] as const).map((v) => ({
                value: v,
                label: irrigationLabel(v),
              })),
            ]}
          />
        </div>

        <div className="field">
          <FieldLabel
            htmlFor="agro-ph"
            label="pH Tanah (3.0–10.0)"
            tooltip="Umumnya tanah subur berada di kisaran 5,5 – 7,0."
          />
          <input
            id="agro-ph"
            type="number"
            step="any"
            min="3"
            max="10"
            placeholder="Contoh: 6.3"
            value={soilPh}
            onChange={(e) => setSoilPh(e.target.value)}
          />
        </div>

        <div className="field">
          <FieldLabel
            htmlFor="agro-elev"
            label="Ketinggian Lokasi (mdpl)"
            tooltip="Ketinggian lahan dalam meter di atas permukaan laut (mdpl)."
          />
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
        </div>

        <div className="field">
          <FieldLabel htmlFor="agro-water" label="Sumber Air Utama (opsional)" />
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

function parseGoogleMapsLocation(raw: string): { lat: number; lon: number } | null {
  const text = raw.trim();
  if (text === "") return null;

  const atMatch = /@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/.exec(text);
  const queryMatch = /[?&](?:q|ll)=(-?\d+(?:\.\d+)?)[,\s]+(-?\d+(?:\.\d+)?)/.exec(text);
  const bangMatch = /!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/.exec(text);
  const plainMatch = /^(-?\d+(?:\.\d+)?)\s*[,\s]\s*(-?\d+(?:\.\d+)?)$/.exec(text);

  const match = atMatch ?? queryMatch ?? bangMatch ?? plainMatch;
  if (match?.[1] === undefined || match[2] === undefined) return null;

  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;
  return { lat, lon };
}

function frameAndVerticesFromGeometry(geometry: PolygonGeometry): {
  lat: string;
  lon: string;
  spanKm: string;
  vertices: SketchPoint[];
} {
  const ring = geometry.coordinates[0] ?? [];
  const corners = ring.length > 1 ? ring.slice(0, -1) : ring;
  if (corners.length === 0) {
    return { lat: "-6.3220", lon: "107.7520", spanKm: "1", vertices: [] };
  }

  const lons = corners.map(([lo]) => lo);
  const lats = corners.map(([, la]) => la);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;

  const latKm = (maxLat - minLat) * KM_PER_DEGREE;
  const lonKm =
    (maxLon - minLon) * KM_PER_DEGREE * Math.max(0.1, Math.cos((centerLat * Math.PI) / 180));
  const rawSpan = Math.max(0.3, Math.max(latKm, lonKm) * 1.45);
  const spanChoices = [0.3, 0.5, 1, 2, 5];
  const chosenSpan =
    spanChoices.find((choice) => choice >= rawSpan) ?? Math.min(50, Math.ceil(rawSpan)).toString();

  const spanNum = Number(chosenSpan);
  const fittedFrame = frameBounds(centerLat, centerLon, spanNum);
  if (fittedFrame === null) {
    return {
      lat: centerLat.toFixed(5),
      lon: centerLon.toFixed(5),
      spanKm: "1",
      vertices: [],
    };
  }

  const vertices: SketchPoint[] = corners.map(([lo, la]) => ({
    x: clamp01((lo - fittedFrame.left) / (fittedFrame.right - fittedFrame.left)),
    y: clamp01((fittedFrame.top - la) / (fittedFrame.top - fittedFrame.bottom)),
  }));

  return {
    lat: centerLat.toFixed(5),
    lon: centerLon.toFixed(5),
    spanKm: String(chosenSpan),
    vertices,
  };
}

const WGS84_A = 6_378_137.0;
const WGS84_F = 1 / 298.257223563;
const WGS84_E2 = 2 * WGS84_F - WGS84_F * WGS84_F;
const WGS84_E = Math.sqrt(WGS84_E2);
// Authalic sphere radius for WGS84 ellipsoid
const WGS84_AUTHALIC_R =
  WGS84_A *
  Math.sqrt((1 - ((1 - WGS84_E2) / (2 * WGS84_E)) * Math.log((1 - WGS84_E) / (1 + WGS84_E))) / 2);

function authalicSin(latRad: number): number {
  const sinPhi = Math.sin(latRad);
  const esin = WGS84_E * sinPhi;
  const q =
    (1 - WGS84_E2) *
    (sinPhi / (1 - esin * esin) - (1 / (2 * WGS84_E)) * Math.log((1 - esin) / (1 + esin)));
  const qMax =
    (1 - WGS84_E2) *
    (1 / (1 - WGS84_E2) - (1 / (2 * WGS84_E)) * Math.log((1 - WGS84_E) / (1 + WGS84_E)));
  return q / qMax;
}

function haversineMeters(a: readonly [number, number], b: readonly [number, number]): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const latMid = toRad((a[1] + b[1]) / 2);
  const sinMid = Math.sin(latMid);
  const denom = 1 - WGS84_E2 * sinMid * sinMid;
  // Meridian (M) and prime-vertical (N) radii on WGS84 ellipsoid
  const mRadius = (WGS84_A * (1 - WGS84_E2)) / Math.pow(denom, 1.5);
  const nRadius = WGS84_A / Math.sqrt(denom);
  const dLat = toRad(b[1] - a[1]) * mRadius;
  const dLon = toRad(b[0] - a[0]) * nRadius * Math.cos(latMid);
  return Math.hypot(dLat, dLon);
}

function estimatePolygonMetrics(geometry: PolygonGeometry): {
  areaSqm: number;
  areaHa: number;
  perimeterM: number;
} {
  const ring = geometry.coordinates[0] ?? [];
  if (ring.length < 4) return { areaSqm: 0, areaHa: 0, perimeterM: 0 };

  let perimeterM = 0;
  let geodesicSum = 0;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  for (let i = 0; i < ring.length - 1; i += 1) {
    const p1 = ring[i];
    const p2 = ring[i + 1];
    if (p1 === undefined || p2 === undefined) continue;
    perimeterM += haversineMeters(p1, p2);

    const lon1 = toRad(p1[0]);
    const lon2 = toRad(p2[0]);
    const lat1 = toRad(p1[1]);
    const lat2 = toRad(p2[1]);
    geodesicSum += (lon2 - lon1) * (2 + authalicSin(lat1) + authalicSin(lat2));
  }

  const areaSqm = (Math.abs(geodesicSum) * WGS84_AUTHALIC_R * WGS84_AUTHALIC_R) / 2;
  return { areaSqm, areaHa: areaSqm / 10_000, perimeterM };
}

function computeEdgeLabels(
  vertices: readonly SketchPoint[],
  geometry: PolygonGeometry,
): readonly { x: number; y: number; label: string }[] {
  const ring = geometry.coordinates[0] ?? [];
  if (ring.length < 4) return [];
  const labels: { x: number; y: number; label: string }[] = [];
  for (let i = 0; i < vertices.length; i += 1) {
    const v1 = vertices[i];
    const v2 = vertices[(i + 1) % vertices.length];
    const p1 = ring[i];
    const p2 = ring[(i + 1) % vertices.length];
    if (v1 === undefined || v2 === undefined || p1 === undefined || p2 === undefined) continue;
    const meters = Math.round(haversineMeters(p1, p2));
    labels.push({
      x: (plot(v1.x) + plot(v2.x)) / 2,
      y: (plot(v1.y) + plot(v2.y)) / 2 - 1.5,
      label: meters >= 1000 ? `${(meters / 1000).toFixed(2)} km` : `${meters} m`,
    });
  }
  return labels;
}

function basemapTileUrl(
  mode: "osm" | "satellite",
  latDeg: number,
  lonDeg: number,
  spanText: string,
): string {
  const safeLat = Number.isFinite(latDeg) ? Math.max(-85, Math.min(85, latDeg)) : -6.322;
  const safeLon = Number.isFinite(lonDeg) ? Math.max(-180, Math.min(180, lonDeg)) : 107.752;
  const span = Number(spanText);
  const zoom = !Number.isFinite(span)
    ? 15
    : span <= 0.5
      ? 16
      : span <= 1.5
        ? 15
        : span <= 3
          ? 14
          : 13;
  const n = 2 ** zoom;
  const x = Math.max(0, Math.min(n - 1, Math.floor(((safeLon + 180) / 360) * n)));
  const latRad = (safeLat * Math.PI) / 180;
  const y = Math.max(
    0,
    Math.min(
      n - 1,
      Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n),
    ),
  );
  if (mode === "satellite") {
    return `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${y}/${x}`;
  }
  return `https://tile.openstreetmap.org/${zoom}/${x}/${y}.png`;
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
