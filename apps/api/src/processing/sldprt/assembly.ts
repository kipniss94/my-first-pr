/**
 * Where every part of a SolidWorks assembly goes.
 *
 * An assembly does not contain its parts' geometry, but it does keep an exact
 * record of where each one is: `swXmlContents/COMPINSTANCETREE`, an XML
 * document SolidWorks writes on every save. It lists
 *
 *  - every file the assembly uses, at any depth (`swFile`, with the path it was
 *    saved from);
 *  - every file-and-configuration pair (`swModel`), and for each assembly among
 *    them its component instances (`swReference`): name, instance number,
 *    whether suppressed or hidden, and the transform placing it in its parent.
 *
 * The transform is sixteen numbers, a 4×4 matrix whose rows are the images of
 * the X, Y and Z axes and then the translation, in metres — which is exactly
 * the column-major order three.js reads. A part's place in the top-level
 * assembly is the product of the transforms down its path.
 *
 * Components saved inside the assembly (virtual components) keep their own
 * documents under `VirtualComp/<name>`, nested the same way the tree is: a
 * virtual sub-assembly's document has the `VirtualComp/…` of its own children.
 * Older files store the tree zlib-wrapped as `COMPINSTANCETREE__ZLB`.
 */

import { XMLParser } from 'fast-xml-parser';
import { readCompoundFile } from '../cfb.js';
import { readPackage, unwrapCodec, type PackageEntry } from './container.js';

export interface AssemblyInstance {
  /** File name of the part, as the assembly refers to it. */
  component: string;
  configuration: string;
  /** Instance names from the top of the tree down, e.g. `["Frame-1", "Bolt-3"]`. */
  path: string[];
  /** Placement in the top-level assembly: 4×4, column-major, millimetres. */
  matrix: number[];
  /** The document of a component saved inside the assembly, when it is one. */
  embedded: PackageEntry[] | null;
}

export interface AssemblyTree {
  instances: AssemblyInstance[];
  suppressed: number;
  hidden: number;
  /** Sub-assemblies the tree names but does not open up. */
  unexpanded: string[];
}

/** The named entries of a SolidWorks document, whichever container holds them. */
export function documentEntries(buffer: Buffer): PackageEntry[] {
  const cfb = readCompoundFile(buffer);
  if (!cfb) return readPackage(buffer);
  return cfb.entries
    .filter((entry) => entry.type === 2)
    .map((entry) => ({ name: entry.path, offset: entry.startSector, data: cfb.read(entry) }));
}

interface Reference {
  name: string;
  number: string;
  configuration: string;
  suppressed: boolean;
  hidden: boolean;
  virtual: boolean;
  modelRef: string;
  transform: number[];
}

interface Model {
  fileRef: string;
  references: Reference[];
}

type XmlNode = Record<string, unknown>;

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const MAX_DEPTH = 64;
const MAX_INSTANCES = 200_000;

/** a · b, both column-major 4×4. */
function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row] * b[column * 4 + k];
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function parseTransform(value: unknown): number[] {
  const numbers = String(value ?? '')
    .trim()
    .split(/\s+/)
    .map(Number);
  return numbers.length === 16 && numbers.every(Number.isFinite) ? numbers : IDENTITY;
}

const asList = (value: unknown): XmlNode[] => (Array.isArray(value) ? value : value ? [value] : []) as XmlNode[];
const baseName = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** The tree's XML, plain or zlib-wrapped. */
function treeXml(entries: PackageEntry[]): string | null {
  const entry = entries.find((e) => /(^|\/)swXmlContents\/COMPINSTANCETREE(__ZLB)?$/.test(e.name));
  if (!entry) return null;
  const data = /__ZLB$/.test(entry.name) ? unwrapCodec(entry.data) : entry.data;
  return data ? data.toString('utf8') : null;
}

