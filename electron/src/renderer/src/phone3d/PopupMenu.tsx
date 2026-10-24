// A menu drawn in the macOS menu style, for the 3D editor's menus that need
// what the native context menu (main's contextMenu:show) cannot show: a
// submenu (the lane's Easing ›, the timeline's Add 3D Shot ›), check marks,
// key hints and curve pictures. Keyboard: ↑ ↓ move, → opens a submenu, ←
// closes it, Return picks, Esc closes. A press outside closes it.

import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

export type MenuItem =
  | { type: 'separator' }
  | {
      type?: 'item';
      id: string;
      label: React.ReactNode;
      /** Shown on the right in a quieter colour: a key ("⌫", "T") or a count. */
      hint?: string;
      checked?: boolean;
      disabled?: boolean;
      /** A small grey heading row that cannot be picked. */
      head?: boolean;
      picture?: React.ReactNode;
      run?: () => void;
      submenu?: MenuItem[];
    };

export interface MenuSpec {
  /** Viewport point the menu opens at (its top-left, flipped to stay on screen). */
  x: number;
  y: number;
  items: MenuItem[];
  /** 36 px rows for pictures (the Easing pop-up). */
  big?: boolean;
  width?: number;
  /** A pop-up button's menu: open over the button with this item's row on it (macOS). */
  overItem?: string;
  /** Told the item under the pointer (an easing preview), null when none. */
  onHover?: (id: string | null) => void;
  /** Told when the menu closes, picked or not. */
  onClose?: () => void;
}

type Item = Extract<MenuItem, { id: string }>;
const pickable = (it: MenuItem): it is Item => it.type !== 'separator' && !it.disabled && !it.head;
const rowH = (it: MenuItem, big: boolean) => (it.type === 'separator' ? 11 : 'head' in it && it.head ? 20 : big ? 36 : 22);

function Panel({
  items,
  x,
  y,
  big,
  width,
  sub,
  onPick,
  onHover,
  onBack,
  autoFocus,
}: {
  items: MenuItem[];
  x: number;
  y: number;
  big: boolean;
  width?: number;
  sub?: boolean;
  onPick: (it: Item) => void;
  onHover?: (id: string | null) => void;
  onBack?: () => void;
  autoFocus: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [hl, setHl] = useState<number>(-1);
  const [open, setOpen] = useState<number | null>(null);
  const [pos, setPos] = useState({ x, y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const W = window.innerWidth;
    const H = window.innerHeight;
    let nx = x;
    let ny = y;
    if (nx + r.width > W - 6) nx = sub ? x - r.width - (width ?? r.width) - 6 : W - r.width - 6;
    if (ny + r.height > H - 6) ny = sub ? H - r.height - 6 : Math.max(6, y - r.height);
    setPos({ x: Math.max(6, nx), y: Math.max(6, ny) });
  }, [x, y, sub, width]);
  useEffect(() => {
    if (autoFocus) ref.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const top = (k: number) => 5 + items.slice(0, k).reduce((h, it) => h + rowH(it, big), 0);
  const move = (dir: 1 | -1) => {
    for (let s = 1; s <= items.length; s++) {
      const i = (((hl < 0 ? (dir === 1 ? -1 : 0) : hl) + dir * s) % items.length + items.length) % items.length;
      if (pickable(items[i])) {
        setHl(i);
        const it = items[i] as Item;
        onHover?.(it.id);
        return;
      }
    }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (open !== null) return; // the submenu has the keys
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      move(e.key === 'ArrowDown' ? 1 : -1);
    } else if (e.key === 'ArrowRight' && hl >= 0 && (items[hl] as Item).submenu) {
      e.preventDefault();
      e.stopPropagation();
      setOpen(hl);
    } else if (e.key === 'ArrowLeft' && onBack) {
      e.preventDefault();
      e.stopPropagation();
      onBack();
    } else if (e.key === 'Enter' && hl >= 0) {
      e.preventDefault();
      e.stopPropagation();
      const it = items[hl] as Item;
      if (it.submenu) setOpen(hl);
      else onPick(it);
    }
  };

  return (
    <>
      <div
        ref={ref}
        className={`p3-menu${big ? ' big' : ''}`}
        role="menu"
        tabIndex={-1}
        style={{ left: pos.x, top: pos.y, ...(width ? { width, minWidth: 0 } : {}) }}
        onKeyDown={onKey}
        onMouseLeave={() => {
          if (open === null) {
            setHl(-1);
            onHover?.(null);
          }
        }}
      >
        {items.map((it, i) =>
          it.type === 'separator' ? (
            <div key={`s${i}`} className="sep" role="separator" />
          ) : (
            <button
              key={it.id}
              type="button"
              role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'}
              aria-checked={it.checked}
              aria-haspopup={it.submenu ? 'menu' : undefined}
              tabIndex={-1}
              disabled={it.disabled || it.head}
              className={`it${i === hl || i === open ? ' hl' : ''}${it.head ? ' head' : ''}`}
              onMouseEnter={() => {
                if (!pickable(it)) return;
                setHl(i);
                onHover?.(it.id);
                setOpen(it.submenu ? i : null);
              }}
              onClick={(e) => {
                e.stopPropagation();
                if (!pickable(it)) return;
                if (it.submenu) setOpen(i);
                else onPick(it);
              }}
            >
              <span className="lab">
                {!it.head && <span className="chk">{it.checked ? '✓' : ''}</span>}
                {it.picture}
                {it.label}
              </span>
              {(it.hint || it.submenu) && <span className="k">{it.submenu ? '›' : it.hint}</span>}
            </button>
          ),
        )}
      </div>
      {open !== null && (items[open] as Item).submenu && (
        <Panel
          items={(items[open] as Item).submenu!}
          x={pos.x + (ref.current?.offsetWidth ?? 200) + 3}
          y={pos.y + top(open) - 5}
          big={false}
          sub
          width={ref.current?.offsetWidth}
          onPick={onPick}
          onHover={onHover}
          autoFocus
          onBack={() => {
            setOpen(null);
            ref.current?.focus({ preventScroll: true });
          }}
        />
      )}
    </>
  );
}

/** The open menu, or nothing. The owner keeps the spec in state and clears it in onClose. */
export function PopupMenu({ spec, onClose }: { spec: MenuSpec | null; onClose: () => void }) {
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = () => {
    spec?.onHover?.(null);
    spec?.onClose?.();
    onClose();
  };
  useEffect(() => {
    if (!spec) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      close.current();
    };
    const onBlur = () => close.current();
    window.addEventListener('mousedown', onDown, true);
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('blur', onBlur);
    window.addEventListener('resize', onBlur);
    return () => {
      window.removeEventListener('mousedown', onDown, true);
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', onBlur);
    };
  }, [spec]);
  if (!spec) return null;
  const big = !!spec.big;
  // A pop-up button's menu sits over the button with the chosen row on it.
  let y = spec.y;
  if (spec.overItem) {
    const i = spec.items.findIndex((it) => it.type !== 'separator' && it.id === spec.overItem);
    if (i >= 0) y -= 5 + spec.items.slice(0, i).reduce((h, it) => h + rowH(it, big), 0) + rowH(spec.items[i], big) / 2;
  }
  return (
    <div ref={rootRef} className="p3-menu-root">
      <Panel
        items={spec.items}
        x={spec.x}
        y={y}
        big={big}
        width={spec.width}
        onPick={(it) => {
          close.current();
          it.run?.();
        }}
        onHover={spec.onHover}
        autoFocus
      />
    </div>
  );
}
