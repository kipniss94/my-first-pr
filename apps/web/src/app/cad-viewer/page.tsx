import type { Metadata } from 'next';
import { LandingPage } from '@/components/site/LandingPage';
import { serverLang } from '@/lib/server-lang';

export async function generateMetadata(): Promise<Metadata> {
  const ru = (await serverLang()) === 'ru';
  return {
    title: ru
      ? 'Просмотр CAD онлайн — SolidWorks, STEP, IGES, STL, DXF'
      : 'Online CAD viewer — SolidWorks, STEP, IGES, STL, DXF and 3D models',
    description: ru
      ? 'Бесплатный просмотр моделей SolidWorks, STEP, IGES, STL, OBJ, glTF, 3MF и DXF в браузере: вращение, сечения, размеры — без установки CAD.'
      : 'Free online CAD viewer for SolidWorks, STEP, STP, IGES, STL, OBJ, glTF, 3MF and DXF files. Rotate, zoom, section and measure 3D models in the browser — no CAD software required.',
    keywords: [
      'online CAD viewer',
      'SolidWorks viewer online',
      'STEP viewer online',
      'STP viewer',
      'IGES viewer online',
      'STL viewer',
      'DXF viewer',
      '3D model viewer online',
    ],
    alternates: { canonical: '/cad-viewer' },
    openGraph: {
      title: ru ? 'Просмотр CAD онлайн' : 'Online CAD viewer — SolidWorks, STEP, IGES, STL and DXF',
      description: ru ? 'Модели и чертежи в браузере: вращение, сечения, размеры.' : 'Open and inspect CAD models in the browser: orbit, section, measure.',
      url: '/cad-viewer',
    },
  };
}

export default async function CadViewerLanding() {
  return (await serverLang()) === 'ru' ? <Russian /> : <English />;
}

function English() {
  return (
    <LandingPage
      eyebrow="CAD & 3D viewer"
      title="An online CAD viewer that actually inspects the model"
      intro="Drop a SolidWorks part, assembly or drawing, or a STEP, IGES, STL, OBJ, glTF or DXF file, and it opens in a full 3D workspace: orbit and pan, standard views, the assembly tree, section planes and dimensions. SolidWorks files are read from the file itself — no SOLIDWORKS needed; STEP and IGES are tessellated server-side by OpenCascade."
      kinds={['cad']}
      capabilities={[
        {
          title: 'SolidWorks without SolidWorks',
          body: 'Parts open in 3D, assemblies put every part where the assembly places it, drawings open as vector sheets with all their views, dimensions and notes.',
        },
        {
          title: 'Dimensions like a drawing',
          body: 'Pick faces, edges or vertices: a hole gives its diameter, two holes their centre distance, near and far sides; switch variants with Space or the mouse wheel.',
        },
        {
          title: 'Section planes with capping',
          body: 'Cut along X, Y or Z, slide the plane, flip it. Cut faces are capped and hatched, and hollow parts read as hollow because the cap is computed from the real solid.',
        },
        {
          title: 'Assembly tree',
          body: 'Components appear as a tree you can expand, select, hide and isolate. Missing part files are found in a folder you point at, version by version.',
        },
        {
          title: 'Display modes',
          body: 'Shaded, shaded with edges, and wireframe; transparency to see inside an assembly; light and dark themes.',
        },
        {
          title: 'Real properties',
          body: 'Bounding box, volume, surface area, triangle and face counts per part. Anything the file does not carry is shown as N/A rather than invented.',
        },
      ]}
      limitations={[
        'DWG needs an external converter (ODA File Converter or LibreDWG) configured on the server; without it we tell you to save as DXF instead.',
        'SolidWorks Toolbox fasteners live in the author’s library, not the project folder; without those files they are listed as missing.',
        'On SolidWorks drawings, broken views, detail-view hatching and weld symbols are taken from the picture SolidWorks saved rather than drawn as vectors.',
        'Inventor, CATIA, Revit and JT open from the preview stored in the file; export to STEP for geometry.',
        'Measurements are taken on the tessellated geometry and carry its tolerance.',
      ]}
      faq={[
        {
          question: 'Which CAD formats can I open right now?',
          answer:
            'SolidWorks parts, assemblies and drawings (.sldprt, .sldasm, .slddrw); STEP and IGES through OpenCascade; STL, OBJ, PLY, glTF/GLB, 3MF, FBX, COLLADA and DXF. DWG opens only when a converter is installed on the server.',
        },
        {
          question: 'Do I need to install anything?',
          answer: 'No. The viewer runs in any browser with WebGL 2 — Chrome, Edge, Firefox and Safari. There is no plugin and no account.',
        },
        {
          question: 'How accurate are the measurements?',
          answer:
            'Faces and edges are recognised as planes, cylinders, circles and lines by fitting, so a Ø50 hole reads 50.00 mm; the result still carries the tessellation tolerance and is not a substitute for a metrology tool.',
        },
        {
          question: 'What happens to my file?',
          answer: 'It is stored on the server only long enough to open it, then deleted automatically. Files are never executed and never shared.',
        },
        {
          question: 'Can it open an assembly?',
          answer:
            'Yes. Drop the assembly with its parts, or the whole project folder: every part goes where the assembly puts it, in the right configuration and count, and what is missing is listed.',
        },
      ]}
    />
  );
}