/** The document of a component saved inside `entries` under `VirtualComp/<name>`. */
function embeddedDocument(entries: PackageEntry[], name: string): PackageEntry[] | null {
  const prefix = `VirtualComp/${name}`;
  const whole = entries.find((entry) => entry.name === prefix);
  if (whole) {
    // A whole document of its own — only when it is not one is it looked at
    // as codec-wrapped, since a document's own entries carry that wrapping too.
    let inner = documentEntries(whole.data);
    if (inner.length === 0) {
      const unwrapped = unwrapCodec(whole.data);
      if (unwrapped) inner = documentEntries(unwrapped);
    }
    return inner.length > 0 ? inner : null;
  }
  // In a compound file the component is a storage of its own streams.
  const nested = entries
    .filter((entry) => entry.name.startsWith(`${prefix}/`))
    .map((entry) => ({ ...entry, name: entry.name.slice(prefix.length + 1) }));
  return nested.length > 0 ? nested : null;
}

export function readAssemblyTree(entries: PackageEntry[]): AssemblyTree | null {
  const xml = treeXml(entries);
  if (!xml) return null;
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '',
    isArray: (name) => ['swFile', 'swModel', 'swReference', 'swConfiguration'].includes(name),
  });
  let document: XmlNode;
  try {
    document = (parser.parse(xml) as XmlNode).swSolidWorks as XmlNode;
  } catch {
    return null;
  }
  if (!document) return null;

  const files = new Map<string, { path: string; type: string }>();
  for (const file of asList((document.swHeader as XmlNode | undefined)?.swFile)) {
    files.set(String(file.id), { path: String(file.swPath ?? ''), type: String(file.swDocType ?? '') });
  }
  const models = new Map<string, Model>();
  for (const model of asList((document.swModelList as XmlNode | undefined)?.swModel)) {
    models.set(String(model.id), {
      fileRef: String(model.swFileRef ?? ''),
      references: asList(model.swReference).map((reference) => ({
        name: String(reference.swName ?? ''),
        number: String(reference.swReferenceNumber ?? ''),
        configuration: String(reference.swConfigurationName ?? ''),
        suppressed: reference.swSuppressed === 'YES',
        hidden: reference.swHidden === 'YES',
        virtual: reference.swIsVirtualComponent === 'YES',
        modelRef: String(reference.swModelRef ?? ''),
        transform: parseTransform(reference.swTransform),
      })),
    });
  }

  // The top-level assembly as last opened: its most recent configuration.
  const configurations = asList((document.swConfigurationList as XmlNode | undefined)?.swConfiguration);
  const current = configurations.find((c) => c.swMostRecentConfiguration === 'YES') ?? configurations[0];
  const firstFile = asList((document.swHeader as XmlNode | undefined)?.swFile)[0];
  const root =
    (current && models.get(String(current.swModelRef))) ??
    [...models.values()].find((model) => model.fileRef === String(firstFile?.id));
  if (!root) return null;

  const tree: AssemblyTree = { instances: [], suppressed: 0, hidden: 0, unexpanded: [] };
  const expand = (model: Model, matrix: number[], path: string[], document: PackageEntry[] | null, depth: number) => {
    for (const reference of model.references) {
      if (tree.instances.length >= MAX_INSTANCES) return;
      if (reference.suppressed) {
        tree.suppressed += 1;
        continue;
      }
      if (reference.hidden) {
        tree.hidden += 1;
        continue;
      }
      const child = models.get(reference.modelRef);
      const file = child ? files.get(child.fileRef) : undefined;
      if (!child || !file) continue;
      const placed = multiply(matrix, reference.transform);
      // A virtual component is named `Name^Parent`; its document is `Name`.
      const shortName = reference.name.split('^')[0];
      const name = `${shortName}-${reference.number}`;
      const embedded = reference.virtual && document ? embeddedDocument(document, shortName) : null;
      if (file.type === 'ASSEMBLY') {
        if (child.references.length > 0 && depth < MAX_DEPTH) expand(child, placed, [...path, name], embedded, depth + 1);
        else tree.unexpanded.push(baseName(file.path));
        continue;
      }
      const inMillimetres = [...placed];
      for (const i of [12, 13, 14]) inMillimetres[i] *= 1000;
      tree.instances.push({
        component: baseName(file.path),
        configuration: reference.configuration,
        path: [...path, name],
        matrix: inMillimetres,
        embedded: reference.virtual ? embedded : null,
      });
    }
  };
  expand(root, IDENTITY, [], entries, 0);
  return tree;
}
