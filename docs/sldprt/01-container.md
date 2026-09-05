# Phase 1 — the container, decoded

Result of running the lab over 21 real SolidWorks parts (controlled pairs:
cube 10/20 mm, three boxes, four cylinders, fillet radii 2/5/10, chamfer,
hole 10/20 mm, sheet metal flat and bent).

**Status: the container is understood and the geometry is located and verified.**

---

## Correction to the plan

`00-plan.md` said the exact B-rep was out of reach — "reimplementing a
commercial geometry kernel", "not a goal here". **That was wrong**, and wrong in
a way that mattered: it would have aimed the whole effort at the display mesh
and left the real geometry untouched.

What is actually in the file is a **Parasolid transmit stream**, zlib-compressed
and otherwise unaltered. The exact B-rep is right there, in a format Siemens
publishes. Reading it is a substantial job — it is not years of reverse
engineering, because there is nothing left to reverse: the container is solved
and the payload is a documented format.

---

## 1. A modern `.SLDPRT` is not a compound file

The first and most consequential finding. Every one of the 21 files fails the
OLE signature check:

```
cube-10.SLDPRT   0e 6a 0a 42  00 00 00 04  36 33 8c 47 …
                 ^^^^^^^^^^^ varies per file, not D0 CF 11 E0
```

This is why the shipped viewer reports "no preview we can show" on a real part:
`native-cad.ts` walks a compound file, and there is no compound file to walk.
The synthetic fixtures were built to the published OLE spec, so they passed —
and proved nothing about SolidWorks. That is exactly the gap the sample files
were needed to close.

Whole-file entropy is **7.89 bits/byte**, so the bulk is compressed or
encrypted. `cube-10` and `cube-20` — the same trivial part, one dimension apart
— share **no identical run of 32 bytes anywhere**.

## 2. The package is OPC-shaped, with nibble-swapped names

Entry names are stored with the two nibbles of each byte swapped. Undo that and
the layout is immediately familiar:

```
[Content_Types].xml          _rels/.rels
docProps/core.xml            docProps/app.xml         docProps/custom.xml
docProps/ISolidWorksInformation.xml
Contents/Config-0-Partition        ← the geometry
Contents/Config-0-GhostPartition
Contents/Config-0-LWDATA           Contents/DisplayLists
Contents/Config-0-ResolvedFeatures swXmlContents/Features
PreviewPNG                         ModelStamps
ThirdPty/…                         _MO_VERSION_17000/History
```

99 entry records in `cube-10`. The transform is its own inverse:
`unswapNibbles(unswapNibbles(x)) === x`.

### Record layout

```
14 00 06 00 08 00 09 b7 ad 1a   10-byte entry marker
<u32> <u32> <u32>               three fields, meaning not yet pinned down
<u32>                           name length in bytes
<name>                          nibble-swapped, name-length bytes
…                               ~25 bytes, layout varies by entry kind
<u32> uncompressedSize
<u32> compressedSize
<zlib stream>
```

The records near the end of the file form a directory whose layout differs from
the local headers, so names read there come out as fragments. Not needed for
geometry, so not chased further.

### Why payloads are found by verification, not by arithmetic

The gap between the name and the payload is 33 bytes for the Parasolid
partitions but not for every entry kind. Pairing payload to name by offset
arithmetic **got 6 of 21 files wrong** and, worse, silently attached the wrong
name to the right data.

So `readPayloads` ignores the layout and looks for zlib headers whose two
preceding 32-bit words are exactly its own uncompressed and compressed sizes.
Two independent numbers agreeing by chance does not happen. This finds
**21 out of 21** and has produced no false positive.

## 3. The geometry: Parasolid, big-endian

Every file yields exactly three verified zlib payloads, all Parasolid:

```
PS...?: TRANSMIT FILE (partition) created by modeller version 3501210
SCH_3501210_35102_13006
```

| stream | cube-10 | role |
| --- | --- | --- |
| ghost partition | 1176 B | bookkeeping |
| **model partition** | **6682 B** | **the B-rep** |
| deltas | 1144 B | edit history |

All 21 partitions hash differently, so they are model-specific, not a shared
prelude.

### The proof

Parasolid stores reals **big-endian**. Searching little-endian — which the value
hunter did until this run — finds nothing at all. Searching big-endian:

| model | expected (metres) | found at byte offsets |
| --- | --- | --- |
| cube-10 | 0.01, ±0.005 | 1675, 1767, 2040 / 1667, 1824, 2032 |
| cube-20 | 0.02, ±0.01 | **the same offsets** |
| cylinder d50 h100 | 0.025 radius, 0.1 height | 1707, 1831 / 1675, 2017 |
| box 200×50×30 | 0.03, 0.025 | 1675, 1767 / 1759, 2112 |

Same byte offsets, values scaled exactly as the model was edited, and each
value **absent** from its partner file. That last part is what makes it proof
rather than coincidence: it is the *exchange* of values that identifies the
field, not merely their presence.

### Complexity tracks the model

Distinct plausible coordinates in each partition:

| model | distinct values |
| --- | --- |
| cylinder (any size) | 17–18 |
| cube / box | 25–27 |
| cube with one hole | 32 |
| block with fillets | 21–22 |
| sheet metal, bent | 59 |

A cube stores exactly `−0.005, 0, 0.005, 0.01`. **This is the exact B-rep, not a
mesh** — a tessellated cylinder would carry hundreds of distinct vertex
coordinates, not seventeen.

## 4. What is still closed

The three Parasolid streams account for only **4–8 % of the file**. The other
92 % — including `PreviewPNG`, `DisplayLists` and `LWDATA` — is not plain zlib
and does not yield to any codec tried. Two files of the same part share no
32-byte run there, which points at per-file keying rather than plain
compression.

Consequence: **the preview image is not currently extractable** from a modern
part. The geometry is, which matters more, but the immediate error the user sees
is not fixed by this phase alone.

---

## What this changes in the product

The viewer's "Preview" path was built for a container these files do not use.
Once the Parasolid partition is parsed, the honest label for SolidWorks stops
being *preview* and becomes *geometry* — with the caveat that it is B-rep that
still has to be tessellated for display.

## Next: phase 2

Parse the Parasolid XT node structure — schema table, node types, then the
topology (body → shell → face → loop → edge → vertex) and the surfaces attached
to the faces. Plane, cylinder, cone, sphere and torus are analytic and cover
most mechanical parts; B-spline surfaces come after.

Validation stays as set out in the plan: closed shell, bounding box against the
known dimensions of these very samples, positive volume.

## Reproducing this

```bash
npx tsx scripts/sldprt/inspect.ts samples/cube-10.SLDPRT
npx tsx scripts/sldprt/find.ts   samples/cube-10.SLDPRT 10 5
npm test --workspace @docuview/api        # includes the container tests
```

The container tests skip loudly when `samples/` is empty — the files are the
user's own parts and are not committed.
