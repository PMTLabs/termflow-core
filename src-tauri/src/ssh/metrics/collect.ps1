# Windows PowerShell 5.1. Stdout is a nonce-framed ASCII stream, not PS formatting.
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$p="__TFM_$($args[0])_"
$o=[Console]::Out
[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::InvariantCulture
function Escape([string]$s){
    [regex]::Replace($s,'[^ -~]|\\',{param($m) '\u{0:x4}' -f [int][char]$m.Value})
}
function S($key,[scriptblock]$body){
    $o.Write("${p}SECTION_${key}_BEGIN__`n")
    $script:rc=0
    try { foreach($row in @(& $body)){ $o.Write("$(Escape $row)`n") } }
    catch {
        $script:rc=1
        for($e=$_.Exception;$e;$e=$e.InnerException){
            if($e -is [UnauthorizedAccessException] -or ($e -is [Management.ManagementException] -and $e.ErrorCode -eq 'AccessDenied')){ $script:rc=126;break }
        }
    }
    $o.Write("${p}SECTION_${key}_END_${script:rc}__`n")
}
function Q($sql){
    $ErrorActionPreference='Stop'
    $s=[Management.ManagementObjectSearcher]::new('root\cimv2',$sql)
    $s.Options.Timeout=[TimeSpan]::FromSeconds(2)
    $s.Options.ReturnImmediately=$false
    try { $r=$s.Get();try { foreach($item in $r){ $item } } finally { $r.Dispose() } }
    finally { $s.Dispose() }
}
$o.Write("${p}V1_BEGIN__`n")
S platform { 'Windows' }
S hostname { [Environment]::MachineName }
S architecture { $env:PROCESSOR_ARCHITECTURE }
S winOs {
    $x=Q 'SELECT Caption,Version,TotalVisibleMemorySize,FreePhysicalMemory,LastBootUpTime,LocalDateTime FROM Win32_OperatingSystem' | Select-Object -First 1
    if(!$x){ throw 'Missing OS counters' }
    "caption $($x.Caption)";"version $($x.Version)"
    "totalKiB $($x.TotalVisibleMemorySize)";"freeKiB $($x.FreePhysicalMemory)"
    "boot $($x.LastBootUpTime)";"now $($x.LocalDateTime)"
}
S winCpu {
    $x=Q "SELECT PercentIdleTime,Timestamp_Sys100NS FROM Win32_PerfRawData_PerfOS_Processor WHERE Name='_Total'" | Select-Object -First 1
    if(!$x){ throw 'Missing CPU counters' }
    "idle100ns $($x.PercentIdleTime)";"stamp100ns $($x.Timestamp_Sys100NS)"
    "cores $([Environment]::ProcessorCount)"
}
S winNet {
    Q 'SELECT Name,BytesReceivedPersec,BytesSentPersec,Timestamp_Sys100NS FROM Win32_PerfRawData_Tcpip_NetworkInterface' | ForEach-Object {
        "$($_.BytesReceivedPersec) $($_.BytesSentPersec) $($_.Timestamp_Sys100NS) $($_.Name)"
    }
}
S winUsers {
    $q=Join-Path $env:SystemRoot 'System32\quser.exe'
    if(!(Test-Path $q)){ $script:rc=127;return }
    $lines=& $q 2>$null
    if($LASTEXITCODE -ne 0){ $script:rc=1;return }
    $lines
}
S winDisks {
    Q 'SELECT DeviceID,Size,FreeSpace,FileSystem FROM Win32_LogicalDisk WHERE DriveType=3' | ForEach-Object {
        "$($_.DeviceID)`t$($_.Size)`t$($_.FreeSpace)`t$($_.FileSystem)"
    }
}
S winNetDrives {
    $drives=@(Q 'SELECT DeviceID,ProviderName FROM Win32_LogicalDisk WHERE DriveType=4')
    if(!$drives.Count){ return }
    # Do not dispose a timed-out runspace: disposal can wait on the share.
    $ps=[PowerShell]::Create()
    $job=$ps.AddScript('param($q,$sql) & ([scriptblock]::Create($q)) $sql').AddArgument(${function:Q}.ToString()).AddArgument('SELECT DeviceID,Size,FreeSpace FROM Win32_LogicalDisk WHERE DriveType=4').BeginInvoke()
    if(!$job.AsyncWaitHandle.WaitOne(2000)){ $script:rc=137;return }
    try {
        $usage=@{}
        foreach($x in $ps.EndInvoke($job)){ $usage[$x.DeviceID]=$x }
        foreach($x in $drives){
            $u=$usage[$x.DeviceID]
            "$($x.DeviceID)`t$($u.Size)`t$($u.FreeSpace)`t$($x.ProviderName)"
        }
    } finally { $ps.Dispose() }
}
$o.Write("${p}V1_END__`n")
$o.Flush()
[Environment]::Exit(0)
