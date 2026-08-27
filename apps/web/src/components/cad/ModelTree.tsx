'use client';

import { useMemo, useState } from 'react';
import type { CadModel, CadTreeNode } from '@/lib/cad/types';

interface ModelTreeProps {
  model: CadModel;
  selectedPartId: string | null;
  hiddenParts: ReadonlySet<string>;
  onSelect(partId: string | null): void;
  onToggleVisibility(partIds: string[], visible: boolean): void;
  onIsolate(partIds: string[]): void;
}

/**
 * The assembly tree.
 *
 * Nodes come from the STEP product structure or, for mesh formats, from the
 * object hierarchy the loader produced. Nodes that carry no geometry anywhere
 * below them are dropped — an empty branch is noise, not information.
 */
export function ModelTree({
  model,
  selectedPartId,
  hiddenParts,
  onSelect,
  onToggleVisibility,
  onIsolate,
}: ModelTreeProps) {
  const nodesById = useMemo(() => new Map(model.nodes.map((node) => [node.id, node])), [model.nodes]);

  /** All part ids at or below a node. */
  const partsUnder = useMemo(() => {
    const cache = new Map<string, string[]>();
    const collect = (id: string, depth = 0): string[] => {
      const cached = cache.get(id);
      if (cached) return cached;
      const node = nodesById.get(id);
      if (!node || depth > 128) return [];
      const result = [...node.partIds];
      for (const childId of node.childIds) result.push(...collect(childId, depth + 1));
      cache.set(id, result);
      return result;
    };
    for (const node of model.nodes) collect(node.id);
    return cache;
  }, [model.nodes, nodesById]);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    // Open the first two levels: enough to see the structure, not a wall of rows.
    const open = new Set<string>();
    for (const node of model.nodes) {
      if (node.depth < 2) open.add(node.id);
    }
    return open;
  });

  const visibleRoots = model.rootIds.filter((id) => (partsUnder.get(id)?.length ?? 0) > 0);
  const roots = visibleRoots.length > 0 ? visibleRoots : model.rootIds;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="field-label">Model tree</h2>
        <button
          type="button"
          className="btn-icon"
          title="Show every component"
          aria-label="Show every component"
          onClick={() => onIsolate([])}
        >
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
            <path d="M2.5 10s2.8-4.5 7.5-4.5S17.5 10 17.5 10s-2.8 4.5-7.5 4.5S2.5 10 2.5 10Z" />
            <circle cx="10" cy="10" r="1.9" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto py-1" data-testid="model-tree">
        <ul role="tree" aria-label="Model components" className="text-[13px]">
          {roots.map((rootId) => (
            <TreeRow
              key={rootId}
              nodeId={rootId}
              nodesById={nodesById}
              partsUnder={partsUnder}
              model={model}
              expanded={expanded}
              setExpanded={setExpanded}
              selectedPartId={selectedPartId}
              hiddenParts={hiddenParts}
              onSelect={onSelect}
              onToggleVisibility={onToggleVisibility}
              onIsolate={onIsolate}
            />
          ))}
        </ul>
      </div>

      <div className="border-t border-line px-3 py-2 text-[11px] text-mist-500">
        {model.stats.parts} part{model.stats.parts === 1 ? '' : 's'} ·{' '}
        {model.stats.triangles.toLocaleString('en-US')} triangles
      </div>
    </div>
  );
}

interface TreeRowProps extends Omit<ModelTreeProps, 'model'> {
  nodeId: string;
  nodesById: Map<string, CadTreeNode>;
  partsUnder: Map<string, string[]>;
  model: CadModel;
  expanded: Set<string>;
  setExpanded(update: (previous: Set<string>) => Set<string>): void;
}

