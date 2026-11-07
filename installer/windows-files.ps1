param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet('validate', 'prepare', 'commit', 'finish', 'rollback', 'uninstall')]
    [string] $Action
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')

$manifestName = '.betterkugou-files.json'
$transactionName = 'transaction.json'
$committedName = 'committed.json'
$maxRecordBytes = 4194304
$utf8 = [Text.UTF8Encoding]::new($false, $true)
$utf16 = [Text.UnicodeEncoding]::new($false, $false)
$machine = $env:BK_INSTALL_MODE -eq 'all'
$registered = $env:BK_INSTALL_EXISTING -eq '1'

function Assert-PathSegment([string] $Segment) {
    if (!$Segment -or $Segment -match '[<>:"/\\|?*\x00-\x1f]|[ .]$|~[0-9]' -or
        $Segment -match '^(CON|PRN|AUX|NUL|COM[0-9\u00b9\u00b2\u00b3]|LPT[0-9\u00b9\u00b2\u00b3]|CONIN\$|CONOUT\$)(\.|$)') {
        throw "无效的文件或文件夹名称。$Segment"
    }
}

function Get-AbsolutePath([string] $Path) {
    if ($Path -notmatch '^[a-z]:\\[^\\]') {
        throw '请选择本地 Windows 驱动器上的完整路径。'
    }
    $Path = $Path.TrimEnd('\')
    foreach ($segment in $Path.Substring(3).Split('\')) {
        Assert-PathSegment $segment
    }
    return [IO.Path]::GetFullPath($Path)
}

function Get-Attributes([string] $Path) {
    try {
        return [IO.File]::GetAttributes($Path)
    } catch [IO.FileNotFoundException], [IO.DirectoryNotFoundException] {
        return $null
    }
}

function Assert-DirectoryPath([string] $Path) {
    # Inspect ancestors from the drive down before resolving any child.
    $root = [IO.Path]::GetPathRoot($Path)
    $current = $root
    foreach ($segment in $Path.Substring($root.Length).Split('\')) {
        if (!$segment) { continue }
        $current = [IO.Path]::Combine($current, $segment)
        $attributes = Get-Attributes $current
        if ($null -eq $attributes) { return }
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -or
            !($attributes -band [IO.FileAttributes]::Directory)) {
            throw "安装路径包含链接或非文件夹项目。$current"
        }
    }
}

function Assert-ProtectedDirectory([string] $Path) {
    if (!$machine -or ![IO.Directory]::Exists($Path)) { return }
    $acl = Get-Acl -LiteralPath $Path
    $sid = [Security.Principal.SecurityIdentifier]
    $trusted = @(
        'S-1-5-18',
        'S-1-5-32-544',
        'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
    )
    $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $owner = $acl.GetOwner($sid)
    if ($null -eq $descriptor.DiscretionaryAcl -or $null -eq $owner -or $owner.Value -notin $trusted) {
        throw "无法验证全局安装目录的所有者或访问权限。$Path"
    }
    foreach ($rule in $acl.GetAccessRules($true, $true, $sid)) {
        # File and directory writes, deletion, attribute changes and ACL ownership.
        if ($rule.AccessControlType -eq 'Allow' -and ($rule.FileSystemRights -band 0x500D0156) -and
            $rule.IdentityReference.Value -notin $trusted -and
            !($rule.IdentityReference.Value -eq 'S-1-3-0' -and
              ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly))) {
            throw "普通用户可以修改全局安装目录。$Path"
        }
    }
}

function Assert-TargetLocation {
    $drive = [IO.DriveInfo]::new([IO.Path]::GetPathRoot($target))
    if ($drive.DriveType -notin @('Fixed', 'Removable')) {
        throw '安装位置必须在本地固定或可移动驱动器上。'
    }
    Assert-DirectoryPath $target
    if ($machine) {
        $machineRoots = @($env:BK_INSTALL_MACHINE_ROOT, $env:BK_INSTALL_MACHINE_ROOT_X86) |
            Where-Object { $_ } | ForEach-Object { Get-AbsolutePath $_ }
        if ($parent -notin $machineRoots) {
            throw '全局安装位置必须是 Windows Program Files 的直接子目录。'
        }
        if ((!$registered -and [IO.Path]::GetFileName($target) -ne [IO.Path]::GetFileNameWithoutExtension($appExe)) -or
            [IO.Path]::GetFileName($target) -eq 'Common Files' -or
            $target -in @([Environment]::GetFolderPath('CommonProgramFiles'), [Environment]::GetFolderPath('CommonProgramFilesX86'))) {
            throw '请选择 BetterKuGou 的专用全局安装目录。'
        }
        Assert-ProtectedDirectory $parent
        Assert-ProtectedDirectory $target
        return
    }

    $systemRoots = @(
        $env:windir, $env:ProgramData, $env:ProgramFiles, $env:ProgramW6432,
        [Environment]::GetEnvironmentVariable('ProgramFiles(x86)'),
        $env:BK_INSTALL_MACHINE_ROOT, $env:BK_INSTALL_MACHINE_ROOT_X86
    )
    foreach ($root in $systemRoots) {
        if ($root -and ($target -eq $root -or
                $target.StartsWith($root.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase))) {
            throw '请在 Windows 和 Program Files 目录之外选择专用安装位置。'
        }
    }
    $personalRoots = @(
        $env:USERPROFILE, $env:PUBLIC, $env:APPDATA, $env:LOCALAPPDATA,
        [Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('MyDocuments'),
        [Environment]::GetFolderPath('MyMusic'), [Environment]::GetFolderPath('MyPictures'),
        [Environment]::GetFolderPath('MyVideos')
    )
    if ($env:USERPROFILE) {
        $personalRoots += [IO.Path]::GetDirectoryName($env:USERPROFILE)
        $personalRoots += [IO.Path]::Combine($env:USERPROFILE, 'Downloads')
    }
    if ($target -in $personalRoots -or
        ($env:USERPROFILE -and $parent -eq [IO.Path]::GetDirectoryName($env:USERPROFILE))) {
        throw '请在此文件夹内选择一个专用的安装子目录。'
    }
}

function Test-OrdinaryFile([string] $Path) {
    $attributes = Get-Attributes $Path
    if ($null -eq $attributes) { return $false }
    if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) {
        throw "预期位置必须是普通文件。$Path"
    }
    return $true
}

function Read-Record([string] $Path) {
    if (!(Test-OrdinaryFile $Path) -or [IO.FileInfo]::new($Path).Length -gt $maxRecordBytes) {
        throw "安装记录缺失或无效。$Path"
    }
    return [IO.File]::ReadAllText($Path, $utf8) | ConvertFrom-Json
}

function Write-Record([string] $Path, $Record) {
    $bytes = $utf8.GetBytes(($Record | ConvertTo-Json -Compress -Depth 4))
    if ($bytes.Length -gt $maxRecordBytes) { throw '安装文件清单超过大小限制。' }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write)
    try {
        $stream.Write($bytes, 0, $bytes.Length)
        $stream.Flush($true)
    } finally {
        $stream.Dispose()
    }
}

