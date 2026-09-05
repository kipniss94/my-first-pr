# Reverse-engineering `.SLDPRT` — working plan

The goal, stated so it can be judged: **read geometry out of a SolidWorks part
file and draw it in our viewer, without SolidWorks and without asking anyone to
re-export.**

This document is the group's charter. It survives context resets — anyone
picking the work up should be able to read this file plus the numbered reports
beside it and continue without re-deriving anything.

---

## What is realistically in reach

A `.SLDPRT` is a package of its own — **not** an OLE compound file, whatever the
extension databases claim; see `01-container.md`. Inside it there are, broadly,
three kinds of thing:

| Content | Reachable? | Why |
| --- | --- | --- |
| Document properties, preview bitmap | **No, on modern files** | `native-cad.ts` reads OLE property sets, and these files have none. The preview lives in a part of the package that is not plain zlib and has not yielded yet. |
| Tessellated display geometry (`DisplayLists`, `LWDATA`) | **Not needed** | In the same unopened part of the package. Superseded: the exact geometry turned out to be easier to reach than the display cache. |
| Exact B-rep — the NURBS surfaces of the solid | **Yes — this was wrong** | See `01-container.md`. It is a Parasolid transmit stream, zlib-compressed and otherwise untouched, in a format Siemens publishes. It has been extracted from all 21 sample files and the coordinates verified against known dimensions. Reading it is work, but there is nothing left to reverse. |

**Superseded by phase 1.** The target is now the exact B-rep in the Parasolid
partition, tessellated for display. A mesh is what the viewer eventually draws,
but it is derived from the real surfaces rather than scavenged from a display
cache — which means measurements are against the model, not against a
tessellation of unknown tolerance.

`CAD_CONVERTER_CMD` remains as the route for anything this parser cannot yet
handle.

---

## Method

The classic reverse-engineering loop, with one substitution.

A human engineer would open the model in a CAD viewer, read a dimension off the
screen, then go looking for that number in the file. **There is no CAD viewer in
this environment** — no SolidWorks, no eDrawings, no GUI at all. So the visual
step is replaced by two mechanical ones that give the same anchoring:

1. **Value hunting.** You supply a dimension you know from the model (an overall
   length, a hole diameter). `find.ts` locates every place that number is
   stored. A hit is a coordinate field whose meaning is already known.
2. **Differential analysis.** Two files that differ by exactly one known change
   — a 10 mm cube and a 20 mm cube — differ, in bytes, by exactly the encoding
   of that change. `diff.ts` shows those bytes and what the numbers went from
   and to. Nothing is guessed: the edit is known.

Both are stronger than eyeballing a screen, because they produce byte offsets
rather than impressions.

### Validation, so we know when we are right

A parser that produces *something* is worthless; the question is whether it
produces the right thing. Acceptance is measured, not judged:

- **Bounding box** matches the part's real overall dimensions to within the
  tessellation tolerance.
- **Closed shell**: every triangle edge is shared by exactly two triangles. A
  solid part that tessellates into an open mesh means the parse is wrong.
- **Normal consistency**: face normals agree with vertex winding.
- **Volume** is positive and within a few percent of the value SolidWorks
  reports in its own mass properties, when that is available.

A parse that fails these is reported as failed. "Looks about right" is not a
result.

---

## The instruments

All three live in `scripts/sldprt/`. They reuse the application's own readers on
purpose: when the compound-file reader failed on the first real part, these said
so immediately instead of hiding it behind a second implementation.

```bash
# What is in this file? Every stream, its entropy, compression, and whether it
# contains long runs of plausible coordinates.
npx tsx scripts/sldprt/inspect.ts samples/part.sldprt

# What changed between two files that differ by one known edit?
npx tsx scripts/sldprt/diff.ts samples/cube-10.sldprt samples/cube-20.sldprt

# Where is the number 45.5 mm stored? (searched in mm, in metres, and halved)
npx tsx scripts/sldprt/find.ts samples/part.sldprt 45.5 12 8
```

`inspect.ts` also writes a JSON report per file into `docs/sldprt/reports/`.

### A note on the heuristics

`findNumericRuns` looks for long runs of finite numbers in a physical range.
That alone produces **false positives** — decompressed image pixels and padding
also decode into "plausible" floats. So runs are also scored on *variety*: a
real vertex array is made of mostly different numbers, while pixel data repeats.
Runs below 35 % distinct values are discarded. This was not a theoretical
concern: the first run of the tool reported a PNG's pixel data as a 240-value
coordinate array.

---

## Phases and their exit criteria

| Phase | Output | Done when |
| --- | --- | --- |
| ~~1. Container map~~ | `01-container.md` | **Done.** Container decoded, Parasolid partition extracted from 21/21 files, coordinates confirmed by controlled pairs. |
| 2. Parasolid structure | `02-parasolid.md` | Node table and topology parsed: body → shell → face → loop → edge → vertex, with the surface attached to each face. |
| 3. Decoder | `apps/api/src/processing/sldprt/` + tests | Mesh extracted from a real file and passing the validation checks above. |
| 4. Integration | processor `cad-sldprt` → NMG → `CadViewer` | A real `.SLDPRT` opens as rotatable, sectionable geometry in the app. |

**Every phase can end in "no".** If phase 2 shows the mesh is encrypted, or
compressed with something we cannot identify, that is the result and the work
stops there — with the finding written down, rather than more effort spent.

---

## Samples

21 real parts, supplied as controlled pairs, live in `samples/` (not committed —
see `samples/README.md`). They are what turned this from guesswork into
measurement: the synthetic fixtures in `fixtures/` are built to the published
OLE spec and pass happily, while real SolidWorks files are not OLE containers at
all. Every claim in `01-container.md` is checked against them by
`apps/api/test/sldprt-container.test.ts`.
