import { useEffect, useId, useRef, useState } from "react";

import { IconCheck, IconChevronDown } from "../icons.js";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

export function CustomSelect({
  id,
  value,
  options,
  onChange,
  placeholder = "— Pilih —",
  disabled = false,
  ariaLabel,
}: {
  readonly id?: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  readonly ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const wrapRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const selected = options.find((opt) => opt.value === value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggleOpen = () => {
    if (disabled) return;
    setOpen((prev) => {
      const next = !prev;
      if (next) {
        const idx = options.findIndex((o) => o.value === value);
        setActiveIndex(idx >= 0 ? idx : 0);
      }
      return next;
    });
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    if (disabled) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      if (!open) {
        setOpen(true);
        const idx = options.findIndex((o) => o.value === value);
        setActiveIndex(idx >= 0 ? idx : 0);
      } else {
        setActiveIndex((prev) => Math.min(options.length - 1, prev + 1));
      }
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      if (open) {
        setActiveIndex((prev) => Math.max(0, prev - 1));
      }
    } else if (event.key === "Enter" || event.key === " ") {
      if (open && activeIndex >= 0 && options[activeIndex] !== undefined) {
        event.preventDefault();
        onChange(options[activeIndex].value);
        setOpen(false);
      }
    }
  };

  return (
    <div className="select-wrap" ref={wrapRef}>
      <button
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-label={ariaLabel}
        disabled={disabled}
        className={`select-trigger${open ? " is-open" : ""}`}
        onClick={toggleOpen}
        onKeyDown={handleKeyDown}
      >
        <span className={`select-trigger-text${selected === undefined ? " is-placeholder" : ""}`}>
          {selected === undefined ? placeholder : selected.label}
        </span>
        <span className="select-trigger-icon">
          <IconChevronDown size={16} />
        </span>
      </button>

      {open ? (
        <div id={listboxId} role="listbox" className="select-menu">
          {options.length === 0 ? (
            <div className="select-empty">Tidak ada pilihan tersedia</div>
          ) : (
            options.map((opt, idx) => {
              const isSelected = opt.value === value;
              const isFocused = idx === activeIndex;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  className={`select-option${isSelected ? " is-selected" : ""}${isFocused ? " is-focused" : ""}`}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onClick={() => {
                    onChange(opt.value);
                    setOpen(false);
                  }}
                >
                  <span className="select-option-body">
                    <span className="select-option-label">{opt.label}</span>
                    {opt.description !== undefined ? (
                      <span className="select-option-desc">{opt.description}</span>
                    ) : null}
                  </span>
                  {isSelected ? (
                    <span className="select-option-check">
                      <IconCheck size={15} />
                    </span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}
