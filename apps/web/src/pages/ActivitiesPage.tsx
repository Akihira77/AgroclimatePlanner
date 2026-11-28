import type {
  CropDetail,
  FieldObservationKind,
  Harvest,
  HarvestListMeta,
  Planting,
  PlantingCycleStart,
  PlantingStatus,
} from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { CustomSelect } from "../components/CustomSelect.js";
import { DatePicker } from "../components/DatePicker.js";
import {
  HarvestBarChart,
  ObservationTrendChart,
  PlantingProgressList,
} from "../components/Visuals.js";
import { IconClipboard, IconCloud } from "../icons.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  FieldLabel,
  Loading,
  Notice,
  PageGuide,
  Tag,
  dayLabel,
  notifyDataChanged,
  observationKindLabel,
  plantingStatusLabel,
  plantingStatusTone,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

function todayJakarta(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

const DEFAULT_UNITS: Record<Exclude<FieldObservationKind, "note">, string> = {
  rainfall: "mm",
  soil_moisture: "%",
  temperature: "°C",
};

type ActivityTab = "plantings" | "observations";

export function ActivitiesPage() {
  const state = useAsync("activities-root", async () => {
    const [fields, catalog, plantings] = await Promise.all([
      api.listFields(),
      api.listCrops(),
      api.listPlantings(),
    ]);
    return { fields, crops: catalog.crops, plantings };
  });

  const [tab, setTab] = useState<ActivityTab>("plantings");
  const [selectedFieldId, setSelectedFieldId] = useState("");
  const [selectedCropSlug, setSelectedCropSlug] = useState("");
  const [cropDetail, setCropDetail] = useState<CropDetail | null>(null);
  const [selectedCultivarId, setSelectedCultivarId] = useState("");
  const [plantedAt, setPlantedAt] = useState(todayJakarta);
  const [cycleStartUsed, setCycleStartUsed] = useState<PlantingCycleStart>("transplant");
  const [areaPlantedHa, setAreaPlantedHa] = useState("");
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const [activeHarvestPlanting, setActiveHarvestPlanting] = useState<Planting | null>(null);
  const [harvestState, setHarvestState] = useState<{
    items: Harvest[];
    meta: HarvestListMeta;
  } | null>(null);
  const [harvestedAt, setHarvestedAt] = useState(todayJakarta);
  const [yieldKg, setYieldKg] = useState("");
  const [harvestNotes, setHarvestNotes] = useState("");
  const [confirmEarlyHarvest, setConfirmEarlyHarvest] = useState(false);
  const [openActionMenuId, setOpenActionMenuId] = useState<string | null>(null);

  const [observations, setObservations] = useState<Awaited<
    ReturnType<typeof api.listFieldObservations>
  > | null>(null);
  const [obsKind, setObsKind] = useState<FieldObservationKind>("rainfall");
  const [obsValue, setObsValue] = useState("");
  const [obsUnit, setObsUnit] = useState("mm");
  const [obsMethod, setObsMethod] = useState("");

  const fields = state.data?.fields ?? [];
  const crops = state.data?.crops ?? [];
  const plantings = state.data?.plantings ?? [];

  const activeField = fields.find((f) => f.id === selectedFieldId) ?? fields[0];
  const activeCrop = crops.find((c) => c.slug === selectedCropSlug) ?? crops[0];

  useEffect(() => {
    if (activeField !== undefined && areaPlantedHa === "") {
      setAreaPlantedHa(activeField.areaHa.toFixed(2));
    }
  }, [activeField, areaPlantedHa]);

  useEffect(() => {
    if (activeCrop === undefined) return;
    let alive = true;
    api.cropDetail(activeCrop.slug).then(
      (detail) => {
        if (!alive) return;
        setCropDetail(detail);
        const firstCultivar = detail.cultivars[0];
        if (firstCultivar !== undefined) {
          setSelectedCultivarId(firstCultivar.id);
          setCycleStartUsed(firstCultivar.cycleStart);
        }
      },
      () => {
        if (alive) setCropDetail(null);
      },
    );
    return () => {
      alive = false;
    };
  }, [activeCrop]);

  useEffect(() => {
    if (activeField === undefined) {
      setObservations(null);
      return;
    }
    let alive = true;
    api.listFieldObservations(activeField.id).then(
      (rows) => {
        if (alive) setObservations(rows);
      },
      () => {
        if (alive) setObservations([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [activeField]);

  const loadHarvests = async (planting: Planting) => {
    setActiveHarvestPlanting(planting);
    setActionError(null);
    try {
      const result = await api.listHarvests(planting.id);
      setHarvestState({ items: result.data, meta: result.meta });
    } catch (failure) {
      setActionError(failure);
    }
  };

  if (state.data === null) {
    if (state.loading) return <Loading />;
    return state.error === null ? null : <ErrorNotice error={state.error} />;
  }

  if (fields.length === 0) {
    return (
      <Empty>
        <p>Belum ada lahan yang tercatat.</p>
        <Link className="btn btn-primary" to="/lahan">
          Buat kebun dan lahan dulu
        </Link>
      </Empty>
    );
  }

  const cultivars = cropDetail?.cultivars ?? [];
  const selectedCultivar = cultivars.find((c) => c.id === selectedCultivarId) ?? cultivars[0];

  const submitPlanting = async (event: React.FormEvent) => {
    event.preventDefault();
    if (activeField === undefined || selectedCultivar === undefined) return;
    const area = Number(areaPlantedHa);
    if (!Number.isFinite(area) || area <= 0) {
      setActionError(new Error("Luas tanam harus lebih besar dari 0 ha."));
      return;
    }
    setBusy(true);
    setActionError(null);
    setSavedNotice(null);
    try {
      await api.createPlanting({
        fieldId: activeField.id,
        cultivarId: selectedCultivar.id,
        plantedAt,
        cycleStartUsed,
        areaPlantedHa: area,
      });
      setSavedNotice("Catatan penanaman baru berhasil disimpan.");
      notifyDataChanged();
      state.reload();
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };

  const transitionStatus = async (plantingId: string, nextStatus: PlantingStatus) => {
    setBusy(true);
    setActionError(null);
    setSavedNotice(null);
    try {
      await api.updatePlantingStatus(plantingId, nextStatus);
      setSavedNotice(`Status penanaman diubah menjadi "${plantingStatusLabel(nextStatus)}".`);
      notifyDataChanged();
      state.reload();
      if (activeHarvestPlanting?.id === plantingId) {
        setActiveHarvestPlanting((prev) =>
          prev === null ? null : { ...prev, status: nextStatus },
        );
      }
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };

  const isBeforePlanting =
    activeHarvestPlanting !== null && harvestedAt < activeHarvestPlanting.plantedAt;
  const isEarlyHarvest =
    activeHarvestPlanting !== null &&
    !isBeforePlanting &&
    harvestedAt < activeHarvestPlanting.expectedHarvestEarliest;

  const submitHarvest = async (event: React.FormEvent) => {
    event.preventDefault();
    if (activeHarvestPlanting === null) return;
    if (harvestedAt < activeHarvestPlanting.plantedAt) {
      setActionError(
        new Error(
          `Tanggal panen (${harvestedAt}) tidak boleh lebih awal dari tanggal tanam (${activeHarvestPlanting.plantedAt}).`,
        ),
      );
      return;
    }
    if (isEarlyHarvest && !confirmEarlyHarvest) {
      setActionError(
        new Error(
          "Centang konfirmasi panen lebih awal sebelum menyimpan catatan panen sebelum perkiraan panen.",
        ),
      );
      return;
    }
    const kg = Number(yieldKg);
    if (!Number.isFinite(kg) || kg < 0) {
      setActionError(new Error("Hasil panen (kg) harus berupa angka >= 0."));
      return;
    }
    setBusy(true);
    setActionError(null);
    setSavedNotice(null);
    try {
      await api.createHarvest(activeHarvestPlanting.id, {
        harvestedAt,
        yieldKg: kg,
        notes: harvestNotes.trim() === "" ? null : harvestNotes.trim(),
      });
      setYieldKg("");
      setHarvestNotes("");
      setConfirmEarlyHarvest(false);
      const updated = await api.listHarvests(activeHarvestPlanting.id);
      setHarvestState({ items: updated.data, meta: updated.meta });
      setSavedNotice("Catatan hasil panen berhasil ditambahkan.");
      notifyDataChanged();
      state.reload();
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };

  const submitObservation = async (event: React.FormEvent) => {
    event.preventDefault();
    if (activeField === undefined) return;
    setBusy(true);
    setActionError(null);
    setSavedNotice(null);
    try {
      if (obsKind === "note") {
        await api.createFieldObservation(activeField.id, {
          kind: "note",
          observedAt: new Date().toISOString(),
          method: obsMethod.trim() === "" ? "Catatan lapangan" : obsMethod.trim(),
        });
      } else {
        const numeric = Number(obsValue);
        if (!Number.isFinite(numeric)) {
          throw new Error("Nilai pengukuran harus berupa angka yang sah.");
        }
        await api.createFieldObservation(activeField.id, {
          kind: obsKind,
          value: numeric,
          unit: obsUnit.trim() === "" ? DEFAULT_UNITS[obsKind] : obsUnit.trim(),
          observedAt: new Date().toISOString(),
          method: obsMethod.trim() === "" ? null : obsMethod.trim(),
        });
      }
      setObsValue("");
      setObsMethod("");
      const refreshed = await api.listFieldObservations(activeField.id);
      setObservations(refreshed);
      setSavedNotice("Pengamatan lapangan berhasil dicatat.");
    } catch (failure) {
      setActionError(failure);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <PageGuide
        storageKey="activities"
        title="Panduan Aktivitas & Panen"
        summary="Catat kegiatan penanaman nyata di kebun, rekam hasil panen bertahap, dan simpan catatan cuaca atau kondisi tanah harian."
        steps={[
          {
            title: "1. Catat Penanaman",
            detail:
              "Pilih lahan, komoditas, varietas, dan tanggal tanam untuk melacak perkiraan waktu panen.",
          },
          {
            title: "2. Catat Hasil Panen",
            detail:
              "Klik tombol Catat Panen pada penanaman aktif untuk mencatat panen bertahap (kg).",
          },
          {
            title: "3. Simpan Pengamatan",
            detail:
              "Gunakan tab Pengamatan Lapangan untuk mencatat curah hujan, suhu, kelembapan, atau catatan harian.",
          },
        ]}
      />

      {actionError !== null ? <ErrorNotice error={actionError} /> : null}
      {savedNotice !== null ? <Notice tone="success">{savedNotice}</Notice> : null}

      <div className="tabs" role="tablist" aria-label="Kategori Aktivitas">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "plantings"}
          className={`tab-btn${tab === "plantings" ? " is-active" : ""}`}
          onClick={() => setTab("plantings")}
        >
          <IconClipboard size={16} />
          <span>Penanaman &amp; Panen ({plantings.length})</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "observations"}
          className={`tab-btn${tab === "observations" ? " is-active" : ""}`}
          onClick={() => setTab("observations")}
        >
          <IconCloud size={16} />
          <span>Pengamatan Lapangan ({observations?.length ?? 0})</span>
        </button>
      </div>

      {tab === "plantings" ? (
        <div className="stack">
          <section className="section">
            <h2>Catat Penanaman Baru</h2>
            <form className="panel" onSubmit={submitPlanting}>
              <div className="panel-body form-grid">
                <div className="field">
                  <FieldLabel htmlFor="act-field" label="Lahan" />
                  <CustomSelect
                    id="act-field"
                    value={activeField?.id ?? ""}
                    onChange={(val) => {
                      setSelectedFieldId(val);
                      const found = fields.find((f) => f.id === val);
                      if (found !== undefined) setAreaPlantedHa(found.areaHa.toFixed(2));
                    }}
                    options={fields.map((f) => ({
                      value: f.id,
                      label: `${f.name} · ${f.areaHa.toFixed(2)} ha`,
                    }))}
                  />
                </div>

                <div className="field">
                  <FieldLabel htmlFor="act-crop" label="Komoditas" />
                  <CustomSelect
                    id="act-crop"
                    value={activeCrop?.slug ?? ""}
                    onChange={setSelectedCropSlug}
                    options={crops.map((c) => ({
                      value: c.slug,
                      label: c.nameId,
                    }))}
                  />
                </div>

                <div className="field">
                  <FieldLabel htmlFor="act-cultivar" label="Varietas / Kultivar" />
                  <CustomSelect
                    id="act-cultivar"
                    value={selectedCultivar?.id ?? ""}
                    onChange={(val) => {
                      setSelectedCultivarId(val);
                      const found = cultivars.find((c) => c.id === val);
                      if (found !== undefined) setCycleStartUsed(found.cycleStart);
                    }}
                    options={cultivars.map((c) => ({
                      value: c.id,
                      label: `${c.name} (${c.durationDaysTypical} hr)`,
                    }))}
                  />
                </div>

                <div className="field">
                  <FieldLabel htmlFor="act-planted-at" label="Tanggal Tanam" />
                  <DatePicker id="act-planted-at" value={plantedAt} onChange={setPlantedAt} />
                </div>

                <div className="field">
                  <FieldLabel htmlFor="act-cycle-start" label="Cara Mulai Tanam" />
                  <CustomSelect
                    id="act-cycle-start"
                    value={cycleStartUsed}
                    onChange={(val) =>
                      setCycleStartUsed(val === "sowing" ? "sowing" : "transplant")
                    }
                    options={[
                      { value: "transplant", label: "Pindah tanam (bibit dari semai)" },
                      { value: "sowing", label: "Tanam benih langsung" },
                    ]}
                  />
                </div>

                <div className="field">
                  <FieldLabel htmlFor="act-area" label="Luas Tanam (ha)" />
                  <input
                    id="act-area"
                    type="number"
                    step="any"
                    min="0.01"
                    required
                    value={areaPlantedHa}
                    onChange={(e) => setAreaPlantedHa(e.target.value)}
                  />
                </div>

                <div className="form-actions">
                  <button
                    className="btn btn-primary"
                    type="submit"
                    disabled={busy || selectedCultivar === undefined}
                  >
                    Simpan Penanaman
                  </button>
                </div>
              </div>
            </form>
          </section>

          <section className="section">
            <div className="section-head">
              <h2>Daftar Penanaman</h2>
              <Tag>{plantings.length} catatan</Tag>
            </div>

            {plantings.length === 0 ? (
              <Empty>Belum ada catatan penanaman.</Empty>
            ) : (
              <>
                <PlantingProgressList plantings={plantings} fields={fields} maxItems={6} />
                <div className="panel table-wrap table-wrap-visible">
                  <table className="table table-cards">
                    <thead>
                      <tr>
                        <th>Komoditas &amp; Lahan</th>
                        <th>Tanggal Tanam</th>
                        <th>Perkiraan Panen</th>
                        <th className="numeric">Total Panen</th>
                        <th>Status</th>
                        <th>Aksi</th>
                      </tr>
                    </thead>
                    <tbody>
                      {plantings.map((p) => {
                        const fieldName = fields.find((f) => f.id === p.fieldId)?.name ?? p.fieldId;
                        const menuOpen = openActionMenuId === p.id;
                        return (
                          <tr key={p.id}>
                            <td data-label="Komoditas & Lahan">
                              <strong>{p.cropNameId}</strong>{" "}
                              <span className="muted">({p.cultivarName})</span>
                              <div className="muted" style={{ fontSize: "0.8rem" }}>
                                {fieldName}
                              </div>
                            </td>
                            <td data-label="Tanggal Tanam" className="nowrap">
                              {dayLabel(p.plantedAt)}
                            </td>
                            <td data-label="Perkiraan Panen" className="nowrap muted">
                              {dayLabel(p.expectedHarvestEarliest)} –{" "}
                              {dayLabel(p.expectedHarvestLatest)}
                            </td>
                            <td data-label="Total Panen" className="numeric nowrap">
                              {p.totalYieldKg.toLocaleString("id-ID")} kg
                            </td>
                            <td data-label="Status" className="nowrap">
                              <Tag tone={plantingStatusTone(p.status)}>
                                {plantingStatusLabel(p.status)}
                              </Tag>
                            </td>
                            <td data-label="Aksi">
                              <div className="action-bar">
                                <button
                                  type="button"
                                  className="btn btn-quiet btn-sm"
                                  disabled={busy}
                                  onClick={() => {
                                    setOpenActionMenuId(null);
                                    setConfirmEarlyHarvest(false);
                                    void loadHarvests(p);
                                  }}
                                >
                                  Catat Panen
                                </button>
                                {p.status === "active" ? (
                                  <div className="action-menu-wrap">
                                    <button
                                      type="button"
                                      className="btn btn-quiet btn-sm action-menu-btn"
                                      aria-expanded={menuOpen}
                                      aria-haspopup="menu"
                                      aria-label={`Aksi lainnya untuk ${p.cropNameId}`}
                                      disabled={busy}
                                      onClick={() =>
                                        setOpenActionMenuId((cur) => (cur === p.id ? null : p.id))
                                      }
                                    >
                                      ⋯
                                    </button>
                                    {menuOpen ? (
                                      <div className="action-menu-popover" role="menu">
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="action-menu-item"
                                          onClick={() => {
                                            setOpenActionMenuId(null);
                                            void transitionStatus(p.id, "harvested");
                                          }}
                                        >
                                          Selesai Panen
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="action-menu-item is-danger"
                                          onClick={() => {
                                            setOpenActionMenuId(null);
                                            void transitionStatus(p.id, "failed");
                                          }}
                                        >
                                          Tandai Gagal
                                        </button>
                                        <button
                                          type="button"
                                          role="menuitem"
                                          className="action-menu-item is-danger"
                                          onClick={() => {
                                            setOpenActionMenuId(null);
                                            void transitionStatus(p.id, "abandoned");
                                          }}
                                        >
                                          Hentikan
                                        </button>
                                      </div>
                                    ) : null}
                                  </div>
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>

          {activeHarvestPlanting !== null ? (
            <section className="section">
              <div className="panel">
                <div className="panel-head">
                  <h3>
                    Catatan Panen Bertahap · {activeHarvestPlanting.cropNameId} (
                    {activeHarvestPlanting.cultivarName})
                  </h3>
                  <Tag tone="accent">
                    Total: {(harvestState?.meta.totalYieldKg ?? 0).toLocaleString("id-ID")} kg
                  </Tag>
                </div>
                <div className="panel-body stack">
                  <form className="form-grid" onSubmit={submitHarvest}>
                    <div className="field">
                      <FieldLabel htmlFor="harv-date" label="Tanggal Panen" />
                      <DatePicker
                        id="harv-date"
                        value={harvestedAt}
                        onChange={(nextDate) => {
                          setHarvestedAt(nextDate);
                          setConfirmEarlyHarvest(false);
                        }}
                      />
                    </div>
                    <div className="field">
                      <FieldLabel htmlFor="harv-kg" label="Berat Hasil (kg)" />
                      <input
                        id="harv-kg"
                        type="number"
                        step="any"
                        min="0"
                        required
                        placeholder="Contoh: 450"
                        value={yieldKg}
                        onChange={(e) => setYieldKg(e.target.value)}
                      />
                    </div>
                    <div className="field">
                      <FieldLabel htmlFor="harv-notes" label="Catatan Kualitas (opsional)" />
                      <input
                        id="harv-notes"
                        maxLength={200}
                        placeholder="Contoh: Kualitas baik, kadar air rendah"
                        value={harvestNotes}
                        onChange={(e) => setHarvestNotes(e.target.value)}
                      />
                    </div>
                    {isBeforePlanting ? (
                      <div className="field-span-2">
                        <Notice tone="error">
                          Tanggal panen ({harvestedAt}) tidak boleh lebih awal dari tanggal tanam (
                          {activeHarvestPlanting.plantedAt}).
                        </Notice>
                      </div>
                    ) : isEarlyHarvest ? (
                      <div className="field-span-2 stack-tight">
                        <Notice tone="warn">
                          Perhatian: Tanggal panen ({harvestedAt}) jauh lebih awal dari perkiraan
                          panen paling awal ({activeHarvestPlanting.expectedHarvestEarliest}).
                          Pastikan ini memang panen dini sebelum menyimpan.
                        </Notice>
                        <label className="confirm-check">
                          <input
                            type="checkbox"
                            checked={confirmEarlyHarvest}
                            onChange={(e) => setConfirmEarlyHarvest(e.target.checked)}
                          />
                          <span>Saya yakin ingin mencatat panen lebih awal dari perkiraan</span>
                        </label>
                      </div>
                    ) : null}
                    <div className="form-actions">
                      <button
                        className="btn btn-primary"
                        type="submit"
                        disabled={
                          busy || isBeforePlanting || (isEarlyHarvest && !confirmEarlyHarvest)
                        }
                      >
                        Simpan Panen
                      </button>
                      <button
                        className="btn btn-quiet"
                        type="button"
                        onClick={() => {
                          setActiveHarvestPlanting(null);
                          setHarvestState(null);
                          setConfirmEarlyHarvest(false);
                        }}
                      >
                        Tutup
                      </button>
                    </div>
                  </form>

                  {harvestState === null ? (
                    <Loading label="Memuat daftar panen…" />
                  ) : harvestState.items.length === 0 ? (
                    <p className="muted">Belum ada catatan panen untuk penanaman ini.</p>
                  ) : (
                    <>
                      <HarvestBarChart items={harvestState.items} />
                      <div className="table-wrap">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Tanggal</th>
                              <th className="numeric">Hasil (kg)</th>
                              <th>Catatan</th>
                            </tr>
                          </thead>
                          <tbody>
                            {harvestState.items.map((h) => (
                              <tr key={h.id}>
                                <td className="nowrap">{h.harvestedAt}</td>
                                <td className="numeric">{h.yieldKg.toLocaleString("id-ID")}</td>
                                <td className="muted">{h.notes ?? "—"}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </section>
          ) : null}
        </div>
      ) : (
        <section className="section">
          <div className="section-head">
            <h2>Pengamatan Lapangan · {activeField?.name}</h2>
            <Tag>{observations?.length ?? 0} catatan</Tag>
          </div>

          <form className="panel" onSubmit={submitObservation}>
            <div className="panel-body form-grid">
              <div className="field">
                <FieldLabel htmlFor="obs-field" label="Pilih Lahan" />
                <CustomSelect
                  id="obs-field"
                  value={activeField?.id ?? ""}
                  onChange={setSelectedFieldId}
                  options={fields.map((f) => ({
                    value: f.id,
                    label: `${f.name} · ${f.areaHa.toFixed(2)} ha`,
                  }))}
                />
              </div>

              <div className="field">
                <FieldLabel htmlFor="obs-kind" label="Jenis Pengamatan" />
                <CustomSelect
                  id="obs-kind"
                  value={obsKind}
                  onChange={(val) => {
                    const next = val as FieldObservationKind;
                    setObsKind(next);
                    if (next !== "note") setObsUnit(DEFAULT_UNITS[next]);
                  }}
                  options={[
                    { value: "rainfall", label: "Curah hujan" },
                    { value: "soil_moisture", label: "Kelembapan tanah" },
                    { value: "temperature", label: "Suhu udara/tanah" },
                    { value: "note", label: "Catatan lapangan bebas" },
                  ]}
                />
              </div>

              {obsKind !== "note" ? (
                <>
                  <div className="field">
                    <FieldLabel htmlFor="obs-val" label="Angka Pengukuran" />
                    <input
                      id="obs-val"
                      type="number"
                      step="any"
                      required
                      placeholder="Contoh: 18.5"
                      value={obsValue}
                      onChange={(e) => setObsValue(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <FieldLabel htmlFor="obs-unit" label="Satuan" />
                    <input
                      id="obs-unit"
                      required
                      maxLength={32}
                      value={obsUnit}
                      onChange={(e) => setObsUnit(e.target.value)}
                    />
                  </div>
                </>
              ) : null}

              <div className="field">
                <FieldLabel
                  htmlFor="obs-method"
                  label={
                    obsKind === "note" ? "Isi Catatan Lapangan" : "Alat / Cara Ukur (opsional)"
                  }
                />
                <input
                  id="obs-method"
                  required={obsKind === "note"}
                  maxLength={200}
                  placeholder={
                    obsKind === "note"
                      ? "Contoh: Daun tampak sehat setelah pemupukan"
                      : "Contoh: Penakar hujan manual"
                  }
                  value={obsMethod}
                  onChange={(e) => setObsMethod(e.target.value)}
                />
              </div>

              <div className="form-actions">
                <button className="btn btn-primary" type="submit" disabled={busy}>
                  Simpan Pengamatan
                </button>
              </div>
            </div>
          </form>

          {observations === null ? (
            <Loading label="Memuat catatan pengamatan…" />
          ) : observations.length === 0 ? (
            <Empty>Belum ada pengamatan yang dicatat untuk lahan ini.</Empty>
          ) : (
            <>
              <ObservationTrendChart observations={observations} />
              <div className="panel table-wrap">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Waktu</th>
                      <th>Jenis</th>
                      <th className="numeric">Hasil</th>
                      <th>Alat / Catatan</th>
                    </tr>
                  </thead>
                  <tbody>
                    {observations.map((obs) => (
                      <tr key={obs.id}>
                        <td className="nowrap muted">
                          {obs.observedAt.slice(0, 16).replace("T", " ")}
                        </td>
                        <td>{observationKindLabel(obs.kind)}</td>
                        <td className="numeric">
                          {obs.value === null ? "—" : `${obs.value} ${obs.unit ?? ""}`}
                        </td>
                        <td className="muted">{obs.method ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
