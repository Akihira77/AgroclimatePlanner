import type { PolygonGeometry } from "@agroclimate/contracts";
import { useState } from "react";

import { api } from "../api.js";
import { ErrorNotice, Empty, Loading, Mono, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

/**
 * Farms and their fields, one screen.
 *
 * A field needs a polygon, and typing a GeoJSON ring is not a thing anyone does.
 * The form draws the ring in a plain SVG frame anchored on the centre and span:
 * click adds a vertex, drag moves it, and the sketch keeps its shape when the
 * frame changes because vertices are stored normalised, not in degrees.
 *
 * No map tiles, no projection. The frame is small enough that equirectangular
 * degrees-per-kilometre is honest, and the stored geometry is whatever PostGIS
 * accepted — a self-intersecting ring is refused there, not here.
 */
export function FarmsPage() {
  const state = useAsync("farms", async () => {
    const [farms, fields] = await Promise.all([api.listFarms(), api.listFields()]);
    return { farms, fields };
  });

  const [selectedFarmId, setSelectedFarmId] = useState<string | null>(null);
  const [editingFarmId, setEditingFarmId] = useState<string | null>(null);
  const [editingFieldId, setEditingFieldId] = useState<string | null>(null);
  const [farmName, setFarmName] = useState("");
  const [farmRegion, setFarmRegion] = useState("");
  const [fieldName, setFieldName] = useState("");
  const [lat, setLat] = useState("-6.2");
  const [lon, setLon] = useState("106.816");
  const [spanKm, setSpanKm] = useState("1");
  const [vertices, setVertices] = useState<readonly SketchPoint[]>([]);
  const [dragging, setDragging] = useState<number | null>(null);
  const [polygonText, setPolygonText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

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
    try {
      const farm =
        editingFarmId === null
          ? await api.createFarm(name, region)
          : await api.updateFarm(editingFarmId, { name, region });
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

  /** The server refuses a farm that still has live fields (`409`); the message says so. */
  const removeFarm = async (farmId: string) => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteFarm(farmId);
      if (selectedFarmId === farmId) setSelectedFarmId(null);
      if (editingFarmId === farmId) {
        setEditingFarmId(null);
        setFarmName("");
        setFarmRegion("");
      }
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
    // The button is disabled for the same condition, but the guard reports rather
    // than returning: a silent no-op is indistinguishable from a hung form.
    if (geometry === null && (editingFieldId === null || polygonText.trim() !== "")) {
      setError(new Error(reason === "" ? "Bentuk lahan belum valid." : reason));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (editingFieldId === null && geometry !== null) {
        await api.createField(selected.id, fieldName.trim(), geometry);
      } else if (editingFieldId !== null) {
        const stored = fields.find((field) => field.id === editingFieldId);
        // Compare values, not text: a formatting-only edit (`106.8,-6.2` versus
        // `106.8, -6.2`) is not a geometry change and should not bump `updated_at`.
        const unchanged =
          stored === undefined ||
          polygonText.trim() === "" ||
          (geometry !== null && JSON.stringify(geometry) === JSON.stringify(stored.geometry));
        // An untouched textarea would re-send the same ring and bump `updated_at` for
        // nothing, so geometry travels only when the text actually differs.
        if (unchanged) {
          await api.updateField(editingFieldId, { name: fieldName.trim() });
        } else if (geometry !== null) {
          await api.updateField(editingFieldId, {
            name: fieldName.trim(),
            geometry,
          });
        }
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
    try {
      await api.deleteField(fieldId);
      if (editingFieldId === fieldId) {
        setEditingFieldId(null);
        setFieldName("");
        // The form's textarea was prefilled from this field, so clearing the edit
        // session without clearing the text would leave its ring in a create form.
        setPolygonText("");
      }
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      {error !== null ? <ErrorNotice error={error} /> : null}

      <section className="section">
        <h2>Kebun</h2>
        {farms.length === 0 ? (
          <Empty>Belum ada kebun. Tambahkan satu di formulir di bawah.</Empty>
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
                  <span className="muted">{farm.region ?? "Tanpa wilayah"}</span>
                  <span className="faint">{countLabel(fields, farm.id)}</span>
                </button>
                <div className="btn-row">
                  <button
                    type="button"
                    className="btn btn-quiet"
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
                    className="btn btn-danger"
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
            <h3>{editingFarmId === null ? "Kebun baru" : "Ubah kebun"}</h3>
          </div>
          <div className="panel-body form-grid">
            <div className="field">
              <label htmlFor="farm-name">Nama</label>
              <input
                id="farm-name"
                required
                maxLength={100}
                value={farmName}
                onChange={(event) => setFarmName(event.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="farm-region">Wilayah (opsional)</label>
              <input
                id="farm-region"
                maxLength={120}
                value={farmRegion}
                onChange={(event) => setFarmRegion(event.target.value)}
              />
            </div>
            <div className="form-actions">
              <button className="btn btn-primary" type="submit" disabled={busy}>
                {editingFarmId === null ? "Tambah kebun" : "Simpan kebun"}
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
          <h2>Lahan {selected === undefined ? "" : `· ${selected.name}`}</h2>
          {selected !== undefined ? <Tag tone="accent">geometri tersimpan</Tag> : null}
        </div>

        {selected === undefined ? (
          <Empty>Pilih atau buat kebun dulu.</Empty>
        ) : selectedFields.length === 0 ? (
          <Empty>Belum ada lahan di kebun ini.</Empty>
        ) : (
          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th className="numeric">Luas (ha)</th>
                  <th>Dibuat</th>
                  <th>Id</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {selectedFields.map((field) => (
                  <tr key={field.id}>
                    <td>{field.name}</td>
                    <td className="numeric">{field.areaHa.toFixed(2)}</td>
                    <td className="muted numeric">{field.createdAt.slice(0, 10)}</td>
                    <td>
                      <Mono>{field.id.slice(0, 8)}</Mono>
                    </td>
                    <td>
                      <div className="btn-row">
                        <button
                          type="button"
                          className="btn btn-quiet"
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
                          className="btn btn-danger"
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

        {selected !== undefined ? (
          <form className="panel" onSubmit={saveField}>
            <div className="panel-head">
              <h3>{editingFieldId === null ? "Lahan baru" : "Ubah lahan"}</h3>
            </div>
            <div className="panel-body form-grid">
              <div className="field">
                <label htmlFor="field-name">Nama</label>
                <input
                  id="field-name"
                  required
                  maxLength={100}
                  value={fieldName}
                  onChange={(event) => setFieldName(event.target.value)}
                />
              </div>
              {editingFieldId === null ? (
                <>
                  <div className="field">
                    <label htmlFor="field-lat">Lintang pusat</label>
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
                    <label htmlFor="field-lon">Bujur pusat</label>
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
                    <label htmlFor="field-span">Sisi (km)</label>
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
                    <span className="hint">Sisi bingkai sketsa.</span>
                  </div>
                  <div className="sketch-block">
                    <div className="spread">
                      <span className="eyebrow">Batas lahan</span>
                      <span className="faint numeric">{vertices.length} titik</span>
                    </div>
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
                          r={6}
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
                      Klik di dalam bingkai untuk menambah titik; seret titik untuk memindahkannya.
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn-quiet"
                        disabled={busy || vertices.length === 0}
                        onClick={() => setVertices((current) => current.slice(0, -1))}
                      >
                        Hapus titik terakhir
                      </button>
                    </div>
                    {reason === "" ? null : <p className="faint">{reason}</p>}
                    <details>
                      <summary className="faint">Tanpa tetikus: tulis poligon</summary>
                      <div className="field">
                        <label htmlFor="field-polygon">
                          Poligon (bujur, lintang — satu titik per baris)
                        </label>
                        <textarea
                          id="field-polygon"
                          rows={4}
                          value={polygonText}
                          onChange={(event) => setPolygonText(event.target.value)}
                        />
                        <span className="hint">
                          Kalau diisi, teks ini menggantikan sketsa. Satu titik per baris, tiap
                          baris berisi bujur lalu lintang; ring ditutup otomatis.
                        </span>
                      </div>
                    </details>
                  </div>
                </>
              ) : (
                <div className="sketch-block">
                  <div className="field">
                    <label htmlFor="field-polygon">Poligon (bujur, lintang)</label>
                    <textarea
                      id="field-polygon"
                      rows={5}
                      value={polygonText}
                      onChange={(event) => setPolygonText(event.target.value)}
                    />
                    <span className="hint">
                      Satu titik per baris, bujur lalu lintang. Kosongkan untuk mempertahankan
                      bentuk sekarang; ring ditutup otomatis.
                    </span>
                  </div>
                  {/* A blank box means "keep the current ring", so the sketch's own
                      "no points yet" reason would be a lie here. */}
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
                  {editingFieldId === null ? "Tambah lahan" : "Simpan"}
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
            <div className="panel-body">
              <p className="faint">
                {editingFieldId === null
                  ? "Titik disimpan sebagai bujur dan lintang saat formulir dikirim; ring ditutup otomatis. Bentuk nyata mengikuti apa yang diterima PostGIS."
                  : "Nama dan batas lahan bisa diubah. Luas adalah kolom turunan, jadi basis data menghitungnya ulang hanya bila bentuknya berubah."}
              </p>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The stored ring as the textarea's own dialect, one point per line and without the
 * closing repeat: what a user typed (or drew) round-trips through `String`, which is
 * exact for a double, so re-sending an untouched field changes no coordinate.
 */
function ringText(geometry: PolygonGeometry): string {
  const ring = geometry.coordinates[0] ?? [];
  const corners = ring.length > 1 ? ring.slice(0, -1) : ring;
  return corners.map(([lon, lat]) => `${String(lon)}, ${String(lat)}`).join("\n");
}

function countLabel(fields: readonly { farmId: string }[], farmId: string): string {
  const count = fields.filter((field) => field.farmId === farmId).length;
  return count === 1 ? "1 lahan" : `${count} lahan`;
}

/** Sketch space is 0..1 on both axes; `0,0` is the frame's north-west corner. */
interface SketchPoint {
  readonly x: number;
  readonly y: number;
}

/** The lat/lon window the sketch covers, in degrees. */
interface Frame {
  readonly top: number;
  readonly bottom: number;
  readonly left: number;
  readonly right: number;
}

const KM_PER_DEGREE = 111.32;

/**
 * Caps, not rules: a parcel has a handful of corners, and a pasted or clicked ring
 * of thousands would freeze this tab long before the server saw it.
 */
const MAX_VERTICES = 200;
/** 200 corners at full double precision, plus room to type. Refused, not truncated. */
const MAX_POLYGON_TEXT = 12000;

/** The plot is inset so a vertex at 0 or 1 is still a full circle on screen. */
const PLOT_MIN = 6;
const PLOT_SIZE = 88;

function plot(normalised: number): number {
  return PLOT_MIN + normalised * PLOT_SIZE;
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/**
 * Degrees per kilometre: 1/111.32 north-south, divided by cos(latitude) east-west.
 * The contract refuses |lat| > 90; here a frame that would cross a pole or the
 * antimeridian is refused outright, because clamping a corner would move the
 * drawing away from the centre the user typed.
 */
/**
 * The frame, or null. The inputs arrive as the strings the form holds, and a
 * cleared `type="number"` field is `""` — which `Number` turns into `0`, not
 * `NaN`. Accepting that would silently anchor the drawing on the equator, so a
 * blank field is refused here rather than defaulted.
 */
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

/** Pointer position in sketch space. The `viewBox` is square and `aspect-ratio` is 1. */
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

/**
 * A closed ring, or null when there are fewer than three distinct positions.
 *
 * Every repeated position is dropped, not just a consecutive one: a corner visited
 * twice makes the ring self-touching, which `ST_IsValid` reads as a zero-area or
 * invalid polygon. Dropping the second visit leaves the shape a user meant, and a
 * ring that still cannot reach three distinct corners is refused.
 */
function ringOf(positions: readonly (readonly [number, number])[]): PolygonGeometry | null {
  const ring: [number, number][] = [];
  for (const [lon, lat] of positions) {
    if (ring.some(([seenLon, seenLat]) => seenLon === lon && seenLat === lat)) continue;
    ring.push([lon, lat]);
  }

  const first = ring[0];
  if (ring.length < 3 || first === undefined) return null;
  return { type: "Polygon", coordinates: [[...ring, [first[0], first[1]]]] };
}

type Parsed = { readonly positions: [number, number][] } | { readonly error: string };

/** `bujur, lintang` per line, comma or whitespace separated. */
function parsePositions(text: string): Parsed {
  const positions: [number, number][] = [];
  for (const raw of text.split(/[\n;]+/)) {
    const line = raw.trim();
    if (line === "") continue;
    const parts = line.split(/[\s,]+/);
    // A leading or trailing separator splits into an empty part, and `Number("")`
    // is 0 — a missing ordinate would become the equator or the prime meridian.
    if (parts.length !== 2 || parts.some((part) => part === ""))
      return { error: `Baris "${line}" butuh tepat dua angka: bujur, lintang.` };

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

/**
 * The geometry the form can submit, and the reason it cannot.
 * Typed text wins when non-empty, so the two inputs never mix into one ring.
 */
function geometryFor(
  vertices: readonly SketchPoint[],
  frame: Frame | null,
  text: string,
): { readonly geometry: PolygonGeometry | null; readonly reason: string } {
  if (text.length > MAX_POLYGON_TEXT) {
    // `maxLength` was here first, and it is the wrong tool: it lets a prefilled
    // value through and then truncates the moment a key is pressed, silently
    // dropping trailing corners from a ring that already exists.
    return {
      geometry: null,
      reason: `Poligon terlalu panjang: ${text.length} karakter, maksimum ${MAX_POLYGON_TEXT}.`,
    };
  }
  if (text.trim() !== "") {
    const parsed = parsePositions(text);
    if ("error" in parsed) return { geometry: null, reason: parsed.error };
    const geometry = ringOf(parsed.positions);
    return geometry === null
      ? { geometry: null, reason: "Poligon butuh minimal 3 titik berbeda." }
      : { geometry, reason: "" };
  }

  if (frame === null) {
    // Every way `frameBounds` can refuse — a non-numeric field, a side that is not
    // positive, a corner past ±90/±180 — ends here, so the message names the inputs
    // rather than guessing which one is wrong.
    return { geometry: null, reason: "Bingkai tidak valid; periksa lintang, bujur, dan sisi." };
  }
  if (vertices.length < 3) {
    if (vertices.length === 0) {
      return { geometry: null, reason: "Belum ada titik; butuh minimal 3 titik." };
    }
    return {
      geometry: null,
      reason: `Baru ${vertices.length} titik; butuh minimal 3 titik berbeda.`,
    };
  }

  const geometry = ringOf(vertices.map((vertex) => positionOf(vertex, frame)));
  return geometry === null
    ? { geometry: null, reason: "Titik berimpit; butuh minimal 3 titik berbeda." }
    : { geometry, reason: "" };
}
