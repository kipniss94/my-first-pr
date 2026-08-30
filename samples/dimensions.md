# Known dimensions of the sample parts

Fill this in for every file you add. These numbers are the anchors the analysis
hangs on: they turn "these bytes changed" into "this field is a length in
metres". Without them the work is guessing.

Millimetres throughout, as read off the model or the drawing.

## Template — copy one block per file

```
### <file name>.SLDPRT
SolidWorks version:      2021 SP3          (Help → About, if known)
Overall size X × Y × Z:  120 × 80 × 25
A hole diameter:         8.5               (any feature you can measure)
Volume:                  145 230 mm³       (Evaluate → Mass Properties)
Surface area:            38 400 mm²
Material:                Steel 1.0038
Notes:                   two through-holes, one fillet R3
```

## Controlled pairs

If you provide a pair that differs by one change, say exactly what changed —
this is the single most valuable thing in the whole set.

```
### cube-10.sldprt → cube-20.sldprt
Changed:  the cube edge, 10 mm → 20 mm. Nothing else touched.
```

---

## Parts

<!-- add your blocks below -->
