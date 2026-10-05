<#
.SYNOPSIS
    Чинит установку надстройки IPS для Word (VSTO), которая падает с ошибкой
    "Ссылка в развертывании не соответствует удостоверению, определенному в манифесте приложения".

.DESCRIPTION
    1. Находит IPSWordAddIn.vsto в дистрибутиве IPS.
    2. Сверяет ссылку в .vsto с удостоверением в IPSWordAddIn.dll.manifest (именно это
       сравнение и дает ошибку) и показывает, что не совпадает.
    3. Закрывает Word (с подтверждением).
    4. Снимает блокировку "файл из интернета" с файлов дистрибутива.
    5. Удаляет следы прежней установки надстройки (HKCU + онлайн-кэш ClickOnce),
       предварительно выгрузив резервную копию ключей реестра.
    6. Если манифесты в дистрибутиве не согласованы - с вашего согласия делает
       исправленную копию надстройки в %LOCALAPPDATA% и подписывает ее локальным сертификатом.
    7. Устанавливает надстройку через VSTOInstaller с подробным логом. Если установка
       снова не удалась - предлагает сбросить хранилище ClickOnce и повторить.

    Весь вывод и диагностические файлы сохраняются в папку IPSWordAddIn-fix-<дата>
    на Рабочем столе.

.PARAMETER IpsPath
    Папка дистрибутива IPS (или сразу путь к файлу IPSWordAddIn.vsto).

.PARAMETER AddinName
    Имя надстройки (имя файла .vsto без расширения).

.PARAMETER CheckOnly
    Только диагностика, ничего не менять.

.EXAMPLE
    .\fix-ips-word-addin.ps1
.EXAMPLE
    .\fix-ips-word-addin.ps1 -IpsPath "D:\Дистрибутивы\IPS\10\IPS.Installer.Full"
