'use client';

import { formatAngle, formatArea, formatLength } from '@/lib/format';
import { useT } from '@/lib/prefs';
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
  measure:
    'Click one or two faces, edges or vertices. Space or the wheel over the dimension switches its variant; Enter keeps it.',
  'measure-distance': 'Click two points. Clicks snap to the nearest vertex when one is close.',
  'measure-angle': 'Click three points: the second one is the corner.',
};

/** A kept dimension's value as a drawing writes it. */
function valueText(measurement: MeasurementRecord, units: string): string {
  switch (measurement.kind) {
    case 'angle':
      return formatAngle(measurement.value);
    case 'diameter':
      return `Ø ${formatLength(measurement.value, units)}`;
    case 'radius':
      return `R ${formatLength(measurement.value, units)}`;
    case 'area':
      return formatArea(measurement.value, units);
    case 'coords':
      return measurement.detail.map((entry) => `${entry.key} ${entry.value}`).join('  ');
    default:
      return formatLength(measurement.value, units);
  }
}

export function AnalysisPanel(props: AnalysisPanelProps) {
  const { model, tool, section, measurements } = props;
  const { t } = useT();

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="analysis-panel">
      <PanelSection title={t('Measure')}>
        <div className="grid grid-cols-2 gap-1.5">
          <ToolButton label={t('Select')} active={tool === 'select'} onClick={() => props.onToolChange('select')} />
          <ToolButton label={t('Dimension')} active={tool === 'measure'} onClick={() => props.onToolChange('measure')} />
          <ToolButton
            label={t('Two points')}
            active={tool === 'measure-distance'}
            onClick={() => props.onToolChange('measure-distance')}
          />
          <ToolButton label={t('Three-point angle')} active={tool === 'measure-angle'} onClick={() => props.onToolChange('measure-angle')} />
        </div>
        <p className="pt-2 text-[12px] leading-relaxed text-mist-400">{t(TOOL_HELP[tool])}</p>
        {(tool === 'measure-distance' || tool === 'measure-angle') && props.pendingPoints > 0 && (
          <p className="pt-1 font-mono text-[12px] text-measure">
            {t('Points picked: {n}', { n: props.pendingPoints })}
          </p>
        )}
      </PanelSection>

      <PanelSection title={t('Bounding box')}>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">{t('Show')}</span>
          <Switch checked={props.boundingBoxVisible} onChange={props.onBoundingBoxToggle} label={t('Show bounding box')} />
        </label>
        <div className="flex gap-1.5 py-1">
          <ToolButton
            label={t('Whole model')}
            active={props.boundingBoxScope === 'model'}
            onClick={() => props.onBoundingBoxScope('model')}
          />
          <ToolButton
            label={t('Selection')}
            active={props.boundingBoxScope === 'selection'}
            disabled={!props.hasSelection}
            onClick={() => props.onBoundingBoxScope('selection')}
          />
        </div>
        <Row label="X" value={formatLength(props.bounds.size.x, model.units)} />
        <Row label="Y" value={formatLength(props.bounds.size.y, model.units)} />
        <Row label="Z" value={formatLength(props.bounds.size.z, model.units)} />
        <Row label={t('Diagonal')} value={formatLength(props.bounds.diagonal, model.units)} />
      </PanelSection>

      <PanelSection title={t('Section plane')}>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">{t('Enabled')}</span>
          <Switch
            checked={section.enabled}
            onChange={(enabled) => props.onSectionChange({ enabled })}
            label={t('Enable section plane')}
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
            <span className="kv-key">{t('Position')}</span>
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
            aria-label={t('Section plane position')}
            data-testid="section-position"
          />
        </div>

        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">{t('Flip direction')}</span>
          <Switch
            checked={section.flipped}
            disabled={!section.enabled}
            onChange={(flipped) => props.onSectionChange({ flipped })}
            label={t('Flip section direction')}
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">{t('Cap cut surface')}</span>
          <Switch
            checked={section.showCap}
            disabled={!section.enabled}
            onChange={(showCap) => props.onSectionChange({ showCap })}
            label={t('Cap the cut surface')}
          />
        </label>
        <label className="flex items-center justify-between gap-3 py-1">
          <span className="text-[13px] text-mist-200">{t('Hatch')}</span>
          <Switch
            checked={section.hatch}
            disabled={!section.enabled || !section.showCap}
            onChange={(hatch) => props.onSectionChange({ hatch })}
            label={t('Hatch the cut surface')}
          />
        </label>
        <p className="pt-1.5 text-[12px] leading-relaxed text-mist-500">
          {t('The cap is computed from the solid itself, so hollow parts stay hollow in the cut.')}
        </p>
      </PanelSection>

      <PanelSection title={`${t('Measurements')}${measurements.length > 0 ? ` (${measurements.length})` : ''}`}>
        {measurements.length === 0 ? (
          <p className="text-[13px] leading-relaxed text-mist-500">
            {t('Nothing measured yet. Pick a measure tool above and click in the 3D view.')}
          </p>
        ) : (
          <>
            <ul className="space-y-2" data-testid="measurement-list">
              {measurements.map((measurement) => (
                <li key={measurement.id} className="rounded-lg border border-line bg-ink-800 px-2.5 py-2">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-[12px] text-mist-400">{t(measurement.label)}</span>
                    <button
                      type="button"
                      className="btn-icon !p-1"
                      onClick={() => props.onRemoveMeasurement(measurement.id)}
                      aria-label={t('Remove {name}', { name: t(measurement.label) })}
                    >
                      <svg viewBox="0 0 12 12" className="h-3 w-3" aria-hidden="true">
                        <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                      </svg>
                    </button>
                  </div>
                  <p className="font-mono text-[15px] font-medium tabular-nums text-measure">
                    {valueText(measurement, model.units)}
                  </p>
                  {measurement.kind !== 'coords' && measurement.detail.length > 0 && (
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
              {t('Clear all')}
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
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white transition-transform ${
          checked ? 'translate-x-[18px]' : 'translate-x-0.5'
        }`}
      />
    </button>
  );
}
