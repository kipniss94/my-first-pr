# Phase 2 — inside the Parasolid stream

**Status: the stream is a node list, the node framing is understood, and the
vertices come out correct. Faces and surfaces are not read yet.**

---

## 1. The schema is the missing piece, and it is only half missing

A Parasolid transmit stream is a list of nodes. Each starts with a 16-bit type
and a 16-bit id; what follows is fixed by the *schema*, named in the header:

```
PS...?: TRANSMIT FILE (partition) created by modeller version 3501210
SCH_3501210_35102_13006
```

The file embeds a schema section — but only SolidWorks' own **extensions**. The
field name `schema_embedding_map` is literally in there, next to the types it
covers:

```
CCCCCCCI  mesh  polyline  lattice  attdef_list
CCCA      index_map_offset  index_map  node_id_index_map  child  lowest_node_id
CCCCCDI   legal_owners
          FACE_ID_2001   ATOM_ID_2001   ENT_TIME_STAMP_2001
          SDL/TYSA_COLOUR   BODY_MATCH   LAST_BODY_MODIFYING_FEATURE_ID
```

Those letter strings are field types — `C` byte, `D` double, `I` index, `A`
array — each followed by length-prefixed field names. So the meta-format is
self-describing.

What is *not* in the file is the standard schema: `BODY`, `SHELL`, `FACE`,
`LOOP`, `EDGE`, `VERTEX`, `PLANE`, `CYLINDER` and the rest. That ships with
Parasolid. The public *XT Format Reference* documents the encoding, and the
`SCH_*` schema files themselves are not freely redistributable.

**This is the correction to the estimate given earlier.** Reading the geometry
was called "weeks" on the assumption that the node layout had to be broken from
scratch. It does not: the framing is regular, and the standard types can be
recovered the same way the container was — from parts whose answer is known in
advance.

## 2. Point nodes, read and verified

Node type `0x1d` is a point. Its layout, established from the controlled pairs:

```
00 1d      node type
00 31      node id
00 00 00 20   32-bit field
00 01 00 0d 00 39 00 3a   four 16-bit references
<double BE> <double BE> <double BE>   x, y, z in metres
```

At offset 2010 in `cube-10`, that reads **(0.005, −0.005, 0.01)** — a corner of
a 10 mm cube modelled about its centre on two axes and from zero on the third.

### The evidence

| model | expected | measured from the vertices |
| --- | --- | --- |
| `cube-10` | 10 × 10 × 10 | **10.0 × 10.0 × 10.0 mm** |
| `cube-20` | 20 × 20 × 20 | **20.0 × 20.0 × 20.0 mm** |
| `sheet-flat-50-100-2` | 100 × 50 × 2 | **100.0 × 50.0 × 2.0 mm** |
| `hole-d10`, `hole-d20` | 50 mm base cube | 50.0 × 50.0 × 50.0 mm |
| `юбка` (production part) | — | 235.0 × 68.3 × 163.1 mm |

The sheet is the strongest single case: its name states its dimensions and the
bytes agree to three figures, with nothing in the file to hint at the answer.

Across all 65 models with a readable partition, **every** bounding box lands
between 10 mm and 272 mm — median 51 mm — and none falls outside a sane
engineering range. A wrong node offset does not produce a slightly wrong part;
it produces denormals and astronomical reals. Nothing like that appears.

## 3. What this does not reach

* **Parts with no vertices read as nothing.** 31 of 65. A plain revolved
  cylinder is the clean example: its circular edges close on themselves, so the
  body genuinely has no corners. This is correct behaviour, not a failure, but
  it means the vertex extent is not a general bounding box.
* **The extent is the vertices' extent.** A curved face can bulge past the
  corners that bound it, so on a filleted or turned part the true silhouette is
  larger than what is reported. The viewer says so rather than calling it a
  bounding box.
* **One vertex in eight is missed on the cube** — 7 of 8 corners. The reference
  list is not the same length for every node, and this reader assumes four. The
  box came out exact anyway because the extremes repeat across corners, but the
  scan is a scan, not a node walk.

## 4. Next

The honest next step is the `index_map` the embedded schema already names: it
gives each node's offset, which replaces the byte scan with a real walk and
fixes the missed-node problem. From there, the type indices can be identified by
counting against known topology — a cube must show 1 body, 1 shell, 6 faces,
6 planes, 12 edges, 8 vertices — and that is what turns points into surfaces and
surfaces into something drawable.

## Reproducing this

```bash
npm test --workspace @docuview/api   # includes the measured-size assertions
```

The tests skip loudly when `samples/` is empty; the files are the user's own
parts and are not committed.
