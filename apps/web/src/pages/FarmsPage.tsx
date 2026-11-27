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

  const createFarm = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const farm = await api.createFarm(
        farmName.trim(),
        farmRegion.trim() === "" ? null : farmRegion.trim(),
      );
      setFarmName("");
      setFarmRegion("");
      setSelectedFarmId(farm.id);
      state.reload();
    } catch (failure) {
      setError(failure);
    } finally {
      setBusy(false);
    }
  };

  const createField = async (event: React.FormEvent) => {
    event.preventDefault();
    if (selected === undefined) return;
    setBusy(true);
    setError(null);
    try {
      await api.createField(
        selected.id,
        fieldName.trim(),
        squareAround(Number(lat), Number(lon), Number(spanKm)),
      );
      setFieldName("");
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
              <button
                key={farm.id}
                type="button"
                className="crop-card"
                aria-pressed={selected?.id === farm.id}
                onClick={() => setSelectedFarmId(farm.id)}
                style={
                  selected?.id === farm.id
                    ? { borderColor: "var(--accent)", background: "var(--accent-tint)" }
                    : undefined
                }
              >
                <h3>{farm.name}</h3>
                <span className="muted">{farm.region ?? "Tanpa wilayah"}</span>
                <span className="faint">{countLabel(fields, farm.id)}</span>
              </button>
            ))}
          </div>
        )}

        <form className="panel" onSubmit={createFarm}>
          <div className="panel-head">
            <h3>Kebun baru</h3>
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
                Tambah kebun
              </button>
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {selected !== undefined ? (
          <form className="panel" onSubmit={createField}>
            <div className="panel-head">
              <h3>Lahan baru</h3>
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
              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Tambah lahan
                </button>
              </div>
            </div>
            <div className="panel-body">
              <p className="faint">
                Persegi di sekitar titik pusat. Bentuk ini untuk entri cepat; lahan nyata tidak
                persegi.
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
