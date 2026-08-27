'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DisplayMode, StandardView, ToolMode } from '@/lib/cad/types';

interface ViewerToolbarProps {
  tool: ToolMode;
  displayMode: DisplayMode;
  opacity: number;
  gridVisible: boolean;
  sectionEnabled: boolean;
  edgesUnavailable: boolean;
  fps: number | null;
  onToolChange(tool: ToolMode): void;
  onDisplayModeChange(mode: DisplayMode): void;
  onOpacityChange(value: number): void;
  onGridToggle(visible: boolean): void;
  onSectionToggle(enabled: boolean): void;
  onStandardView(view: StandardView): void;
  onFit(): void;
  onReset(): void;
  onSnapshot(): void;
}

const VIEWS: { id: StandardView; label: string; short: string }[] = [
  { id: 'front', label: 'Front', short: 'FR' },
  { id: 'back', label: 'Back', short: 'BK' },
  { id: 'left', label: 'Left', short: 'LF' },
  { id: 'right', label: 'Right', short: 'RT' },
  { id: 'top', label: 'Top', short: 'TP' },
  { id: 'bottom', label: 'Bottom', short: 'BT' },
  { id: 'iso', label: 'Isometric', short: 'ISO' },
];

/** The bottom command bar: tools on the left, camera on the right. */
export function ViewerToolbar(props: ViewerToolbarProps) {
  const [viewsOpen, setViewsOpen] = useState(false);
  const viewsRef = useRef<HTMLDivElement>(null);
  const viewsButtonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState<{ bottom: number; right: number } | null>(null);

  /*
   * The toolbar scrolls horizontally on narrow screens, and an `overflow`
   * ancestor clips absolutely positioned children — which silently swallowed
   * this menu. Positioning it against the viewport instead keeps it clickable
   * at every width.
   */
  useLayoutEffect(() => {
    if (!viewsOpen) {
      setMenuPosition(null);
      return;
    }
    const place = () => {
      const rect = viewsButtonRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPosition({
        bottom: Math.round(window.innerHeight - rect.top + 8),
        right: Math.round(window.innerWidth - rect.right),
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [viewsOpen]);

  useEffect(() => {
    if (!viewsOpen) return;
    const onDocumentClick = (event: MouseEvent) => {
      if (!viewsRef.current?.contains(event.target as Node)) setViewsOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setViewsOpen(false);
    };
    document.addEventListener('mousedown', onDocumentClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocumentClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [viewsOpen]);

  return (
    <div className="flex h-13 shrink-0 items-center gap-1 overflow-x-auto border-t border-line bg-ink-850 px-2 py-2">
      <Group label="Tools">
        <IconButton
          label="Select"
          active={props.tool === 'select'}
          onClick={() => props.onToolChange('select')}
          testId="tool-select"
        >
          <path d="M5 3.5 15 9.5l-4.3 1.1L9.6 15 5 3.5Z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
        </IconButton>
        <IconButton
          label="Measure distance"
          active={props.tool === 'measure-distance'}
          onClick={() => props.onToolChange('measure-distance')}
          testId="tool-distance"
        >
          <path d="M3.5 12.5 12.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          <circle cx="3.5" cy="12.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="12.5" cy="3.5" r="1.8" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </IconButton>
        <IconButton
          label="Measure edge length"
          active={props.tool === 'measure-length'}
          onClick={() => props.onToolChange('measure-length')}
          testId="tool-length"
        >
          <path d="M2.5 10.5h11M4.5 8.5v4M8 8.5v4M11.5 8.5v4" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
        </IconButton>
        <IconButton
          label="Measure angle"
          active={props.tool === 'measure-angle'}
          onClick={() => props.onToolChange('measure-angle')}
          testId="tool-angle"
        >
          <path d="M3 13h10L3 4v9Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M3 9.5a4.5 4.5 0 0 0 3.4 3.4" fill="none" stroke="currentColor" strokeWidth="1.2" />
        </IconButton>
      </Group>

      <Divider />

      <Group label="Section">
        <IconButton
          label="Section plane"
          active={props.sectionEnabled}
          onClick={() => props.onSectionToggle(!props.sectionEnabled)}
          testId="toolbar-section"
        >
          <path d="M2.5 5.5 8 2.5l5.5 3v5L8 13.5l-5.5-3v-5Z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
          <path d="M2.5 8h11" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" />
        </IconButton>
      </Group>

      <Divider />

      <Group label="Display">
        <Segmented
          value={props.displayMode}
          onChange={props.onDisplayModeChange}
          options={[
            { value: 'shaded', label: 'Shaded' },
            { value: 'shaded-edges', label: 'Edges' },
            { value: 'wireframe', label: 'Wire' },
          ]}
        />
        {props.edgesUnavailable && props.displayMode === 'shaded-edges' && (
          <span className="ml-1 whitespace-nowrap text-[11px] text-warn">Too dense for edges</span>
        )}
      </Group>

      <div className="hidden items-center gap-2 pl-2 md:flex">
        <span className="text-[11px] text-mist-500">Opacity</span>
        <input
          type="range"
          min={0.15}
          max={1}
          step={0.05}
          value={props.opacity}
          onChange={(event) => props.onOpacityChange(Number(event.target.value))}
          className="w-20 accent-accent"
          aria-label="Part opacity"
        />
      </div>

      <div className="ml-auto flex shrink-0 items-center gap-1">
        {props.fps !== null && props.fps > 0 && (
          <span className="mr-1 hidden font-mono text-[11px] tabular-nums text-mist-500 lg:inline" title="Frames per second">
            {props.fps} fps
          </span>
        )}

        <IconButton label="Toggle grid" active={props.gridVisible} onClick={() => props.onGridToggle(!props.gridVisible)}>
          <path d="M2.5 6h11M2.5 10h11M6 2.5v11M10 2.5v11" stroke="currentColor" strokeWidth="1.3" />
        </IconButton>

        <IconButton label="Save a PNG snapshot" onClick={props.onSnapshot}>
          <rect x="2.5" y="4.5" width="11" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.4" />
          <circle cx="8" cy="8.5" r="2.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
        </IconButton>

        <div className="relative" ref={viewsRef}>
          <button
            ref={viewsButtonRef}
            type="button"
            onClick={() => setViewsOpen((open) => !open)}
            className="btn btn-ghost"
            aria-expanded={viewsOpen}
            aria-haspopup="menu"
            data-testid="views-button"
          >
            Views
            <svg viewBox="0 0 12 12" className={`h-3 w-3 transition-transform ${viewsOpen ? 'rotate-180' : ''}`} aria-hidden="true">
              <path d="M3 4.5 6 7.5l3-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {viewsOpen && menuPosition && (
            <div
              role="menu"
              style={{ bottom: menuPosition.bottom, right: menuPosition.right }}
              className="fixed z-50 w-40 overflow-hidden rounded-lg border border-line bg-ink-800 py-1 shadow-2xl"
            >
              {VIEWS.map((view) => (
                <button
                  key={view.id}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    props.onStandardView(view.id);
                    setViewsOpen(false);
                  }}
                  data-testid={`view-${view.id}`}
                  className="flex w-full items-center justify-between px-3 py-1.5 text-left text-[13px] text-mist-200 hover:bg-ink-700"
                >
                  {view.label}
                  <span className="font-mono text-[10px] text-mist-500">{view.short}</span>
                </button>
              ))}
            </div>
          )}
        </div>

        <button type="button" onClick={props.onFit} className="btn btn-subtle" data-testid="fit-button">
          Fit
        </button>
        <button type="button" onClick={props.onReset} className="btn btn-ghost hidden sm:inline-flex">
          Reset
        </button>
      </div>
    </div>
  );
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5" role="group" aria-label={label}>
      {children}
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-6 w-px shrink-0 bg-line" aria-hidden="true" />;
}

function IconButton({
  label,
  active,
  onClick,
  children,
  testId,
}: {
  label: string;
  active?: boolean;
  onClick(): void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <button type="button" className="btn-icon" data-active={active ? 'true' : undefined} onClick={onClick} title={label} aria-label={label} aria-pressed={active} data-testid={testId}>
      <svg viewBox="0 0 16 16" className="h-[18px] w-[18px]" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

function Segmented<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange(value: T): void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="flex shrink-0 items-center rounded-lg border border-line bg-ink-800 p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-testid={`display-${option.value}`}
          className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
            value === option.value ? 'bg-ink-600 text-mist-100' : 'text-mist-400 hover:text-mist-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