function TreeRow(props: TreeRowProps) {
  const { nodeId, nodesById, partsUnder, expanded, setExpanded, selectedPartId, hiddenParts, model } = props;
  const node = nodesById.get(nodeId);
  if (!node) return null;

  const parts = partsUnder.get(nodeId) ?? [];
  if (parts.length === 0) return null;

  const childNodes = node.childIds.filter((id) => (partsUnder.get(id)?.length ?? 0) > 0);
  /*
   * A node holding a single part and nothing else *is* that part, so it gets one
   * row instead of a folder wrapping a single leaf. Nodes holding several parts
   * list them, which is what turns a STEP product into a usable assembly tree.
   */
  const ownParts = node.partIds;
  const inlineParts = childNodes.length === 0 && ownParts.length === 1 ? [] : ownParts;
  const isLeaf = childNodes.length === 0 && inlineParts.length === 0;
  const isOpen = expanded.has(nodeId);
  const representedPart = inlineParts.length === 0 ? ownParts[0] ?? null : null;
  const isSelected = representedPart !== null && representedPart === selectedPartId;
  const allHidden = parts.every((partId) => hiddenParts.has(partId));

  const toggle = () =>
    setExpanded((previous) => {
      const next = new Set(previous);
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });

  return (
    <li role="treeitem" aria-expanded={isLeaf ? undefined : isOpen} aria-selected={isSelected}>
      <TreeRowBody
        name={node.name}
        depth={node.depth}
        isLeaf={isLeaf}
        isOpen={isOpen}
        isSelected={isSelected}
        allHidden={allHidden}
        onToggle={toggle}
        onSelect={() => props.onSelect(representedPart ?? parts[0] ?? null)}
        onIsolate={() => props.onIsolate(parts)}
        onToggleVisibility={() => props.onToggleVisibility(parts, allHidden)}
      />

      {!isLeaf && isOpen && (
        <ul role="group">
          {childNodes.map((childId) => (
            <TreeRow key={childId} {...props} nodeId={childId} />
          ))}
          {inlineParts.map((partId) => {
            const part = model.parts.find((candidate) => candidate.id === partId);
            if (!part) return null;
            const hidden = hiddenParts.has(partId);
            return (
              <li key={partId} role="treeitem" aria-selected={selectedPartId === partId}>
                <TreeRowBody
                  name={part.name}
                  depth={node.depth + 1}
                  isLeaf
                  isOpen={false}
                  isSelected={selectedPartId === partId}
                  allHidden={hidden}
                  onToggle={() => undefined}
                  onSelect={() => props.onSelect(partId)}
                  onIsolate={() => props.onIsolate([partId])}
                  onToggleVisibility={() => props.onToggleVisibility([partId], hidden)}
                />
              </li>
            );
          })}
        </ul>
      )}
    </li>
  );
}

interface TreeRowBodyProps {
  name: string;
  depth: number;
  isLeaf: boolean;
  isOpen: boolean;
  isSelected: boolean;
  allHidden: boolean;
  onToggle(): void;
  onSelect(): void;
  onIsolate(): void;
  onToggleVisibility(): void;
}

/** One row of the tree, shared by component nodes and part leaves. */
function TreeRowBody({
  name,
  depth,
  isLeaf,
  isOpen,
  isSelected,
  allHidden,
  onToggle,
  onSelect,
  onIsolate,
  onToggleVisibility,
}: TreeRowBodyProps) {
  return (
    <div
      className={`group flex items-center gap-1 rounded-md px-1 py-[3px] transition-colors ${
        isSelected ? 'bg-accent-soft/70 text-mist-100' : 'hover:bg-ink-800'
      }`}
      style={{ paddingLeft: `${depth * 12 + 4}px` }}
    >
      {isLeaf ? (
        <span className="w-4 shrink-0" />
      ) : (
        <button
          type="button"
          onClick={onToggle}
          className="grid h-4 w-4 shrink-0 place-items-center rounded text-mist-400 hover:text-mist-100"
          aria-label={isOpen ? `Collapse ${name}` : `Expand ${name}`}
        >
          <svg viewBox="0 0 12 12" className={`h-3 w-3 transition-transform ${isOpen ? 'rotate-90' : ''}`} aria-hidden="true">
            <path d="M4.5 2.5 8 6l-3.5 3.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      )}

      <button
        type="button"
        onClick={onSelect}
        onDoubleClick={onIsolate}
        className={`min-w-0 flex-1 truncate text-left ${allHidden ? 'text-mist-500 line-through' : 'text-mist-200'}`}
        title={`${name} — double-click to isolate`}
      >
        {name}
      </button>

      <span className="hidden shrink-0 items-center gap-0.5 group-hover:flex">
        <button
          type="button"
          className="btn-icon !p-1"
          title={allHidden ? 'Show' : 'Hide'}
          aria-label={allHidden ? `Show ${name}` : `Hide ${name}`}
          onClick={onToggleVisibility}
        >
          {allHidden ? (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M2 8s2.3-3.6 6-3.6S14 8 14 8s-2.3 3.6-6 3.6S2 8 2 8Z" />
              <path d="M3 13 13 3" strokeLinecap="round" />
            </svg>
          ) : (
            <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <path d="M2 8s2.3-3.6 6-3.6S14 8 14 8s-2.3 3.6-6 3.6S2 8 2 8Z" />
              <circle cx="8" cy="8" r="1.5" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="btn-icon !p-1"
          title="Isolate"
          aria-label={`Isolate ${name}`}
          onClick={onIsolate}
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
            <rect x="3" y="3" width="10" height="10" rx="1.5" />
            <path d="M6.5 8h3M8 6.5v3" strokeLinecap="round" />
          </svg>
        </button>
      </span>
    </div>
  );
}