function Assert-RecordId([string] $Id) {
    if ($Id -notmatch '^[a-f0-9]{32}$') { throw '安装记录标识无效。' }
}

function Get-Transaction {
    if ($null -eq (Get-Attributes $workspace)) { return $null }
    Assert-DirectoryPath $workspace
    Assert-ProtectedDirectory $workspace
    $record = Read-Record ([IO.Path]::Combine($workspace, $transactionName))
    if ($record.product -ne 'BetterKuGou' -or $record.target -ne $target) {
        throw "无法识别安装工作目录，其中的文件已保留。$workspace"
    }
    Assert-RecordId $record.id
    Assert-Version $record.version
    foreach ($entry in [IO.Directory]::GetFileSystemEntries($workspace)) {
        if ([IO.Path]::GetFileName($entry) -notin @($transactionName, $committedName)) {
            throw "安装工作目录含有未知文件，其中的文件已保留。$workspace"
        }
    }
    $newPath = "$target.BetterKuGou-new-$($record.id)"
    $oldPath = "$target.BetterKuGou-old-$($record.id)"
    Assert-DirectoryPath $newPath
    Assert-DirectoryPath $oldPath
    Assert-ProtectedDirectory $newPath
    Assert-ProtectedDirectory $oldPath
    $marker = [IO.Path]::Combine($workspace, $committedName)
    $committed = $false
    if (Test-OrdinaryFile $marker) {
        try {
            $committed = (Read-Record $marker).id -eq $record.id
        } catch {
            # An interrupted marker write has not authorized deleting the old tree.
            $null = $_
        }
    }
    return @{
        id = $record.id; version = $record.version; originalVersion = $record.originalVersion
        committed = $committed; stage = $newPath; previous = $oldPath
    }
}

