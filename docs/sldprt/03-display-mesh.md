# Phase 3 — every part in 3D, with no CAD

**Status: 132 of 132 real parts open in the browser as closed 3D meshes, read
from the file alone. No SolidWorks, no converter, no geometry kernel.**

---

## 1. Correction: there is no codec

Phases 1 and 2 reported that about a third of the parts kept their model
"behind a codec we cannot open", and at one point called it probable
encryption. **That was wrong.** It came from how the files were read, not from
the files.

The entry records are **ZIP local file headers with the `PK\x03\x04` signature
removed**:

```
14 00      version needed 2.0
06 00      flags
08 00      method 8 = deflate
09 b7 ad 1a   modification time and date   ← the bytes that "varied by version"
<crc32> <compressed size> <uncompressed size> <name length> <extra length>
<name, nibble-swapped> <deflated data>
```

Phase 1 scanned the raw bytes for zlib streams. That only finds a stream where
the ZIP-level deflate happened to use *stored* blocks — raw bytes passed
through. Wherever deflate actually compressed the entry, the inner stream was
invisible to a byte scan, and those files were misfiled as closed.

Read as ZIP entries, inflated, and checked against the CRC-32 in their own
headers, every entry that matters verifies, in every part:

| | parts |
| --- | --- |
| display mesh (`Contents/DisplayLists`) | **132 / 132** |
| preview image (`PreviewPNG`) | **132 / 132** |
| Parasolid model partition | 126 / 132 (6 carry only the small stub) |

## 2. The display mesh

`Contents/DisplayLists` is an MFC archive (class tags `uoTempBodyTessData_c`,
`uoTempFaceTessData_c`) holding the triangulation SolidWorks draws on screen.
Each face is self-describing:

```
4, 8, 2, <strips>, <length of each strip>      strip table, u32 LE
12, 100, 2, <n>, x y z × n                     positions, f32 LE, metres
12, 100, 2, <n>, x y z × n                     normals,   f32 LE
```

The strip lengths must sum to `n` and the normal array must repeat `n`. Those
two agreements let a face be found by scanning without understanding every
other record — the same self-verification that made the container reliable.

Strips alternate winding, so each triangle is turned to agree with the
normals SolidWorks stored for its corners. Getting that wrong would not show
with double-sided rendering, but every volume and section would be wrong.

## 3. How it was checked

By **volume**, because volume only comes out right when every face is
present, the mesh is closed and every triangle faces outward:

| part | area mm² | volume mm³ | expected |
| --- | --- | --- | --- |
| cube 10 | 600 | **1000** | exact |
| cube 20 | 2400 | **8000** | exact |
| sheet 50×100×2 | 10600 | **10000** | exact |
| cylinder Ø50×100 | 19610 | 195723 | 196350 — −0.3 %, facets of a curve |
| 50 cube, Ø20 hole | 17512 | 109399 | 109292 |

Across the corpus: every one of the 132 real parts decodes to a closed mesh
with positive volume; decoding takes 5 ms on the median part and 46 ms on the
largest.

Visually, in the real viewer, against the preview SolidWorks saved in the
same file: `юбка`, `регуль` (both previously "closed"), `BT100.01.01.201` and
the `hobbywing 56118` motor all match. On the motor the shaft looked missing
from one camera angle; measured, the mesh ends in a Ø8 mm shaft 10 mm long
behind a Ø56 body — the name of the part.

## 4. Not yet

* **Colour.** Parts show in the viewer's neutral grey, not their SolidWorks
  appearance.
* **Assemblies.** An `.SLDASM` holds no display mesh of its own — it references
  its parts. It opens with its preview; placing the parts is the next step.

## Reproducing this

```bash
npm test --workspace @docuview/api        # volumes, CRC gate, 132/132 corpus
node scripts/verify-models.mjs samples    # through the running viewer
```
