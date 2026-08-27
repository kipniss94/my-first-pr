import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';

export const metadata: Metadata = {
  title: 'Online CAD viewer — STEP, IGES, STL, DXF and 3D models',
  description:
    'Free online CAD viewer for STEP, STP, IGES, STL, OBJ, glTF, 3MF and DXF files. Rotate, zoom, section and measure 3D models in the browser — no CAD software required.',
  keywords: [
    'online CAD viewer',
    'STEP viewer online',
    'STP viewer',
    'IGES viewer online',
    'STL viewer',
    'DXF viewer',
    'DWG viewer',
    '3D model viewer online',
  ],
  alternates: { canonical: '/cad-viewer' },
  openGraph: {
    title: 'Online CAD viewer — STEP, IGES, STL and DXF',
    description: 'Open and inspect CAD models in the browser: orbit, section, measure.',
    url: '/cad-viewer',
  },
};

export default function CadViewerLanding() {
  return (
    <LandingPage
      eyebrow="CAD & 3D viewer"
      title="An online CAD viewer that actually inspects the model"
      intro="Upload a STEP, IGES, STL, OBJ, glTF or DXF file and it opens in a full 3D workspace: orbit and pan, switch to standard views, walk the assembly tree, cut section planes and take measurements. STEP and IGES are tessellated server-side by OpenCascade, so B-Rep solids arrive as clean geometry rather than a triangle soup."
      kinds={['cad']}
      capabilities={[
        {
          title: 'Navigation that feels like CAD',
          body: 'Orbit, pan and zoom, plus Front, Back, Left, Right, Top, Bottom and Isometric views, fit-to-screen and a camera reset.',
        },
        {
          title: 'Assembly tree',
          body: 'Components from STEP assemblies and named groups from OBJ appear as a tree you can expand, select, hide and isolate.',
        },
        {
          title: 'Measurements',
          body: 'Point-to-point distance with vertex snapping, straight edge length, and the angle between two picked segments.',
        },
        {
          title: 'Section planes with capping',
          body: 'Cut along X, Y or Z, slide the plane, flip it. Cut faces are capped and hatched, and hollow parts read as hollow because the cap is computed from the real solid, not painted on.',
        },
        {
          title: 'Display modes',
          body: 'Shaded, shaded with edges, and wireframe. Adjust transparency or recolour parts to see inside an assembly.',
        },
        {
          title: 'Real properties',
          body: 'Bounding box, volume, surface area, triangle and face counts per part. Anything the file does not carry is shown as N/A rather than invented.',
        },
      ]}
      limitations={[
        'DWG needs an external converter (ODA File Converter or LibreDWG) configured on the server; without it we tell you to save as DXF instead.',
        'DXF rendering covers 2D entities — lines, polylines, circles, arcs, ellipses, splines and block inserts. 3D solids inside DXF are not drawn.',
        'IGES files are tessellated from their surfaces; free-standing curves and annotation are not rendered.',
        'Proprietary formats (SolidWorks, Inventor, CATIA, Parasolid, JT, Revit) are identified by name only. Export to STEP to open them here.',
        'Volume is exact for closed solids. For open or non-manifold meshes it is reported as approximate.',
      ]}
      faq={[
        {
          question: 'Which CAD formats can I open right now?',
          answer:
            'STEP (.step, .stp) and IGES (.iges, .igs) through OpenCascade, plus STL, OBJ, PLY, glTF/GLB, 3MF, FBX, COLLADA and DXF. DWG opens only when a converter is installed on the server.',
        },
        {
          question: 'Do I need to install anything?',
          answer:
            'No. The viewer runs in any browser with WebGL 2 — Chrome, Edge, Firefox and Safari. There is no plugin and no account.',
        },
        {
          question: 'How accurate are the measurements?',
          answer:
            'Measurements are taken on the tessellated geometry, so they carry the tessellation tolerance (roughly 0.1% of the bounding box). That is fine for checking sizes and clearances, and is not a substitute for a metrology tool.',
        },
        {
          question: 'What happens to my file?',
          answer:
            'It is stored on the server only long enough to open it, then deleted automatically. Files are never executed and never shared.',
        },
        {
          question: 'Can it open an assembly?',
          answer:
            'Yes. STEP assemblies keep their component hierarchy, and you can select, hide or isolate any component from the model tree.',
        },
      ]}
    />
  );
}
