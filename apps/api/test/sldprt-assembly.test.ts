import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readAssemblyTree } from '../src/processing/sldprt/assembly.js';

/**
 * An assembly's placements come from its COMPINSTANCETREE: every part
 * occurrence, through its sub-assemblies, placed by the product of the
 * transforms down its path. Built here by hand, the way SolidWorks writes it.
 */

const tree = `<?xml version="1.0" encoding="UTF-8"?>
<swSolidWorks xmlns="http://www.solidworks.com/sw2003/schema">
 <swHeader>
  <swFile id="1" swDocType="ASSEMBLY" swPath="D:\\Model\\Top.SLDASM"/>
  <swFile id="2" swDocType="ASSEMBLY" swPath="D:\\Model\\Sub.SLDASM"/>
  <swFile id="3" swDocType="PART" swPath="D:\\Model\\Bolt.SLDPRT"/>
  <swFile id="4" swDocType="PART" swPath="D:\\Model\\Plate.SLDPRT"/>
 </swHeader>
 <swModelList>
  <swModel id="30" swName="Bolt" swFileRef="3"/>
  <swModel id="40" swName="Plate" swFileRef="4"/>
  <swModel id="20" swName="Sub" swFileRef="2">
   <swReference swName="Bolt" swReferenceNumber="1" swConfigurationName="M6" swSuppressed="NO" swHidden="NO" swModelRef="30"
     swTransform="0 1 0 0 -1 0 0 0 0 0 1 0 0.01 0 0 1"/>
  </swModel>
  <swModel id="10" swName="Top" swFileRef="1" swBoundingBox="-0.01 0 0 0.02 0.03 0.1">
   <swReference swName="Sub" swReferenceNumber="1" swSuppressed="NO" swHidden="NO" swModelRef="20"
     swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0.1 1"/>
   <swReference swName="Plate" swReferenceNumber="1" swSuppressed="NO" swHidden="NO" swModelRef="40"
     swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
   <swReference swName="Plate" swReferenceNumber="2" swSuppressed="YES" swHidden="NO" swModelRef="40"
     swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
   <swReference swName="Plate" swReferenceNumber="3" swSuppressed="NO" swHidden="YES" swModelRef="40"
     swTransform="1 0 0 0 0 1 0 0 0 0 1 0 0 0 0 1"/>
  </swModel>
 </swModelList>
 <swConfigurationList>
  <swConfiguration swName="Default" swMostRecentConfiguration="YES" swModelRef="10"/>
 </swConfigurationList>
</swSolidWorks>`;

const entries = [{ name: 'swXmlContents/COMPINSTANCETREE', offset: 0, data: Buffer.from(tree, 'utf8') }];

describe('assembly placements', () => {
  it('places every visible part occurrence through its sub-assemblies, in millimetres', () => {
    const result = readAssemblyTree(entries);
    assert.ok(result);
    assert.equal(result.suppressed, 1);
    assert.equal(result.hidden, 1);
    assert.deepEqual(
      result.instances.map((instance) => [instance.component, instance.path.join('/'), instance.configuration]),
      [
        ['Bolt.SLDPRT', 'Sub-1/Bolt-1', 'M6'],
        ['Plate.SLDPRT', 'Plate-1', ''],
      ],
    );
    // The bolt: turned 90° about Z and moved 10 mm along X inside the
    // sub-assembly, which is itself 100 mm up Z in the top level.
    const bolt = result.instances[0].matrix.map((value) => Math.round(value * 1e9) / 1e9);
    assert.deepEqual(bolt, [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 10, 0, 100, 1]);
  });

  it('names every file below the top — the relations a drop of many files is sorted by', () => {
    const result = readAssemblyTree(entries);
    assert.ok(result);
    assert.deepEqual(result.files, ['Sub.SLDASM', 'Bolt.SLDPRT', 'Plate.SLDPRT']);
    // SolidWorks' own extent of the assembly, metres in the file, millimetres here.
    assert.deepEqual(result.boundingBoxMm, [-10, 0, 0, 20, 30, 100]);
  });

  it('says so when a document has no component tree', () => {
    assert.equal(readAssemblyTree([]), null);
  });
});
