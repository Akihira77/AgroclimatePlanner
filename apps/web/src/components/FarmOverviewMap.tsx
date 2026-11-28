import type { Field } from "@agroclimate/contracts";

import { IconMap } from "../icons.js";
import { Tag } from "../ui.js";

export function FarmOverviewMap({
  farmName,
  fields,
  selectedFieldId,
  onSelectField,
}: {
  readonly farmName: string;
  readonly fields: readonly Field[];
  readonly selectedFieldId: string | null;
  readonly onSelectField: (fieldId: string) => void;
}) {
  if (fields.length === 0) return null;

  const allPoints: [number, number][] = [];
  for (const field of fields) {
    const ring = field.geometry.coordinates[0] ?? [];
    for (const [lon, lat] of ring) {
      allPoints.push([lon, lat]);
    }
  }
  if (allPoints.length === 0) return null;

  const lons = allPoints.map(([lo]) => lo);
  const lats = allPoints.map(([, la]) => la);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);

  const centerLat = (minLat + maxLat) / 2;
  const centerLon = (minLon + maxLon) / 2;
  const cosLat = Math.max(0.1, Math.cos((centerLat * Math.PI) / 180));

  const spanLon = Math.max(0.002, (maxLon - minLon) * cosLat);
  const spanLat = Math.max(0.002, maxLat - minLat);
  const span = Math.max(spanLon, spanLat) * 1.25;

  const project = ([lon, lat]: readonly [number, number]): [number, number] => {
    const dx = ((lon - centerLon) * cosLat) / span;
    const dy = (centerLat - lat) / span;
    return [50 + dx * 84, 50 + dy * 84];
  };

  const totalAreaHa = fields.reduce((sum, f) => sum + f.areaHa, 0);
  const mapsUrl = `https://www.google.com/maps/@${centerLat.toFixed(5)},${centerLon.toFixed(5)},15z`;

  return (
    <div className="panel">
      <div className="panel-head">
        <div className="row">
          <IconMap size={16} />
          <h3>Peta Ringkasan Kebun · {farmName}</h3>
        </div>
        <div className="row">
          <Tag tone="accent">Total luas {totalAreaHa.toFixed(2)} ha</Tag>
          <a href={mapsUrl} target="_blank" rel="noreferrer" className="btn btn-quiet btn-sm">
            Buka lokasi di Google Maps
          </a>
        </div>
      </div>

      <div className="panel-body stack-tight">
        <div className="overview-map-wrap">
          <svg
            className="overview-map"
            viewBox="0 0 100 100"
            role="img"
            aria-label={`Peta ringkasan ${fields.length} lahan di ${farmName}`}
          >
            <rect x="0" y="0" width="100" height="100" fill="var(--surface-subtle)" />
            {[20, 40, 60, 80].map((pos) => (
              <g key={pos}>
                <line className="sketch-grid-line" x1={pos} y1="0" x2={pos} y2="100" />
                <line className="sketch-grid-line" x1="0" y1={pos} x2="100" y2={pos} />
              </g>
            ))}
            <text
              x="95"
              y="8"
              fontSize="4"
              fontWeight="700"
              fill="var(--ink-faint)"
              textAnchor="end"
            >
              U ↑
            </text>

            {fields.map((field) => {
              const ring = field.geometry.coordinates[0] ?? [];
              const pts = ring.map(project);
              const isSelected = field.id === selectedFieldId;
              const cx = pts.reduce((s, [x]) => s + x, 0) / Math.max(1, pts.length);
              const cy = pts.reduce((s, [, y]) => s + y, 0) / Math.max(1, pts.length);
              return (
                <g
                  key={field.id}
                  style={{ cursor: "pointer" }}
                  onClick={() => onSelectField(field.id)}
                >
                  <polygon
                    points={pts.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ")}
                    fill={isSelected ? "var(--warn)" : "var(--accent)"}
                    fillOpacity={isSelected ? 0.34 : 0.22}
                    stroke={isSelected ? "var(--warn)" : "var(--accent-strong)"}
                    strokeWidth={isSelected ? 2.2 : 1.5}
                    vectorEffect="non-scaling-stroke"
                  >
                    <title>{`${field.name} (${field.areaHa.toFixed(2)} ha)`}</title>
                  </polygon>
                  <text className="sketch-edge-label" x={cx} y={cy} textAnchor="middle">
                    {field.name} ({field.areaHa.toFixed(2)} ha)
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
        <p className="faint">
          Klik salah satu petak lahan pada peta di atas untuk membuka detail dan profil tanahnya.
        </p>
      </div>
    </div>
  );
}
