'use client';

import { formatArea, formatCount, formatLength, formatVolume } from '@/lib/format';
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
  if (!properties) {
    return (
      <div className="flex h-full flex-col">
        <PanelSection title="Document">
          <Row label="Parts" value={formatCount(model.stats.parts)} />
          <Row label="Triangles" value={formatCount(model.stats.triangles)} />
          <Row label="Vertices" value={formatCount(model.stats.vertices)} />
          <Row label="Units" value={model.units} />
          <Row label="Prepared by" value={model.producer} mono={false} />
        </PanelSection>
        <div className="px-3 py-6 text-center text-[13px] leading-relaxed text-mist-500">
          Click a part in the 3D view or the model tree to see its properties.
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-auto" data-testid="properties-panel">
      <PanelSection title="Object">
        <Row label="Name" value={properties.name} mono={false} />
        <Row label="Type" value={properties.type} mono={false} />
        {faceCount !== null && (
          <Row
            label="Face"
            value={faceIndex !== null ? `${faceIndex + 1} of ${formatCount(faceCount)}` : `${formatCount(faceCount)} faces`}
            mono={false}
          />
        )}
      </PanelSection>

      <PanelSection title="Dimensions">
        <Row label="X" value={formatLength(properties.size.x, model.units)} />
        <Row label="Y" value={formatLength(properties.size.y, model.units)} />
        <Row label="Z" value={formatLength(properties.size.z, model.units)} />
      </PanelSection>

      <PanelSection title="Position">
        <Row label="Min" value={vectorText(properties.min, model.units)} />
        <Row label="Max" value={vectorText(properties.max, model.units)} />
      </PanelSection>

      <PanelSection title="Mass properties">
        {needsCompute ? (
          <div className="px-1 py-2">
            <p className="text-[13px] leading-relaxed text-mist-400">
              This part has {formatCount(properties.triangles)} triangles. Computing volume and area
              takes a moment.
            </p>
            <button type="button" onClick={onCompute} className="btn btn-subtle mt-2.5">
              Compute anyway
            </button>
          </div>
        ) : (
          <>
            <Row
              label="Volume"
              value={
                properties.volume === null
                  ? 'N/A'
                  : `${properties.volumeApproximate ? '≈ ' : ''}${formatVolume(properties.volume, model.units)}`
              }
            />
            <Row label="Surface area" value={formatArea(properties.surfaceArea, model.units)} />
            {properties.volumeApproximate && properties.volume !== null && (
              <p className="px-1 pt-1 text-[11px] leading-relaxed text-mist-500">
                The mesh is not closed, so volume is an estimate.
              </p>
            )}
          </>
        )}
      </PanelSection>

      <PanelSection title="Geometry">
        <Row label="Triangles" value={formatCount(properties.triangles)} />
        <Row label="Vertices" value={formatCount(properties.vertices)} />
        <Row label="B-Rep faces" value={properties.brepFaces === null ? 'N/A' : formatCount(properties.brepFaces)} />
      </PanelSection>

      <PanelSection title="Appearance">
        <Row label="Material" value={properties.material ?? 'N/A'} mono={false} />
        <div className="flex items-center justify-between gap-3 py-1">
          <span className="kv-key">Colour</span>
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
  return `${round(vector.x)}, ${round(vector.y)}, ${round(vector.z)} ${unit}`;
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
