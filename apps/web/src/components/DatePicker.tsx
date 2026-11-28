import { useEffect, useRef, useState } from "react";

import { IconCalendar, IconChevronDown } from "../icons.js";

const MONTH_NAMES = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

const WEEKDAYS = ["Sen", "Sel", "Rab", "Kam", "Jum", "Sab", "Min"];

function todayJakartaIso(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function formatReadableDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length !== 3) return iso;
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const day = Number(parts[2]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return iso;
  const monthShort = MONTH_NAMES[month - 1]?.slice(0, 3) ?? parts[1];
  return `${day} ${monthShort} ${year}`;
}

function parseYearMonth(iso: string): { year: number; month: number } {
  const fallback = todayJakartaIso();
  const src = /^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : fallback;
  const [y, m] = src.split("-").map(Number) as [number, number];
  return { year: y, month: m };
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function buildCalendarDays(year: number, month: number): readonly (string | null)[] {
  const first = new Date(Date.UTC(year, month - 1, 1));
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  // Monday-first: Sun(0) -> 6, Mon(1) -> 0 ...
  const startOffset = (first.getUTCDay() + 6) % 7;
  const cells: (string | null)[] = [];
  for (let i = 0; i < startOffset; i += 1) cells.push(null);
  for (let d = 1; d <= daysInMonth; d += 1) {
    cells.push(`${year}-${pad2(month)}-${pad2(d)}`);
  }
  return cells;
}

export function DatePicker({
  id,
  value,
  onChange,
  disabled = false,
  ariaLabel,
}: {
  readonly id?: string;
  readonly value: string;
  readonly onChange: (isoDate: string) => void;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const initial = parseYearMonth(value);
  const [viewYear, setViewYear] = useState(initial.year);
  const [viewMonth, setViewMonth] = useState(initial.month);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = () => {
    if (disabled) return;
    setOpen((prev) => {
      if (!prev) {
        const parsed = parseYearMonth(value);
        setViewYear(parsed.year);
        setViewMonth(parsed.month);
      }
      return !prev;
    });
  };

  const prevMonth = () => {
    if (viewMonth === 1) {
      setViewYear((y) => y - 1);
      setViewMonth(12);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 12) {
      setViewYear((y) => y + 1);
      setViewMonth(1);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const todayIso = todayJakartaIso();
  const days = buildCalendarDays(viewYear, viewMonth);

  return (
    <div className="datepicker-wrap" ref={wrapRef}>
      <button
        id={id}
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={ariaLabel}
        className={`datepicker-trigger${open ? " is-open" : ""}`}
        onClick={toggle}
      >
        <span className="datepicker-trigger-left">
          <IconCalendar size={16} />
          <span>{value === "" ? "Pilih tanggal" : formatReadableDate(value)}</span>
        </span>
        <span className="select-trigger-icon">
          <IconChevronDown size={16} />
        </span>
      </button>

      {open ? (
        <div className="datepicker-popover" role="dialog" aria-label="Pilih tanggal">
          <div className="datepicker-head">
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={prevMonth}
              aria-label="Bulan sebelumnya"
            >
              ‹
            </button>
            <strong>
              {MONTH_NAMES[viewMonth - 1]} {viewYear}
            </strong>
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={nextMonth}
              aria-label="Bulan berikutnya"
            >
              ›
            </button>
          </div>

          <div className="datepicker-weekdays">
            {WEEKDAYS.map((day) => (
              <span key={day}>{day}</span>
            ))}
          </div>

          <div className="datepicker-grid">
            {days.map((iso, idx) =>
              iso === null ? (
                <span key={`empty-${idx}`} />
              ) : (
                <button
                  key={iso}
                  type="button"
                  className={`datepicker-day${iso === value ? " is-selected" : ""}${iso === todayIso ? " is-today" : ""}`}
                  onClick={() => {
                    onChange(iso);
                    setOpen(false);
                  }}
                >
                  {Number(iso.slice(8, 10))}
                </button>
              ),
            )}
          </div>

          <div className="datepicker-foot">
            <button
              type="button"
              className="btn btn-quiet btn-sm"
              onClick={() => {
                onChange(todayIso);
                setOpen(false);
              }}
            >
              Hari ini
            </button>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => setOpen(false)}>
              Tutup
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
