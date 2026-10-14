import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bestLocated, commonFolder, locationScore, pathSegments, relativeFolder } from '@docuview/shared';

/**
 * Telling the right copy of a part from another with the same name, from the
 * paths SolidWorks recorded. The cases are the shapes met in real projects: a
 * PDM vault whose library sits beside the projects, and two versions of one
 * project side by side with identical file names.
 */

const vault = 'c:\\IPS Vault\\4\\Workspace\\АШТ 2023\\АШТ 2023\\storage\\storage-1';
const assemblyRecorded = `${vault}\\Проекты 2023\\АШТ\\Сборочные еденицы\\ОТС 301412.018-01 Панель лицевая PLM.SLDASM`;
const handleRecorded = `${vault}\\Библиотека\\Ручка\\Ручка RAF_8357-1032-A PLM.SLDPRT`;

describe('recorded locations', () => {
  it('reads Windows and browser paths alike', () => {
    assert.deepEqual(pathSegments('c:\\a\\b/c.SLDPRT'), ['c:', 'a', 'b', 'c.SLDPRT']);
    assert.deepEqual(pathSegments('/a//b/./c'), ['a', 'b', 'c']);
  });

  it('finds the way from an assembly to its part, and the folder holding them all', () => {
    assert.deepEqual(relativeFolder(assemblyRecorded, handleRecorded), ['..', '..', '..', 'Библиотека', 'Ручка']);
    assert.deepEqual(relativeFolder('D:\\3д модель\\Top.SLDASM', 'D:\\3д модель\\Part.SLDPRT'), []);
    assert.equal(relativeFolder('D:\\a\\Top.SLDASM', 'E:\\b\\Part.SLDPRT'), null);
    assert.equal(commonFolder([assemblyRecorded, handleRecorded]).at(-1), 'storage-1');
  });

  it('prefers the copy where the assembly says it is, walked from where the assembly is now', () => {
    // Dropped: the whole "Исходно" folder, with an older copy of the handle elsewhere.
    const assemblyHere = 'Исходно/АШТ 2023/АШТ 2023/storage/storage-1/Проекты 2023/АШТ/Сборочные еденицы/ОТС 301412.018-01 Панель лицевая PLM.SLDASM';
    const right = 'Исходно/АШТ 2023/АШТ 2023/storage/storage-1/Библиотека/Ручка/Ручка RAF_8357-1032-A PLM.SLDPRT';
    const stray = 'Исходно/Архив/Ручка RAF_8357-1032-A PLM.SLDPRT';
    const where = { recorded: handleRecorded, assemblyRecorded, assemblyHere };
    assert.ok(locationScore(right, where) > locationScore(stray, where));
    assert.equal(bestLocated([stray, right], (p) => p, where), right);
  });

  it('keeps two versions of one project apart', () => {
    const recorded = 'D:\\3д модель\\BT100.01.01.101.SLDPRT';
    const v1 = 'Boolbotron/в1/0000000000/3д модель/BT100.01.01.101.SLDPRT';
    const v2 = 'Boolbotron/в2/3д модель/BT100.01.01.101.SLDPRT';
    // Opened from в2: its own part, not the one from в1.
    const where = {
      recorded,
      assemblyRecorded: 'D:\\3д модель\\BT100.00.00.000.SLDASM',
      assemblyHere: 'Boolbotron/в2/3д модель/BT100.00.00.000.SLDASM',
    };
    assert.equal(bestLocated([v1, v2], (p) => p, where), v2);
    // Without knowing where the assembly is, the recorded folders still count.
    assert.equal(bestLocated(['x/other/BT100.01.01.101.SLDPRT', v2], (p) => p, { recorded }), v2);
  });
});