#>
[CmdletBinding()]
param(
    [string]$IpsPath = 'C:\instal\IPS\10\IPS.Installer.Full',
    [string]$AddinName = 'IPSWordAddIn',
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

$IdentityAttrs = @('name', 'version', 'publicKeyToken', 'language', 'processorArchitecture', 'type')
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$IsWin = [Environment]::OSVersion.Platform -eq 'Win32NT'
$script:ExitCode = 0

# ---------------------------------------------------------------- вывод

function Write-Step([string]$Text) { Write-Host ''; Write-Host "=== $Text ===" -ForegroundColor Cyan }
function Write-Ok([string]$Text)   { Write-Host "[OK] $Text" -ForegroundColor Green }
function Write-Warn2([string]$Text) { Write-Host "[!]  $Text" -ForegroundColor Yellow }
function Write-Bad([string]$Text)  { Write-Host "[X]  $Text" -ForegroundColor Red }
function Write-Info([string]$Text) { Write-Host "     $Text" }

function Confirm-Action([string]$Question) {
    $answer = Read-Host "$Question [Д/н]"
    return ($answer -eq '' -or $answer -match '^[ДдYy]')
}

# ---------------------------------------------------------------- манифесты

function Read-Xml([string]$Path) {
    $doc = New-Object System.Xml.XmlDocument
    $doc.PreserveWhitespace = $true
    $doc.Load($Path)
    return $doc
}

function Find-VstoFile([string]$Root, [string]$Name) {
    if ([string]::IsNullOrWhiteSpace($Root) -or -not (Test-Path -LiteralPath $Root)) { return $null }
    if ((Test-Path -LiteralPath $Root -PathType Leaf) -and $Root -like '*.vsto') {
        return (Resolve-Path -LiteralPath $Root).ProviderPath
    }
    $all = @(Get-ChildItem -LiteralPath $Root -Recurse -File -Filter "$Name.vsto" -ErrorAction SilentlyContinue)
    if ($all.Count -eq 0) { return $null }
    if ($all.Count -gt 1) {
        Write-Info 'Найдено несколько вариантов надстройки:'
        $all | ForEach-Object { Write-Info "  $($_.FullName)" }
    }
    # Установщик IPS ставит вариант из папки Word2013 (он работает и в Word 2016/2019/2021/365)
    $preferred = @($all | Where-Object { $_.FullName -match '[\\/]Word2013[\\/]' })
    if ($preferred.Count -gt 0) { return $preferred[0].FullName }
    return $all[0].FullName
}

# Ссылка на манифест приложения внутри .vsto
function Get-ManifestReference([xml]$VstoXml) {
    return $VstoXml.SelectSingleNode("//*[local-name()='dependentAssembly'][@codebase]")
}

# Собственное удостоверение манифеста (первый assemblyIdentity под корнем)
function Get-RootIdentity([xml]$Xml) {
    return $Xml.SelectSingleNode("/*/*[local-name()='assemblyIdentity']")
}

function Resolve-Codebase([string]$VstoPath, [string]$Codebase) {
    $uri = $null
    if ([Uri]::TryCreate($Codebase, [UriKind]::Absolute, [ref]$uri) -and $uri.IsFile) { return $uri.LocalPath }
    $relative = [Uri]::UnescapeDataString($Codebase)
    if ([IO.Path]::DirectorySeparatorChar -ne '\') { $relative = $relative -replace '\\', '/' }
    return (Join-Path (Split-Path -Parent $VstoPath) $relative)
}

function Get-Digest([byte[]]$Bytes, [string]$Algorithm) {
    if ($Algorithm -match 'sha256') { $hasher = [Security.Cryptography.SHA256]::Create() }
    else { $hasher = [Security.Cryptography.SHA1]::Create() }
    try { return [Convert]::ToBase64String($hasher.ComputeHash($Bytes)) }
    finally { $hasher.Dispose() }
}

function Test-AddinManifests([string]$VstoPath) {
    $result = [pscustomobject]@{
        ManifestPath = $null
        Blocking     = New-Object System.Collections.Generic.List[string]
        Warnings     = New-Object System.Collections.Generic.List[string]
    }

    $vstoXml = Read-Xml $VstoPath
    $dep = Get-ManifestReference $vstoXml
    if (-not $dep) {
        $result.Blocking.Add("В $VstoPath нет ссылки на манифест приложения (dependentAssembly).")
        return $result
    }
    $manifestPath = Resolve-Codebase $VstoPath $dep.GetAttribute('codebase')
    $result.ManifestPath = $manifestPath
    Write-Info "Манифест развертывания: $VstoPath"
    Write-Info "Манифест приложения:    $manifestPath"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        $result.Blocking.Add("Файл манифеста приложения не найден: $manifestPath")
        return $result
    }

    $manifestXml = Read-Xml $manifestPath
    $ref = $dep.SelectSingleNode("*[local-name()='assemblyIdentity']")
    $own = Get-RootIdentity $manifestXml
    if (-not $ref -or -not $own) {
        $result.Blocking.Add('Не удалось прочитать assemblyIdentity из манифестов.')
        return $result
    }

    Write-Host ''
    Write-Host ('     {0,-22} {1,-36} {2}' -f 'Поле', 'Ожидает .vsto', 'В .dll.manifest')
    foreach ($attr in $IdentityAttrs) {
        $expected = $ref.GetAttribute($attr)
        $actual = $own.GetAttribute($attr)
        $line = '     {0,-22} {1,-36} {2}' -f $attr, $expected, $actual
        if ($expected -eq $actual) { Write-Host $line }
        else {
            Write-Host "$line   <-- НЕ СОВПАДАЕТ" -ForegroundColor Red
            $result.Blocking.Add("$attr`: .vsto ожидает '$expected', а в манифесте '$actual'")
        }
    }

    $bytes = [IO.File]::ReadAllBytes($manifestPath)
    $digest = $dep.SelectSingleNode(".//*[local-name()='DigestValue']")
    $method = $dep.SelectSingleNode(".//*[local-name()='DigestMethod']")
    if ($digest -and $method) {
        $actualDigest = Get-Digest $bytes $method.GetAttribute('Algorithm')
        if ($actualDigest -cne $digest.InnerText.Trim()) {
            $result.Warnings.Add('Хэш манифеста приложения не совпадает с записанным в .vsto: файл изменен или взят из другой сборки.')
        }
    }
    if ($dep.HasAttribute('size') -and $dep.GetAttribute('size') -ne [string]$bytes.Length) {
        $result.Warnings.Add("Размер манифеста приложения ($($bytes.Length) байт) не совпадает с записанным в .vsto ($($dep.GetAttribute('size'))).")
    }

    # Все ли файлы, перечисленные в манифесте приложения, на месте
    $manifestDir = Split-Path -Parent $manifestPath
    $listed = @()
    $listed += @($manifestXml.SelectNodes("//*[local-name()='dependentAssembly'][@dependencyType='install'][@codebase]") | ForEach-Object { $_.GetAttribute('codebase') })
    $listed += @($manifestXml.SelectNodes("/*/*[local-name()='file'][@name]") | ForEach-Object { $_.GetAttribute('name') })
    foreach ($file in $listed) {
        $path = Resolve-Codebase $manifestPath $file
        if (-not (Test-Path -LiteralPath $path) -and -not (Test-Path -LiteralPath "$path.deploy")) {
            $result.Warnings.Add("Нет файла, перечисленного в манифесте: $file (ожидался в $manifestDir)")
        }
    }
    return $result
}

# Приводит ссылку в .vsto к фактическому удостоверению манифеста приложения
# и пересчитывает размер и хэш (то же самое делает mage.exe -Update).
function Update-VstoReference([string]$VstoPath) {
    $doc = Read-Xml $VstoPath
    $dep = Get-ManifestReference $doc
    $manifestPath = Resolve-Codebase $VstoPath $dep.GetAttribute('codebase')
    $ref = $dep.SelectSingleNode("*[local-name()='assemblyIdentity']")
    $own = Get-RootIdentity (Read-Xml $manifestPath)
    foreach ($attr in $IdentityAttrs) {
        if ($own.HasAttribute($attr)) { $ref.SetAttribute($attr, $own.GetAttribute($attr)) }
        elseif ($ref.HasAttribute($attr)) { $ref.RemoveAttribute($attr) }
    }
    $bytes = [IO.File]::ReadAllBytes($manifestPath)
    if ($dep.HasAttribute('size')) { $dep.SetAttribute('size', [string]$bytes.Length) }
    $digest = $dep.SelectSingleNode(".//*[local-name()='DigestValue']")
    $method = $dep.SelectSingleNode(".//*[local-name()='DigestMethod']")
    if ($digest) {
        $algorithm = ''
        if ($method) { $algorithm = $method.GetAttribute('Algorithm') }
        $digest.InnerText = Get-Digest $bytes $algorithm
    }
    $doc.Save($VstoPath)
}

# Переподписывает .vsto: после правки старая подпись недействительна
function Set-VstoSignature([string]$VstoPath) {
    try {
        Add-Type -AssemblyName 'Microsoft.Build.Tasks.v4.0, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b03f5f7f11d50a3a'
    }
    catch {
        Add-Type -Path (Join-Path ([Runtime.InteropServices.RuntimeEnvironment]::GetRuntimeDirectory()) 'Microsoft.Build.Tasks.v4.0.dll')
    }
    # Ключ в CSP (а не CNG): подпись манифестов ClickOnce в .NET Framework работает только с ним
    $cert = New-SelfSignedCertificate -Type CodeSigningCert -Subject "CN=$AddinName local repair" `
        -CertStoreLocation 'Cert:\CurrentUser\My' `
        -Provider 'Microsoft Enhanced RSA and AES Cryptographic Provider' -KeySpec Signature `
        -KeyLength 2048 -HashAlgorithm SHA256 -NotAfter (Get-Date).AddYears(20)
    try {
        [Microsoft.Build.Tasks.Deployment.ManifestUtilities.SecurityUtilities]::SignFile($cert, $null, $VstoPath)
    }
    finally {
        # Сертификат больше не нужен: VSTO запоминает открытый ключ в списке доверия
        Remove-Item -LiteralPath "Cert:\CurrentUser\My\$($cert.Thumbprint)" -DeleteKey -ErrorAction SilentlyContinue
    }
}

function New-RepairedAddinCopy([string]$VstoPath) {
    $srcDir = Split-Path -Parent $VstoPath
    $dstDir = Join-Path $env:LOCALAPPDATA "$AddinName-repaired"
    if (Test-Path -LiteralPath $dstDir) {
        Rename-Item -LiteralPath $dstDir -NewName "$AddinName-repaired.old-$Stamp"
    }
    Copy-Item -LiteralPath $srcDir -Destination $dstDir -Recurse
    Get-ChildItem -LiteralPath $dstDir -Recurse -File | Unblock-File
    $newVsto = Join-Path $dstDir (Split-Path -Leaf $VstoPath)
    Update-VstoReference $newVsto
    Set-VstoSignature $newVsto
    Write-Ok "Исправленная копия надстройки: $dstDir"
    return $newVsto
}

# ---------------------------------------------------------------- окружение

function Find-VstoInstaller {
    foreach ($base in @($env:CommonProgramW6432, $env:CommonProgramFiles, ${env:CommonProgramFiles(x86)})) {
        if (-not $base) { continue }
        $candidate = Join-Path $base 'microsoft shared\VSTO\10.0\VSTOInstaller.exe'
        if (Test-Path -LiteralPath $candidate) { return $candidate }
    }
    return $null
}

function Get-RegValue([string]$Path, [string]$Name) {
    $item = Get-ItemProperty -LiteralPath $Path -ErrorAction SilentlyContinue
    if ($item -and $item.PSObject.Properties[$Name]) { return $item.$Name }
    return $null
}

function Show-Environment {
    $release = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\NET Framework Setup\NDP\v4\Full' 'Release'
    if (-not $release) { Write-Bad '.NET Framework 4.x не найден. Установите .NET Framework 4.8.' }
    elseif ($release -ge 528040) { Write-Ok '.NET Framework 4.8 или новее.' }
    else { Write-Warn2 ".NET Framework старше 4.8 (Release=$release). Рекомендуется обновить до 4.8." }

    $vstor = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\VSTO Runtime Setup\v4R' 'Version'
    if (-not $vstor) { $vstor = Get-RegValue 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VSTO Runtime Setup\v4R' 'Version' }
    if ($vstor) { Write-Ok "Visual Studio Tools for Office Runtime $vstor." }
    else { Write-Warn2 'Не найдена запись о Visual Studio Tools for Office Runtime.' }

    $platform = Get-RegValue 'HKLM:\SOFTWARE\Microsoft\Office\ClickToRun\Configuration' 'Platform'
    if ($platform) { Write-Info "Разрядность Office: $platform" }
}

function Close-Word {
    if (@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue).Count -eq 0) {
        Write-Ok 'Word не запущен.'
        return
    }
    Write-Warn2 'Word запущен. Сохраните документы и закройте Word.'
    while (@(Get-Process -Name WINWORD -ErrorAction SilentlyContinue).Count -gt 0) {
        $answer = Read-Host 'Нажмите Enter, когда закроете Word, или введите К, чтобы закрыть его принудительно (несохраненное пропадет)'
        if ($answer -match '^[КкKk]') {
            Get-Process -Name WINWORD -ErrorAction SilentlyContinue | Stop-Process -Force
            Start-Sleep -Seconds 2
        }
    }
    Write-Ok 'Word закрыт.'
}

# ---------------------------------------------------------------- очистка

function Backup-Registry([string]$WorkDir) {
    foreach ($key in @('HKCU\Software\Microsoft\Office\Word\Addins', 'HKCU\Software\Microsoft\VSTO')) {
        if (Test-Path -LiteralPath ('Registry::HKEY_CURRENT_USER' + $key.Substring(4))) {
            $file = Join-Path $WorkDir (($key -replace '[\\ ]', '_') + '.reg')
            & reg.exe export $key $file /y | Out-Null
            Write-Ok "Резервная копия $key -> $file"
        }
    }
}

# Адреса .vsto, с которых надстройка уже была установлена
function Get-InstalledManifests {
    $found = @()
    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Office\Word\Addins')
    if ($key) {
        foreach ($name in $key.GetSubKeyNames()) {
            $sub = $key.OpenSubKey($name)
            $manifest = [string]$sub.GetValue('Manifest')
            $sub.Close()
            if ($manifest -like "*$AddinName*") { $found += ($manifest -replace '\|vstolocal$', '') }
        }
        $key.Close()
    }
    return $found
}

function Uninstall-Previous([string]$Installer, [string[]]$Manifests) {
    foreach ($manifest in ($Manifests | Select-Object -Unique)) {
        Write-Info "Удаление прежней установки: $manifest"
        $process = Start-Process -FilePath $Installer -ArgumentList @('/u', "`"$manifest`"", '/s') -Wait -PassThru
        Write-Info "  код возврата $($process.ExitCode) (ненулевой код - норма, если надстройка не была установлена)"
    }
}

