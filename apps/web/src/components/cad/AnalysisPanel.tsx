'use client';

import { formatAngle, formatLength } from '@/lib/format';
import type { CadModel, MeasurementRecord, SectionState, ToolMode } from '@/lib/cad/types';
import { PanelSection, Row } from './PropertiesPanel';

interface AnalysisPanelProps {
  model: CadModel;
  tool: ToolMode;
  pendingPoints: number;
  measurements: MeasurementRecord[];
  section: SectionState;
  sectionCoordinate: number;
  boundingBoxVisible: boolean;
  boundingBoxScope: 'model' | 'selection';
  bounds: { size: { x: number; y: number; z: number }; diagonal: number };
  onToolChange(tool: ToolMode): void;
  onSectionChange(patch: Partial<SectionState>): void;
  onBoundingBoxToggle(visible: boolean): void;
  onBoundingBoxScope(scope: 'model' | 'selection'): void;
  onRemoveMeasurement(id: string): void;
  onClearMeasurements(): void;
  hasSelection: boolean;
}

const TOOL_HELP: Record<ToolMode, string> = {
  select: 'Click a part to select it. On STEP and IGES models the individual B-Rep face you click is highlighted too.',
  'measure-distance': 'Click two points. Clicks snap to the nearest vertex when one is close.',
  'measure-length': 'Click on a model edge to measure its full straight length.',
  'measure-angle': 'Click three points: the second one is the corner.',
};

