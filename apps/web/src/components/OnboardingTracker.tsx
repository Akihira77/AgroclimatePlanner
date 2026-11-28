import { useCallback, useEffect, useState } from "react";

import { api } from "../api.js";
import { IconArrowRight, IconCheck, IconChevronDown, IconClipboard } from "../icons.js";
import { navigate, useRoute } from "../router.js";
import { DATA_CHANGED_EVENT } from "../ui.js";

interface StepState {
  readonly title: string;
  readonly detail: string;
  readonly to: string;
  readonly cta: string;
  readonly done: boolean;
}

export function OnboardingTracker() {
  const route = useRoute();
  const [open, setOpen] = useState(false);
  const [steps, setSteps] = useState<readonly StepState[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [farms, fields, plantings, windows] = await Promise.all([
        api.listFarms(),
        api.listFields(),
        api.listPlantings(),
        api.listPlantingWindows(),
      ]);

      let agronomyDone = false;
      if (fields.length > 0) {
        const profiles = await Promise.all(
          fields.slice(0, 5).map((f) => api.getFieldAgronomy(f.id).catch(() => null)),
        );
        agronomyDone = profiles.some(
          (p) =>
            p !== null &&
            (p.soilType !== null ||
              p.drainageClass !== null ||
              p.irrigationAvailability !== null ||
              p.soilPh !== null ||
              p.elevationM !== null ||
              p.waterSource !== null),
        );
      }

      setSteps([
        {
          done: farms.length > 0 && fields.length > 0,
          title: "Buat kebun & batas lahan",
          detail: "Daftarkan minimal satu kebun dan tandai batas lahannya.",
          to: "/lahan",
          cta: "Buka Kebun & Lahan",
        },
        {
          done: agronomyDone,
          title: "Isi kondisi tanah & irigasi",
          detail: "Buka Detail lahan untuk melengkapi jenis tanah, drainase, dan irigasi.",
          to: "/lahan",
          cta: "Lengkapi Profil",
        },
        {
          done: windows.length > 0,
          title: "Evaluasi jadwal tanam",
          detail: "Uji tanggal tanam di Rencana Tanam dan lihat saran Asisten AI.",
          to: "/rencana",
          cta: "Buka Rencana",
        },
        {
          done: plantings.length > 0,
          title: "Catat penanaman atau panen",
          detail: "Rekam kegiatan tanam aktual dan pengamatan cuaca di lahan.",
          to: "/aktivitas",
          cta: "Buka Aktivitas",
        },
      ]);
    } catch {
      // Keep previous tracker state silently if background refresh fails.
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh, route.path]);

  useEffect(() => {
    const handler = () => {
      void refresh();
    };
    window.addEventListener(DATA_CHANGED_EVENT, handler);
    return () => window.removeEventListener(DATA_CHANGED_EVENT, handler);
  }, [refresh]);

  if (steps === null) return null;

  const doneCount = steps.filter((s) => s.done).length;
  const percent = Math.round((doneCount / steps.length) * 100);

  return (
    <div className="onboarding-float">
      {open ? (
        <section className="onboarding-modal" aria-label="Progres Mulai Cepat">
          <div className="onboarding-modal-head">
            <div>
              <strong>Mulai dalam 4 Langkah</strong>
              <p className="faint">
                {doneCount === steps.length
                  ? "Semua langkah dasar selesai!"
                  : `${doneCount} dari ${steps.length} langkah selesai`}
              </p>
            </div>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => setOpen(false)}
              aria-label="Tutup panduan mulai"
            >
              <span>Tutup</span>
              <IconChevronDown size={14} />
            </button>
          </div>

          <div className="progress-track" aria-hidden="true">
            <div className="progress-fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="onboarding-modal-list">
            {steps.map((step, idx) => (
              <div
                key={step.title}
                className="onboarding-modal-item"
                data-done={step.done ? "true" : "false"}
              >
                <span className="step-badge">{step.done ? <IconCheck size={13} /> : idx + 1}</span>
                <div className="onboarding-modal-text">
                  <strong>{step.title}</strong>
                  <p>{step.detail}</p>
                </div>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    setOpen(false);
                    navigate(step.to);
                  }}
                >
                  <span>{step.cta}</span>
                  <IconArrowRight size={13} />
                </button>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <button
        type="button"
        className="onboarding-fab"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
      >
        <IconClipboard size={17} />
        <span>Panduan Mulai</span>
        <span className="onboarding-fab-pill">
          {doneCount}/{steps.length}
        </span>
      </button>
    </div>
  );
}
