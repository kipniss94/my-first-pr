'use client';

import { decimal, formatArea, formatCount, formatLength, formatVolume, unitLabel } from '@/lib/format';
import { useT } from '@/lib/prefs';
import type { CadModel, PartProperties } from '@/lib/cad/types';

interface PropertiesPanelProps {
  model: CadModel;
  properties: PartProperties | null;
  faceIndex: number | null;
  faceCount: number | null;
  /** Set when the part is too dense to measure without being asked. */
  needsCompute: boolean;
  onCompute(): void;
}

/**
 * Object properties.
 *
 * Anything the file does not carry is shown as `N/A`. Volume is marked
 * approximate when the mesh is not closed, because a signed-volume integral
 * over an open surface is a number, just not a trustworthy one.
 */
export function PropertiesPanel({
  model,
  properties,
  faceIndex,
  faceCount,
  needsCompute,
  onCompute,
}: PropertiesPanelProps) {
  const { t } = useT();
  if (!properties) {
    return (
      <div className="flex h-full flex-col">
        <PanelSection title={t('Document')}>
          <Row label={t('Parts')} value={formatCount(model.stats.parts)} />
          <Row label={t('Triangles')} value={formatCount(model.stats.triangles)} />
          <Row label={t('Vertices')} value={formatCount(model.stats.vertices)} />
          <Row label={t('Units')} value={unitLabel(model.units)} />
          <Row label={t('Prepared by')} value={model.producer} mono={false} />
        </PanelSection>
        <div className="px-3 py-6 text-center text-[13px] leading-relaxed text-mist-500">
          {t('Click a part in the 3D view or the model tree to see its properties.')}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="properties-panel">
      <PanelSection title={t('Object')}>
        <Row label={t('Name')} value={properties.name} mono={false} />
        <Row label={t('Type')} value={t(properties.type)} mono={false} />
        {faceCount !== null && (
          <Row
            label={t('Face')}
            value={
              faceIndex !== null
                ? t('{index} of {count}', { index: faceIndex + 1, count: formatCount(faceCount) })
                : t('{count} faces', { count: formatCount(faceCount) })
            }
            mono={false}
          />
        )}
      </PanelSection>

      <PanelSection title={t('Dimensions')}>
        <Row label="X" value={formatLength(properties.size.x, model.units)} />
        <Row label="Y" value={formatLength(properties.size.y, model.units)} />
        <Row label="Z" value={formatLength(properties.size.z, model.units)} />
      </PanelSection>

      <PanelSection title={t('Position')}>
        <Row label={t('Min')} value={vectorText(properties.min, model.units)} />
        <Row label={t('Max')} value={vectorText(properties.max, model.units)} />
      </PanelSection>

      <PanelSection title={t('Mass properties')}>
        {needsCompute ? (
          <div className="px-1 py-2">
            <p className="text-[13px] leading-relaxed text-mist-400">
              {t('This part has {count} triangles. Computing volume and area takes a moment.', {
                count: formatCount(properties.triangles),
              })}
            </p>
            <button type="button" onClick={onCompute} className="btn btn-subtle mt-2.5">
              {t('Compute anyway')}
            </button>
          </div>
        ) : (
          <>
            <Row
              label={t('Volume')}
              value={
                properties.volume === null
                  ? t('N/A')
                  : `${properties.volumeApproximate ? '≈ ' : ''}${formatVolume(properties.volume, model.units)}`
              }
            />
            <Row label={t('Surface area')} value={formatArea(properties.surfaceArea, model.units)} />
            {properties.volumeApproximate && properties.volume !== null && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-mist-500">
                {t('The mesh is not closed, so volume is an estimate.')}
              </p>
            )}
          </>
        )}
      </PanelSection>

      <PanelSection title={t('Geometry')}>
        <Row label={t('Triangles')} value={formatCount(properties.triangles)} />
        <Row label={t('Vertices')} value={formatCount(properties.vertices)} />
        <Row label={t('B-Rep faces')} value={properties.brepFaces === null ? t('N/A') : formatCount(properties.brepFaces)} />
      </PanelSection>

      <PanelSection title={t('Appearance')}>
        <Row label={t('Material')} value={properties.material ?? t('N/A')} mono={false} />
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="kv-key">{t('Colour')}</span>
          <span className="flex items-center gap-2">
            <span
              className="h-3.5 w-3.5 rounded border border-line-strong"
              style={{ backgroundColor: properties.color }}
              aria-hidden="true"
            />
            <span className="kv-value">{properties.color.toUpperCase()}</span>
          </span>
        </div>
      </PanelSection>
    </div>
  );
}

function vectorText(vector: { x: number; y: number; z: number }, unit: string): string {
  const round = (value: number) => (Math.abs(value) < 1000 ? value.toFixed(2) : value.toFixed(1));
  // With a decimal comma the coordinates are separated by semicolons instead.
  const comma = decimal('.') === ',';
  const parts = [vector.x, vector.y, vector.z].map((value) => decimal(round(value)));
  return `${parts.join(comma ? '; ' : ', ')} ${unitLabel(unit)}`;
}

export function PanelSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="border-b border-line px-3 py-3 last:border-0">
      <h3 className="field-label">{title}</h3>
      <div className="mt-2 space-y-1">{children}</div>
    </section>
  );
}

export function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="kv-key shrink-0">{label}</span>
      <span
        className={`min-w-0 truncate text-right ${mono ? 'kv-value' : 'text-[13px] text-mist-100'}`}
        title={value}
      >
        {value}
      </span>
    </div>
  );
}