function Remove-AddinRegistry {
    $hkcu = [Microsoft.Win32.Registry]::CurrentUser

    $key = $hkcu.OpenSubKey('Software\Microsoft\Office\Word\Addins', $true)
    if ($key) {
        foreach ($name in $key.GetSubKeyNames()) {
            $sub = $key.OpenSubKey($name)
            $manifest = [string]$sub.GetValue('Manifest')
            $sub.Close()
            if ($name -like "*$AddinName*" -or $manifest -like "*$AddinName*") {
                $key.DeleteSubKeyTree($name)
                Write-Ok "Удален ключ HKCU\...\Word\Addins\$name"
            }
        }
        $key.Close()
    }

    $key = $hkcu.OpenSubKey('Software\Microsoft\VSTO\SolutionMetadata', $true)
    if ($key) {
        foreach ($valueName in $key.GetValueNames()) {
            if ($valueName -like "*$AddinName*") {
                $guid = [string]$key.GetValue($valueName)
                $key.DeleteValue($valueName, $false)
                if ($guid) { $key.DeleteSubKeyTree($guid, $false) }
                Write-Ok "Удалены метаданные VSTO для $valueName"
            }
        }
        $key.Close()
    }

    $key = $hkcu.OpenSubKey('Software\Microsoft\VSTO\Security\Inclusion', $true)
    if ($key) {
        foreach ($name in $key.GetSubKeyNames()) {
            $sub = $key.OpenSubKey($name)
            $url = [string]$sub.GetValue('Url')
            $sub.Close()
            if ($url -like "*$AddinName*") {
                $key.DeleteSubKeyTree($name, $false)
                Write-Ok "Удалена запись доверия VSTO для $url"
            }
        }
        $key.Close()
    }

    # Регистрацию для всех пользователей не трогаем, только сообщаем о ней
    foreach ($path in @('HKLM:\SOFTWARE\Microsoft\Office\Word\Addins', 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Office\Word\Addins')) {
        if (-not (Test-Path -LiteralPath $path)) { continue }
        Get-ChildItem -LiteralPath $path | Where-Object { $_.PSChildName -like "*$AddinName*" } | ForEach-Object {
            Write-Warn2 "Надстройка также зарегистрирована для всех пользователей: $($_.Name) (не изменялось)"
        }
    }
}

function Clear-ClickOnceOnlineCache {
    Get-Process -Name dfsvc -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Process -FilePath 'rundll32.exe' -ArgumentList 'dfshim.dll,CleanOnlineAppCache' -Wait
    Write-Ok 'Онлайн-кэш ClickOnce очищен.'
}

function Reset-ClickOnceStore {
    Get-Process -Name dfsvc -ErrorAction SilentlyContinue | Stop-Process -Force
    $store = Join-Path $env:LOCALAPPDATA 'Apps\2.0'
    if (-not (Test-Path -LiteralPath $store)) { Write-Info 'Хранилище ClickOnce пустое.'; return }
    Rename-Item -LiteralPath $store -NewName "2.0.bak-$Stamp"
    Write-Ok "Хранилище ClickOnce отложено в $store.bak-$Stamp (можно вернуть переименованием)."
}

# ---------------------------------------------------------------- установка

function Install-Addin([string]$Installer, [string]$VstoPath, [string]$WorkDir) {
    $env:VSTO_SUPPRESSDISPLAYALERTS = '0'
    $env:VSTO_LOGALERTS = '1'
    $started = Get-Date
    Write-Info "Установка: $VstoPath"
    Write-Info 'Если появится вопрос о доверии издателю - нажмите "Установить".'
    $process = Start-Process -FilePath $Installer -ArgumentList @('/i', "`"$VstoPath`"") -Wait -PassThru

    $logs = @(Get-ChildItem -LiteralPath (Split-Path -Parent $VstoPath) -Filter '*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $started.AddSeconds(-5) })
    foreach ($log in $logs) {
        Copy-Item -LiteralPath $log.FullName -Destination (Join-Path $WorkDir "install-$Stamp-$($log.Name)") -Force
        Write-Info "Лог VSTO ($($log.FullName)):"
        Get-Content -LiteralPath $log.FullName -Tail 30 | ForEach-Object { Write-Info "  $_" }
    }

    if ($process.ExitCode -eq 0) {
        Write-Ok 'Надстройка установлена.'
        return $true
    }
    Write-Bad "Установка не удалась (код $($process.ExitCode))."
    return $false
}

# ---------------------------------------------------------------- основной сценарий

function Invoke-Main([string]$WorkDir) {
    Write-Step '1. Поиск надстройки'
    $vsto = Find-VstoFile $IpsPath $AddinName
    while (-not $vsto) {
        Write-Warn2 "Не найден $AddinName.vsto в '$IpsPath'."
        $script:IpsPath = (Read-Host 'Укажите папку дистрибутива IPS или путь к .vsto (пусто - выход)').Trim('" ')
        if (-not $IpsPath) { $script:ExitCode = 1; return }
        $vsto = Find-VstoFile $IpsPath $AddinName
    }
    Write-Ok "Найдено: $vsto"

    Write-Step '2. Проверка манифестов'
    $check = Test-AddinManifests $vsto
    Copy-Item -LiteralPath $vsto -Destination $WorkDir -Force
    if ($check.ManifestPath -and (Test-Path -LiteralPath $check.ManifestPath)) {
        Copy-Item -LiteralPath $check.ManifestPath -Destination $WorkDir -Force
    }
    foreach ($warning in $check.Warnings) { Write-Warn2 $warning }
    if ($check.Blocking.Count -eq 0) {
        Write-Ok 'Удостоверения совпадают: сами файлы в порядке, причина в остатках прежней установки.'
    }
    else {
        Write-Bad 'Манифесты в дистрибутиве не согласованы между собой - это и есть причина ошибки:'
        foreach ($problem in $check.Blocking) { Write-Info "- $problem" }
    }

    if (-not $IsWin) { Write-Warn2 'Дальнейшие шаги выполняются только в Windows.'; return }

    Write-Step '3. Проверка окружения'
    Show-Environment
    $installer = Find-VstoInstaller
    if (-not $installer) {
        Write-Bad 'Не найден VSTOInstaller.exe - не установлен Visual Studio Tools for Office Runtime.'
        $setup = @(Get-ChildItem -LiteralPath (Split-Path -Parent $vsto) -Filter 'vstor*.exe' -Recurse -File -ErrorAction SilentlyContinue)
        if ($setup.Count -eq 0 -and (Test-Path -LiteralPath $IpsPath -PathType Container)) {
            $setup = @(Get-ChildItem -LiteralPath $IpsPath -Filter 'vstor*.exe' -Recurse -File -ErrorAction SilentlyContinue)
        }
        if ($setup.Count -gt 0 -and (Confirm-Action "Запустить установщик среды $($setup[0].FullName)?")) {
            Start-Process -FilePath $setup[0].FullName -Wait
            $installer = Find-VstoInstaller
        }
        if (-not $installer) {
            Write-Info 'Скачайте и установите "Microsoft Visual Studio 2010 Tools for Office Runtime" с сайта Microsoft и запустите скрипт снова.'
            $script:ExitCode = 3
            return
        }
    }
    Write-Ok "VSTOInstaller: $installer"

    if ($CheckOnly) { Write-Info 'Режим -CheckOnly: изменения не вносились.'; return }

    Write-Step '4. Закрытие Word'
    Close-Word

    Write-Step '5. Снятие блокировки файлов'
    $unblockRoot = Split-Path -Parent $vsto
    if (Test-Path -LiteralPath $IpsPath -PathType Container) { $unblockRoot = $IpsPath }
    Get-ChildItem -LiteralPath $unblockRoot -Recurse -File | Unblock-File
    Write-Ok "Файлы в $unblockRoot разблокированы."

    Write-Step '6. Удаление следов прежней установки'
    Backup-Registry $WorkDir
    $previous = @(Get-InstalledManifests) + @($vsto)
    Uninstall-Previous $installer $previous
    Remove-AddinRegistry
    Clear-ClickOnceOnlineCache

    $target = $vsto
    if ($check.Blocking.Count -gt 0) {
        Write-Step '6a. Исправление дистрибутива'
        Write-Info 'В дистрибутиве .vsto ссылается не на тот манифест, что лежит рядом с ним.'
        Write-Info 'Могу сделать исправленную копию надстройки в %LOCALAPPDATA%: ссылка в .vsto будет'
        Write-Info 'приведена к фактическому манифесту, а .vsto переподписан локальным сертификатом.'
        Write-Info 'При установке Word спросит про неизвестного издателя - нужно нажать "Установить".'
        Write-Info 'Надежнее всего - взять у поставщика IPS полностью новый дистрибутив.'
        if (-not (Confirm-Action 'Сделать исправленную копию и установить ее?')) {
            Write-Info 'Отменено. Возьмите новый дистрибутив целиком или передайте поставщику папку с логами.'
            $script:ExitCode = 2
            return
        }
        $target = New-RepairedAddinCopy $vsto
    }

    Write-Step '7. Установка надстройки'
    $installed = Install-Addin $installer $target $WorkDir
    if (-not $installed) {
        Write-Info 'Можно сбросить хранилище ClickOnce текущего пользователя (папка будет не удалена, а переименована).'
        Write-Info 'Другие ClickOnce-программы этого пользователя, если они есть, может понадобиться переустановить.'
        if (Confirm-Action 'Сбросить хранилище ClickOnce и повторить установку?') {
            Reset-ClickOnceStore
            $installed = Install-Addin $installer $target $WorkDir
        }
    }

    if ($installed) {
        Write-Step 'Готово'
        Write-Info 'Запустите Word и проверьте вкладку IPS.'
        Write-Info 'Если вы запускали полный установщик IPS - теперь можно запустить его снова.'
    }
    else {
        Write-Step 'Не получилось'
        Write-Info "Отправьте содержимое папки $WorkDir в поддержку IPS (или пришлите мне fix.log)."
        $script:ExitCode = 4
    }
}

if ($MyInvocation.InvocationName -ne '.') {
    $desktop = [Environment]::GetFolderPath('Desktop')
    if (-not $desktop) { $desktop = [IO.Path]::GetTempPath() }
    $workDir = Join-Path $desktop "IPSWordAddIn-fix-$Stamp"
    New-Item -ItemType Directory -Path $workDir -Force | Out-Null
    Start-Transcript -Path (Join-Path $workDir 'fix.log') | Out-Null
    try { Invoke-Main $workDir }
    catch {
        Write-Bad "Непредвиденная ошибка: $($_.Exception.Message)"
        Write-Info $_.ScriptStackTrace
        $script:ExitCode = 99
    }
    Write-Host ''
    Write-Info "Лог и диагностика: $workDir"
    Stop-Transcript | Out-Null
    exit $script:ExitCode
}