function Get-Inventory([string] $Root) {
    Assert-DirectoryPath $Root
    $files = [Collections.Generic.List[string]]::new()
    $directories = [Collections.Generic.List[string]]::new()
    $pending = [Collections.Generic.Stack[string]]::new()
    $pending.Push($Root)
    while ($pending.Count) {
        $directory = $pending.Pop()
        Assert-ProtectedDirectory $directory
        foreach ($entry in [IO.Directory]::GetFileSystemEntries($directory)) {
            $relative = $entry.Substring($Root.Length + 1)
            Assert-PathSegment ([IO.Path]::GetFileName($entry))
            $attributes = [IO.File]::GetAttributes($entry)
            if ($attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "安装文件中包含链接。$entry"
            }
            if ($attributes -band [IO.FileAttributes]::Directory) {
                $directories.Add($relative)
                $pending.Push($entry)
            } elseif ($relative -ne $manifestName) {
                $files.Add($relative)
            }
        }
    }
    return @{ files = $files.ToArray(); directories = $directories.ToArray() }
}

function Get-Manifest([string] $Root) {
    Assert-DirectoryPath $Root
    $record = Read-Record ([IO.Path]::Combine($Root, $manifestName))
    if ($record.product -ne 'BetterKuGou' -or $record.format -ne 1 -or
        $record.files -isnot [array] -or $record.directories -isnot [array]) {
        throw "安装文件清单无效。$Root"
    }
    Assert-RecordId $record.id
    $directories = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $files = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($list in @(@{ values = $record.directories; seen = $directories }, @{ values = $record.files; seen = $files })) {
        foreach ($relative in $list.values) {
            if ($relative -isnot [string] -or $relative -eq $manifestName) {
                throw "安装文件清单中有无效条目。$Root"
            }
            foreach ($segment in $relative.Split('\')) { Assert-PathSegment $segment }
            if (!$list.seen.Add($relative)) { throw "安装文件清单中有重复条目。$relative" }
        }
    }
    foreach ($relative in @($record.files) + @($record.directories)) {
        $directory = [IO.Path]::GetDirectoryName($relative)
        if ($directory -and !$directories.Contains($directory)) {
            throw "安装文件清单缺少此条目的父目录。$relative"
        }
    }
    if (!$files.Contains($appExe) -or !$files.Contains($uninstallerExe) -or
        !$files.Contains('resources\app.asar') -or $directories.Overlaps($files)) {
        throw "安装文件清单不完整。$Root"
    }
    return @{ id = $record.id; files = $files; directories = $directories }
}

function Test-Published($Transaction) {
    $path = [IO.Path]::Combine($target, $manifestName)
    if ($null -eq (Get-Attributes $path)) { return $false }
    try {
        return (Get-Manifest $target).id -eq $Transaction.id
    } catch {
        return $false
    }
}

function Assert-InstallDestination($Transaction) {
    if (![IO.Directory]::Exists($target) -or [IO.Directory]::GetFileSystemEntries($target).Length -eq 0) { return }
    if ($null -ne $Transaction -and (Test-Published $Transaction)) { return }
    if (!$registered) {
        throw '目标文件夹已有文件。请选择新建文件夹或空文件夹。'
    }
    $manifest = [IO.Path]::Combine($target, $manifestName)
    if ($null -ne (Get-Attributes $manifest)) {
        try {
            $null = Get-Manifest $target
            return
        } catch {
            # If a legacy copy can be identified, preserve the whole directory.
            $null = $_
        }
    }
    Assert-DirectoryPath ([IO.Path]::Combine($target, 'resources'))
    if (!(Test-OrdinaryFile ([IO.Path]::Combine($target, $appExe))) -or
        !(Test-OrdinaryFile ([IO.Path]::Combine($target, 'resources\app.asar')))) {
        throw '已登记的安装目录含有文件，且无法确认其中的 BetterKuGou 安装。'
    }
}

function Test-BackupRequired([string] $Root) {
    if (![IO.Directory]::Exists($Root) -or [IO.Directory]::GetFileSystemEntries($Root).Length -eq 0) { return $false }
    try {
        $manifest = Get-Manifest $Root
        $actual = Get-Inventory $Root
        return !$manifest.files.SetEquals($actual.files) -or !$manifest.directories.SetEquals($actual.directories)
    } catch {
        return $true
    }
}

function Assert-BackupConsent([string] $Root) {
    if ($env:BK_INSTALL_ALLOW_BACKUP -ne '1' -and (Test-BackupRequired $Root)) {
        throw '原安装目录含有需要备份的文件。请返回并确认备份后再继续。'
    }
}

function Assert-Version([string] $Version) {
    if ($Version -notmatch '^\d+\.\d+\.\d+[-+a-z0-9.]*$' -or $Version.Length -gt 128) {
        throw '安装包版本无效。'
    }
}

function Remove-Inventory([string] $Root, $Inventory, [bool] $HasManifest) {
    # Validate the full set before deleting anything, and delete exact paths only.
    foreach ($relative in $Inventory.directories) {
        $directory = [IO.Path]::Combine($Root, $relative)
        Assert-DirectoryPath $directory
        Assert-ProtectedDirectory $directory
    }
    foreach ($relative in $Inventory.files) {
        $path = [IO.Path]::Combine($Root, $relative)
        if (Test-OrdinaryFile $path) {
            # Fail before removing anything when a program still owns an installed file.
            [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None).Dispose()
        }
    }
    foreach ($relative in $Inventory.files) {
        if ($relative -eq $uninstallerExe) { continue }
        $path = [IO.Path]::Combine($Root, $relative)
        Assert-DirectoryPath ([IO.Path]::GetDirectoryName($path))
        if (Test-OrdinaryFile $path) { [IO.File]::Delete($path) }
    }
    $uninstaller = [IO.Path]::Combine($Root, $uninstallerExe)
    if ($uninstallerExe -in $Inventory.files -and (Test-OrdinaryFile $uninstaller)) { [IO.File]::Delete($uninstaller) }
    foreach ($relative in @($Inventory.directories | Sort-Object Length -Descending)) {
        Remove-EmptyDirectory ([IO.Path]::Combine($Root, $relative))
    }
    if ($HasManifest) { [IO.File]::Delete([IO.Path]::Combine($Root, $manifestName)) }
    Remove-EmptyDirectory $Root
}

function Remove-EmptyDirectory([string] $Path) {
    Assert-DirectoryPath $Path
    if ([IO.Directory]::Exists($Path) -and [IO.Directory]::GetFileSystemEntries($Path).Length -eq 0) {
        [IO.Directory]::Delete($Path)
    }
}

function Save-RecoveryDirectory([string] $Path, [string] $Label) {
    $suffix = [Guid]::NewGuid().ToString('N').Substring(0, 8)
    $saved = "$target.BetterKuGou-$Label-$suffix"
    Move-Directory $Path $saved
    return $saved
}

function Move-Directory([string] $Source, [string] $Destination) {
    # Antivirus scanners can briefly hold a newly extracted file without delete sharing.
    # A failed rename is retried only while both sides retain their original state.
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        Assert-DirectoryPath $Source
        Assert-DirectoryPath ([IO.Path]::GetDirectoryName($Destination))
        try {
            [IO.Directory]::Move($Source, $Destination)
            return
        } catch [IO.IOException], [UnauthorizedAccessException] {
            if ($attempt -eq 5 -or ![IO.Directory]::Exists($Source) -or $null -ne (Get-Attributes $Destination)) { throw }
            Start-Sleep -Milliseconds 200
        }
    }
}

function Remove-Workspace {
    if ([IO.Directory]::Exists($stage) -or [IO.Directory]::Exists($previous)) {
        throw "安装恢复文件已保留。$workspace"
    }
    [IO.File]::Delete([IO.Path]::Combine($workspace, $committedName))
    [IO.File]::Delete([IO.Path]::Combine($workspace, $transactionName))
    [IO.Directory]::Delete($workspace)
}

function Remove-Stage {
    if (![IO.Directory]::Exists($stage)) { return }
    try {
        $inventory = Get-Inventory $stage
        Remove-Inventory $stage $inventory $true
        if (![IO.Directory]::Exists($stage)) { return }
    } catch {
        # A changed or locked stage is retained so cleanup cannot discard unknown files.
        $null = $_
    }
    return Save-RecoveryDirectory $stage 'incomplete'
}

function Undo-Transaction($Transaction) {
    if ($Transaction.committed) { throw "已登记的安装需要完成清理。$workspace" }
    if (Test-Published $Transaction) {
        if ([IO.Directory]::Exists($stage)) { throw "无法确定上次安装的状态，已保留恢复文件。$workspace" }
        Move-Directory $target $stage
    }
    if ([IO.Directory]::Exists($previous)) {
        if ([IO.Directory]::Exists($target)) { throw "原安装文件已保留。$previous" }
        Move-Directory $previous $target
    }
    $retained = Remove-Stage
    Remove-Workspace
    return $retained
}

function Complete-Transaction($Transaction) {
    if (!(Test-Published $Transaction) -or [IO.Directory]::Exists($stage)) {
        throw "新版安装文件尚未发布。$workspace"
    }
    if (!$Transaction.committed) {
        # Registry registration is complete. Retain that fact before changing the backup.
        $marker = [IO.Path]::Combine($workspace, $committedName)
        [IO.File]::Delete($marker)
        Write-Record $marker @{ id = $Transaction.id }
    }
    $retained = $null
    if ([IO.Directory]::Exists($previous)) {
        Remove-EmptyDirectory $previous
        if ([IO.Directory]::Exists($previous)) {
            try {
                if (!(Test-BackupRequired $previous)) {
                    Remove-Inventory $previous (Get-Manifest $previous) $true
                }
            } catch {
                # Legacy, modified or inaccessible trees must remain recoverable.
                $null = $_
            }
            if ([IO.Directory]::Exists($previous)) {
                $retained = Save-RecoveryDirectory $previous 'backup'
            }
        }
    }
    Remove-Workspace
    return $retained
}

function Write-Result([string] $Value) {
    if ($env:BK_INSTALL_RESULT) {
        [IO.File]::WriteAllText($env:BK_INSTALL_RESULT, $Value, $utf16)
    } elseif ($Value) {
        [Console]::WriteLine($Value)
    }
}

try {
    if ($env:BK_INSTALL_MODE -notin @('CurrentUser', 'all') -or
        $env:BK_INSTALL_EXISTING -notin @('0', '1')) { throw '安装范围无效。' }
    $appExe = $env:BK_INSTALL_EXE
    $uninstallerExe = $env:BK_INSTALL_UNINSTALLER
    $packageVersion = $env:BK_INSTALL_VERSION
    Assert-Version $packageVersion
    Assert-PathSegment $appExe
    Assert-PathSegment $uninstallerExe
    if ($appExe -notlike '*.exe' -or $uninstallerExe -notlike '*.exe' -or $appExe -eq $uninstallerExe) {
        throw '应用程序或卸载程序的文件名无效。'
    }
    $target = Get-AbsolutePath $env:BK_INSTALL_TARGET
    $parent = [IO.Path]::GetDirectoryName($target)
    $workspace = "$target.BetterKuGou-install"
    Assert-TargetLocation
    $transaction = Get-Transaction
    $stage = if ($null -ne $transaction) { $transaction.stage }
    $previous = if ($null -ne $transaction) { $transaction.previous }
    $result = $null

    switch ($Action) {
        'validate' {
            Assert-InstallDestination $transaction
            $oldRoot = if ([IO.Directory]::Exists($previous)) { $previous } else { $target }
            $result = if (Test-BackupRequired $oldRoot) { "backup|$target" } else { $target }
        }
        'prepare' {
            if ($null -ne $transaction) {
                # Keep an already published, registered copy available after a power loss.
                $versionRegistered = $registered -and $env:BK_INSTALL_RECORDED_VERSION -eq $transaction.version -and
                    $transaction.originalVersion -ne $transaction.version
                if (($transaction.committed -or $versionRegistered) -and (Test-Published $transaction)) {
                    $retained = Complete-Transaction $transaction
                } else {
                    $retained = Undo-Transaction $transaction
                }
                if ($retained) { throw "上次安装的文件已保留在 $retained 。请重新运行安装包。" }
            }
            Assert-InstallDestination $null
            Assert-BackupConsent $target
            [void][IO.Directory]::CreateDirectory($parent)
            Assert-DirectoryPath $parent
            if ($null -ne (Get-Attributes $workspace)) { throw "安装工作目录已存在。$workspace" }
            [void][IO.Directory]::CreateDirectory($workspace)
            $transaction = @{
                product = 'BetterKuGou'; target = $target; id = [Guid]::NewGuid().ToString('N')
                version = $packageVersion; originalVersion = [string] $env:BK_INSTALL_RECORDED_VERSION
            }
            Write-Record ([IO.Path]::Combine($workspace, $transactionName)) $transaction
            $stage = "$target.BetterKuGou-new-$($transaction.id)"
            if ($null -ne (Get-Attributes $stage)) { throw "安装暂存目录已存在。$stage" }
            [void][IO.Directory]::CreateDirectory($stage)
            $result = $stage
        }
        'commit' {
            if ($null -eq $transaction -or $packageVersion -ne $transaction.version -or
                ![IO.Directory]::Exists($stage) -or [IO.Directory]::Exists($previous)) {
                throw '新版文件的暂存目录不可用。'
            }
            Assert-InstallDestination $transaction
            $inventory = Get-Inventory $stage
            foreach ($relative in @($appExe, $uninstallerExe, 'resources\app.asar')) {
                if ($relative -notin $inventory.files -or [IO.FileInfo]::new([IO.Path]::Combine($stage, $relative)).Length -le 0) {
                    throw "安装包缺少有效文件。$relative"
                }
            }
            Write-Record ([IO.Path]::Combine($stage, $manifestName)) @{
                product = 'BetterKuGou'; format = 1; id = $transaction.id
                files = $inventory.files; directories = $inventory.directories
            }
            try {
                if ([IO.Directory]::Exists($target)) {
                    Assert-BackupConsent $target
                    Move-Directory $target $previous
                    Assert-BackupConsent $previous
                }
                Move-Directory $stage $target
            } catch {
                if ([IO.Directory]::Exists($previous) -and ![IO.Directory]::Exists($target)) {
                    Move-Directory $previous $target
                }
                throw
            }
        }
        'finish' {
            if ($null -eq $transaction) { throw '找不到本次安装的操作记录。' }
            $result = Complete-Transaction $transaction
        }
        'rollback' {
            if ($null -ne $transaction) { $result = Undo-Transaction $transaction }
        }
        'uninstall' {
            if ($null -ne $transaction) { throw "请先重新运行安装包，恢复上次安装。$workspace" }
            $manifest = Get-Manifest $target
            Remove-Inventory $target $manifest $true
        }
    }
    Write-Result $result
    exit 0
} catch {
    if ($env:BK_INSTALL_RESULT) {
        Write-Result ($_.Exception.Message -replace '[\r\n]+', ' ')
    } else {
        [Console]::Error.WriteLine($_.Exception.Message)
    }
    exit 1
}