function Russian() {
  return (
    <LandingPage
      eyebrow="Просмотр CAD и 3D"
      title="Онлайн-просмотрщик CAD, который действительно позволяет изучить модель"
      intro="Перетащите деталь, сборку или чертёж SolidWorks либо файл STEP, IGES, STL, OBJ, glTF или DXF — он откроется в полноценном 3D: вращение и сдвиг, стандартные виды, дерево сборки, сечения и размеры. Файлы SolidWorks читаются из самого файла — SOLIDWORKS не нужен; STEP и IGES разбиваются на треугольники на сервере через OpenCascade."
      kinds={['cad']}
      capabilities={[
        {
          title: 'SolidWorks без SolidWorks',
          body: 'Детали открываются в 3D, сборки расставляют каждую деталь по месту, чертежи открываются векторными листами со всеми видами, размерами и надписями.',
        },
        {
          title: 'Размеры как на чертеже',
          body: 'Выбирайте грани, рёбра и вершины: отверстие даёт диаметр, два отверстия — расстояние между центрами, ближними и дальними сторонами; варианты переключаются пробелом или колесом мыши.',
        },
        {
          title: 'Сечения с заливкой',
          body: 'Разрез по X, Y или Z, плоскость двигается и разворачивается. Срез заливается и штрихуется, полые детали остаются полыми — заливка строится по настоящему телу.',
        },
        {
          title: 'Дерево сборки',
          body: 'Компоненты — деревом, их можно раскрывать, выбирать, скрывать и показывать по одному. Недостающие детали находятся в указанной папке, с выбором версии.',
        },
        {
          title: 'Режимы отображения',
          body: 'Тонировка, тонировка с рёбрами и каркас; прозрачность, чтобы заглянуть внутрь сборки; светлая и тёмная темы.',
        },
        {
          title: 'Настоящие свойства',
          body: 'Габариты, объём, площадь поверхности, число треугольников и граней каждой детали. Чего нет в файле, показывается как «н/д», а не выдумывается.',
        },
      ]}
      limitations={[
        'Для DWG нужен внешний конвертер (ODA File Converter или LibreDWG) на сервере; без него мы предложим сохранить файл в DXF.',
        'Крепёж SolidWorks Toolbox хранится в библиотеке автора, а не в папке проекта; без этих файлов он показывается в списке недостающих.',
        'На чертежах SolidWorks виды с разрывами, штриховка выносных видов и знаки сварки берутся из сохранённой картинки листа, а не рисуются вектором.',
        'Inventor, CATIA, Revit и JT открываются по сохранённому в файле эскизу; для геометрии экспортируйте их в STEP.',
        'Размеры считаются по геометрии из треугольников и несут её погрешность.',
      ]}
      faq={[
        {
          question: 'Какие форматы CAD открываются уже сейчас?',
          answer:
            'Детали, сборки и чертежи SolidWorks (.sldprt, .sldasm, .slddrw); STEP и IGES через OpenCascade; STL, OBJ, PLY, glTF/GLB, 3MF, FBX, COLLADA и DXF. DWG — только если на сервере установлен конвертер.',
        },
        {
          question: 'Нужно ли что-то устанавливать?',
          answer: 'Нет. Просмотрщик работает в любом браузере с WebGL 2 — Chrome, Edge, Firefox и Safari. Без дополнений и без регистрации.',
        },
        {
          question: 'Насколько точны размеры?',
          answer:
            'Грани и рёбра распознаются как плоскости, цилиндры, окружности и отрезки подгонкой, поэтому отверстие Ø50 показывает 50,00 мм; при этом остаётся погрешность разбиения на треугольники — это не замена измерительному инструменту.',
        },
        {
          question: 'Что происходит с моим файлом?',
          answer: 'Он хранится на сервере, только пока нужен для просмотра, затем удаляется автоматически. Файлы никогда не запускаются и никому не передаются.',
        },
        {
          question: 'Открывает ли он сборки?',
          answer:
            'Да. Перетащите сборку вместе с деталями или всю папку проекта: каждая деталь встанет на место, в нужной конфигурации и количестве, а недостающие будут перечислены.',
        },
      ]}
    />
  );
}
