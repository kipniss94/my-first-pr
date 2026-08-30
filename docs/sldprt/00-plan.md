# Reverse-engineering `.SLDPRT` — working plan

The goal, stated so it can be judged: **read geometry out of a SolidWorks part
file and draw it in our viewer, without SolidWorks and without asking anyone to
re-export.**

This document is the group's charter. It survives context resets — anyone
picking the work up should be able to read this file plus the numbered reports
beside it and continue without re-deriving anything.

---

## What is realistically in reach

A `.SLDPRT` is an OLE compound file. Inside it there are, broadly, three kinds
of thing:

| Content | Reachable? | Why |
| --- | --- | --- |
| Document properties, preview bitmap | **Yes, done** | Standard OLE property sets and ordinary images. Already implemented in `apps/api/src/processing/native-cad.ts`. |
| **Tessellated display geometry** — the triangles SolidWorks draws on screen and eDrawings reads | **This is the target** | It is a mesh: vertices, triangles, normals, edges. Undocumented, but it is plain numeric data, and numeric data leaves fingerprints. |
| Exact B-rep — the NURBS surfaces of the solid | **No** | That is a Parasolid kernel transmit stream. Reconstructing it means reimplementing a commercial geometry kernel. Not a goal here, and saying otherwise would be dishonest. |

So: **a mesh is the deliverable.** That is enough to rotate, measure a bounding
box, and cut a section. It is not enough to measure an exact radius off a
cylindrical face — and the viewer will keep saying so.

Full exact geometry stays available through `CAD_CONVERTER_CMD`, which routes
the file through a licensed converter and the ordinary STEP path.

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

All three live in `scripts/sldprt/` and reuse the application's own compound
file reader — so if that reader cannot open a real file, these say so
immediately rather than hiding it.

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
| 1. Container map | `01-streams.md` | Every stream in real files catalogued, with a shortlist of geometry candidates and a stated reason for each. |
| 2. Structure | `02-structures.md` | Vertex array located and confirmed by at least two independent anchors (a value hunt and a diff). Record layout described field by field. |
| 3. Decoder | `apps/api/src/processing/sldprt/` + tests | Mesh extracted from a real file and passing the validation checks above. |
| 4. Integration | processor `cad-sldprt` → NMG → `CadViewer` | A real `.SLDPRT` opens as rotatable, sectionable geometry in the app. |

**Every phase can end in "no".** If phase 2 shows the mesh is encrypted, or
compressed with something we cannot identify, that is the result and the work
stops there — with the finding written down, rather than more effort spent.

---

## What is needed to start

Real files. This is a hard blocker: the synthetic fixtures in `fixtures/` are
built to the published container spec and prove the tooling runs, but they say
nothing about how SolidWorks actually stores geometry. The one real file tried
so far (112 KB, `10640.00.00.00.00.05.SLDPRT`) already showed that the current
preview extractor finds nothing in it.

See `samples/README.md` for what to provide and where to put it.
