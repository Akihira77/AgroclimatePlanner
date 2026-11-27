import type { PolygonGeometry } from "@agroclimate/contracts";
import { useState } from "react";

import { api } from "../api.js";
import { ErrorNotice, Empty, Loading, Mono, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

/**
 * Farms and their fields, one screen.
 *
 * A field needs a polygon, and typing a GeoJSON ring is not a thing anyone does.
 * The form takes a centre and a span and builds the square around it — the same
 * shape the fixture suites use. It is a convenience for data entry, not a
 * substitute for drawing on a map: a real parcel is not a square, and the stored
 * geometry is whatever PostGIS accepted.
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
    setBusy(true);
    setError(null);
    try {
      if (editingFieldId === null) {
        await api.createField(
          selected.id,
          fieldName.trim(),
          squareAround(Number(lat), Number(lon), Number(spanKm)),
        );
      } else {
        await api.updateField(editingFieldId, { name: fieldName.trim() });
      }
      setFieldName("");
      setEditingFieldId(null);
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
                          onClick={() => {
                            setEditingFieldId(field.id);
                            setFieldName(field.name);
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
              <h3>{editingFieldId === null ? "Lahan baru" : "Ubah nama lahan"}</h3>
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
                  </div>
                </>
              ) : null}
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  {editingFieldId === null ? "Tambah lahan" : "Simpan nama"}
                </button>
                {editingFieldId === null ? null : (
                  <button
                    type="button"
                    className="btn btn-quiet"
                    onClick={() => {
                      setEditingFieldId(null);
                      setFieldName("");
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
                  ? "Persegi di sekitar titik pusat. Bentuk ini untuk entri cepat; lahan nyata tidak persegi."
                  : "Geometri tidak berubah di sini: PATCH menerima nama saja."}
              </p>
            </div>
          </form>
        ) : null}
      </section>
    </div>
  );
}

function countLabel(fields: readonly { farmId: string }[], farmId: string): string {
  const count = fields.filter((field) => field.farmId === farmId).length;
  return count === 1 ? "1 lahan" : `${count} lahan`;
}

/**
 * A square around a point, as a closed ring of five positions.
 *
 * Degrees per kilometre: 1/111.32 north-south, divided by cos(latitude) east-west.
 * At a latitude where the cosine approaches zero this would explode, but the
 * contract refuses |lat| > 90 and a 0.1–50 km span cannot reach the pole from any
 * real farm; the caller sees the API's own validation if it ever does.
 */
function squareAround(lat: number, lon: number, spanKm: number): PolygonGeometry {
  const halfLat = spanKm / 2 / 111.32;
  const halfLon = spanKm / 2 / (111.32 * Math.cos((lat * Math.PI) / 180));

  const ring: [number, number][] = [
    [lon - halfLon, lat - halfLat],
    [lon + halfLon, lat - halfLat],
    [lon + halfLon, lat + halfLat],
    [lon - halfLon, lat + halfLat],
    [lon - halfLon, lat - halfLat],
  ];

  return { type: "Polygon", coordinates: [ring] };
}
