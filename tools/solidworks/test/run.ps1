<#
  Tests for SwConvert.cs, runnable on any OS with PowerShell 7 (pwsh):
      pwsh -NoProfile -File tools/solidworks/test/run.ps1
  1. Parses SwConvert.cs as C# 5 - the newest language the C# compiler built
     into Windows accepts - so a newer construct fails here, not on the user's PC.
  2. Compiles it with the stand-in and drives ConvertWith through every path.
#>
$ErrorActionPreference = 'Stop'
$here = $PSScriptRoot
$root = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
$source = Get-Content (Join-Path (Split-Path -Parent $here) 'SwConvert.cs') -Raw
$fake = Get-Content (Join-Path $here 'FakeSolidWorks.cs') -Raw
$failures = 0
function Expect([string]$Name, [bool]$Condition, [string]$Detail = '') {
  if ($Condition) { Write-Host ('  ok    ' + $Name) } else { Write-Host ('  FAIL  ' + $Name + ' :: ' + $Detail); $script:failures++ }
}

Write-Host 'SwConvert.cs'
$options = [Microsoft.CodeAnalysis.CSharp.CSharpParseOptions]::new([Microsoft.CodeAnalysis.CSharp.LanguageVersion]::CSharp5)
$tree = [Microsoft.CodeAnalysis.CSharp.CSharpSyntaxTree]::ParseText($source, $options)
$problems = @($tree.GetDiagnostics() | Where-Object { $_.Severity -eq 'Error' })
Expect 'parses as C# 5 (what csc.exe on Windows accepts)' ($problems.Count -eq 0) (($problems | ForEach-Object { $_.ToString() }) -join "`n")

# Two files become one compilation unit, so their using directives go first.
$usings = @(($source + "`n" + $fake) -split "`n" | Where-Object { $_ -match '^using [\w.]+;' } | ForEach-Object { $_.Trim() } | Sort-Object -Unique)
$bodies = (($source + "`n" + $fake) -split "`n" | Where-Object { $_ -notmatch '^using [\w.]+;' }) -join "`n"
Add-Type -TypeDefinition (($usings -join "`n") + "`n" + $bodies) -ReferencedAssemblies @('Microsoft.CSharp', 'System.Collections', 'System.Console', 'System.Diagnostics.Process', 'System.Net.Sockets', 'System.Net.Primitives', 'System.Threading', 'System.Threading.Thread', 'System.Runtime.InteropServices', 'System.ComponentModel.Primitives', 'System.Linq.Expressions') -IgnoreWarnings
Expect 'compiles' $true

$work = Join-Path ([IO.Path]::GetTempPath()) ('swconvert-test-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory $work | Out-Null
$step = Join-Path $root 'fixtures/cube.step'
$log = [System.Collections.Generic.List[string]]::new()
$logger = [Action[string]] { param($m) $log.Add($m) }

function Run([string]$Mode, [int]$Type = 1) {
  $sw = [FakeSolidWorks]::new(); $sw.Mode = $Mode; $sw.Step = $step
  $out = Join-Path $work ([guid]::NewGuid().ToString('N') + '.step')
  $err = $null
  try { [SwConvert]::ConvertWith($sw, (Join-Path $work 'dv-1.sldprt'), $out, $Type, $logger) } catch { $err = $_.Exception.InnerException; if (-not $err) { $err = $_.Exception } }
  return @{ Sw = $sw; Out = $out; Error = $err }
}

$r = Run 'ok'
Expect 'converts a part with by-reference arguments' ($null -eq $r.Error -and (Test-Path $r.Out)) "$($r.Error)"
Expect 'opens it silent and read-only' ($r.Sw.Calls -contains 'OpenDoc6|.sldprt|1|3') ($r.Sw.Calls -join ', ')
Expect 'closes the document it opened' ($r.Sw.Calls -contains 'QuitDoc|dv-1.sldprt') ($r.Sw.Calls -join ', ')

$r = Run 'ok' 2
Expect 'opens an assembly fully resolved, not lightweight' ($r.Sw.Calls -contains 'OpenDoc6|.sldprt|2|67') ($r.Sw.Calls -join ', ')

$r = Run 'opendoc6-throws'
Expect 'falls back to OpenDoc' ($null -eq $r.Error -and ($r.Sw.Calls -contains 'OpenDoc|.sldprt|1') -and (Test-Path $r.Out)) "$($r.Error)"

$r = Run 'saveas-throws'
Expect 'falls back to SaveAs3' ($null -eq $r.Error -and ($r.Sw.Calls -contains 'SaveAs3|3') -and (Test-Path $r.Out)) "$($r.Error)"

$r = Run 'open-null'
Expect 'explains a file from a newer SOLIDWORKS' ($null -ne $r.Error -and $r.Error.Message -match 'newer SOLIDWORKS') "$($r.Error)"

$r = Run 'no-output'
Expect 'reports a save that wrote nothing' ($null -ne $r.Error -and $r.Error.Message -match 'wrote no STEP') "$($r.Error)"

Remove-Item $work -Recurse -Force
if ($failures) { Write-Host "$failures failed"; exit 1 }
Write-Host 'all passed'