export function AnalysisPanel(props: AnalysisPanelProps) {
  const { model, tool, section, measurements } = props;

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="analysis-panel">
      <PanelSection title="Measure">
        <div className="grid grid-cols-2 gap-1.5">
          <ToolButton label="Select" active={tool === 'select'} onClick={() => props.onToolChange('select')} />
          <ToolButton
            label="Distance"
            active={tool === 'measure-distance'}
            onClick={() => props.onToolChange('measure-distance')}
          />
          <ToolButton
            label="Edge length"
            active={tool === 'measure-length'}
            onClick={() => props.onToolChange('measure-length')}
          />
          <ToolButton label="Angle" active={tool === 'measure-angle'} onClick={() => props.onToolChange('measure-angle')} />
        </div>
        <p className="pt-2 text-[12px] leading-relaxed text-mist-400">{TOOL_HELP[tool]}</p>
        {tool !== 'select' && props.pendingPoints > 0 && (
          <p className="pt-1 font-mono text-[12px] text-measure">
            {props.pendingPoints} point{props.pendingPoints === 1 ? '' : 's'} picked
          </p>
        )}
      </PanelSection>

      <PanelSection title="Bounding box">
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">Show</span>
          <Switch checked={props.boundingBoxVisible} onChange={props.onBoundingBoxToggle} label="Show bounding box" />
        </label>
        <div className="flex gap-1.5 py-1">
          <ToolButton
            label="Whole model"
            active={props.boundingBoxScope === 'model'}
            onClick={() => props.onBoundingBoxScope('model')}
          />
          <ToolButton
            label="Selection"
            active={props.boundingBoxScope === 'selection'}
            disabled={!props.hasSelection}
            onClick={() => props.onBoundingBoxScope('selection')}
          />
        </div>
        <Row label="X" value={formatLength(props.bounds.size.x, model.units)} />
        <Row label="Y" value={formatLength(props.bounds.size.y, model.units)} />
        <Row label="Z" value={formatLength(props.bounds.size.z, model.units)} />
        <Row label="Diagonal" value={formatLength(props.bounds.diagonal, model.units)} />
      </PanelSection>

      <PanelSection title="Section plane">
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">Enabled</span>
          <Switch
            checked={section.enabled}
            onChange={(enabled) => props.onSectionChange({ enabled })}
            label="Enable section plane"
            testId="section-toggle"
          />
        </label>

        <div className="grid grid-cols-3 gap-1.5 py-1">
          {(['x', 'y', 'z'] as const).map((axis) => (
            <ToolButton
              key={axis}
              label={axis.toUpperCase()}
              active={section.axis === axis}
              disabled={!section.enabled}
              onClick={() => props.onSectionChange({ axis })}
            />
          ))}
        </div>

        <div className="py-1.5">
          <div className="flex items-baseline justify-between">
            <span className="kv-key">Position</span>
            <span className="kv-value">{formatLength(props.sectionCoordinate, model.units)}</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.002}
            value={section.position}
            disabled={!section.enabled}
            onChange={(event) => props.onSectionChange({ position: Number(event.target.value) })}
            className="mt-2 w-full accent-accent disabled:opacity-40"
            aria-label="Section plane position"
            data-testid="section-position"
          />
        </div>

        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">Flip direction</span>
          <Switch
            checked={section.flipped}
            disabled={!section.enabled}
            onChange={(flipped) => props.onSectionChange({ flipped })}
            label="Flip section direction"
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">Cap cut surface</span>
          <Switch
            checked={section.showCap}
            disabled={!section.enabled}
            onChange={(showCap) => props.onSectionChange({ showCap })}
            label="Cap the cut surface"
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">Hatch</span>
          <Switch
            checked={section.hatch}
            disabled={!section.enabled || !section.showCap}
            onChange={(hatch) => props.onSectionChange({ hatch })}
            label="Hatch the cut surface"
          />
        </label>
        <p className="pt-1.5 text-[12px] leading-relaxed text-mist-500">
          The cap is computed from the solid itself, so hollow parts stay hollow in the cut.
        </p>
      </PanelSection>

      <PanelSection title={`Measurements${measurements.length > 0 ? ` (${measurements.length})` : ''}`}>
        {measurements.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-mist-500">
            Nothing measured yet. Pick a measure tool above and click in the 3D view.
          </p>
        ) : (
          <>
            <ul className="space-y-2" data-testid="measurement-list">
              {measurements.map((measurement) => (
                <li key={measurement.id} className="rounded-lg border border-line bg-ink-800 px-2.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] text-mist-400">{measurement.label}</span>
                    <button
                      type="button"
                      className="btn-icon !p-1"
                      onClick={() => props.onRemoveMeasurement(measurement.id)}
                      aria-label={`Remove ${measurement.label}`}
                    >
                      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  <p className="font-mono text-[15px] font-medium tabular-nums text-measure">
                    {measurement.kind === 'angle'
                      ? formatAngle(measurement.value)
                      : formatLength(measurement.value, model.units)}
                  </p>
                  {measurement.detail.length > 0 && (
                    <dl className="mt-1.5 grid grid-cols-3 gap-x-2">
                      {measurement.detail.map((entry) => (
                        <div key={entry.key}>
                          <dt className="text-[10px] uppercase tracking-wider text-mist-500">{entry.key}</dt>
                          <dd className="font-mono text-[11px] tabular-nums text-mist-300">{entry.value}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </li>
              ))}
            </ul>
            <button type="button" onClick={props.onClearMeasurements} className="btn btn-ghost mt-3 w-full">
              Clear all
            </button>
          </>
        )}
      </PanelSection>
    </div>
  );
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick(): void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-2 py-1.5 text-[12px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        active
          ? 'border-accent/50 bg-accent-soft text-accent-bright'
          : 'border-line bg-ink-800 text-mist-300 hover:bg-ink-700 hover:text-mist-100'
      }`}
    >
      {label}
    </button>
  );
}

function Switch({
  checked,
  onChange,
  label,
  disabled,
  testId,
}: {
  checked: boolean;
  onChange(value: boolean): void;
  label: string;
  disabled?: boolean;
  testId?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      data-testid={testId}
      onClick={() => onChange(!checked)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-40 ${
        checked ? 'bg-accent' : 'bg-ink-600'
      }`}
    >
      <span
        className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
