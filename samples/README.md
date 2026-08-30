# Sample CAD files for the `.SLDPRT` analysis

Put real SolidWorks files here. Everything in this folder except this README is
git-ignored, so nothing lands in a public repository by accident.

> **`kipniss94/my-first-pr` is a public repository.** Proprietary part files
> must never be committed to it. Use the private `SaasProject_1` remote for
> anything confidential — see below.

## What is most useful

The analysis needs anchors, not volume. Ten well-chosen files beat a hundred
random ones.

**Highest value — a controlled pair.** Two files that differ by exactly one
known change. Model a cube 10 mm on a side, save it, change one dimension to
20 mm, save under a new name:

```
cube-10.sldprt
cube-20.sldprt
```

The bytes that differ between those two *are* the encoding of that dimension.
This single pair is worth more than the rest put together. A second pair — the
same part with and without one hole — pins down how faces are counted.

**Also valuable:**

| File | Why |
| --- | --- |
| A simple prismatic part with dimensions you can write down | Lets the value hunt anchor on known numbers |
| The same part saved from two SolidWorks versions | Shows what is version-specific and what is stable |
| A part with a cylindrical face | Tessellation of curves behaves differently from flat faces |
| A sheet-metal part | Different feature tree, same geometry container |
| One assembly plus its components | Confirms how references are stored |

**Please also write down**, in `samples/dimensions.md`, whatever you know about
each part: overall length/width/height in mm, a hole diameter, the mass or
volume if SolidWorks reports it. Those numbers are what turns "these bytes
changed" into "this field is the X coordinate in metres". Without them the
analysis is guessing; with them it is measurement.

## How to get the files here

The working container has no access to Google Drive folders by link. Two ways:

**Via the private repo (preferred).**

```bash
# in your local clone
git checkout claude/cad-pdf-office-saas-06j0zk
mkdir -p samples
cp /path/to/your/models/*.SLDPRT samples/
git add -f samples/*.SLDPRT samples/dimensions.md   # -f overrides the ignore
git commit -m "Add SolidWorks samples for format analysis"
git push saas HEAD:sldprt-samples                    # private repo only
```

Then say so here, and the branch gets fetched from `SaasProject_1`.

**Or attach them to a message** in this session, if the client allows binary
attachments.

## Licensing and scope

These files are yours and stay yours. They are used to work out how the format
stores geometry so our own viewer can read it — no SolidWorks code is
decompiled, and nothing derived from your parts ships in the product. The
samples are not committed to the public repository, and the analysis notes in
`docs/sldprt/` describe the *format*, not your designs.
