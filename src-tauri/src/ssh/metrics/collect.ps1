$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
$p="__TFM_$($args[0])_"
$o=[Console]::Out
[Threading.Thread]::CurrentThread.CurrentCulture=[Globalization.CultureInfo]::InvariantCulture
function Escape([string]$s){
    [regex]::Replace($s,'[^ -~]|\\',{param($m) '\u{0:x4}' -f [int][char]$m.Value})
}
function S($key,$body){
    $o.Write("${p}SECTION_${key}_BEGIN__`n")
    $script:rc=0
    try { & $body | ForEach-Object { $o.Write("$(Escape $_)`n") } }
    catch {
        $script:rc=1
        if($_.FullyQualifiedErrorId -match 'ConstrainedLanguage|NotAllowedInRestrictedLanguage|BlockedByPolicy|PSSecurityException'){
            $script:rc=126
            $o.Write("blocked 1`n")
        }
    }
    $o.Write("${p}SECTION_${key}_END_${script:rc}__`n")
}
function Native {
    if($script:K){return}
    if($script:nativeError){throw $script:nativeError}
    try{
    $started=[Diagnostics.Stopwatch]::GetTimestamp()
    $a=[AppDomain]::CurrentDomain.DefineDynamicAssembly((New-Object Reflection.AssemblyName Tfm),[Reflection.Emit.AssemblyBuilderAccess]::Run)
    $t=$a.DefineDynamicModule('Tfm').DefineType('TfmNative','Public,Class')
    $r=[uint64].MakeByRefType()
    foreach($name in 'GetSystemTimes','GlobalMemoryStatusEx','TerminateProcess'){
        $types=switch($name){'GetSystemTimes'{@($r,$r,$r)}'GlobalMemoryStatusEx'{@([uint64[]])}default{@([IntPtr],[uint32])}}
        $m=$t.DefinePInvokeMethod($name,'kernel32.dll','Public,Static,PinvokeImpl','Standard',[bool],[type[]]$types,'Winapi','Auto')
        $m.SetImplementationFlags('PreserveSig')
    }
    $script:K=$t.CreateType()
    }catch{$script:nativeError=$_;throw}
    if($env:TFM_TIMING -eq '1'){
        [Console]::Error.WriteLine("define_ms $(([Diagnostics.Stopwatch]::GetTimestamp()-$started)*1000/[Diagnostics.Stopwatch]::Frequency)")
    }
}
$o.Write("${p}V1_BEGIN__`n")
S platform {'Windows'}
S hostname {[Environment]::MachineName}
S architecture {$env:PROCESSOR_ARCHITECTURE}
S winOs {
    $v=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion'
    $n=$v.ProductName
    if([int]$v.CurrentBuild -ge 22000){$n=$n -replace '^Windows 10','Windows 11'}
    "caption $n";"version 10.0.$($v.CurrentBuild).$($v.UBR)"
    "uptimeTicks $([Diagnostics.Stopwatch]::GetTimestamp())";"tickFrequency $([Diagnostics.Stopwatch]::Frequency)"
    Native
    $b=New-Object 'uint64[]' 8;$b[0]=64
    if(!$K::GlobalMemoryStatusEx($b)){throw 'memory'}
    "totalBytes $($b[1])";"availBytes $($b[2])"
}
S winCpu {
    Native
    $i=$kernel=$u=[uint64]0
    if(!$K::GetSystemTimes([ref]$i,[ref]$kernel,[ref]$u)){throw 'cpu'}
    "idle100ns $i";"kernel100ns $kernel";"user100ns $u";"cores $([Environment]::ProcessorCount)"
}
S winNet {
    foreach($n in [Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()){
        if($n.NetworkInterfaceType -eq 'Loopback'){continue}
        try{$b=$n.GetIPStatistics();"$($b.BytesReceived) $($b.BytesSent) $($n.Name)"}catch{}
    }
}
S winUsers {
    $q="$env:SystemRoot\System32\quser.exe"
    if(!(Test-Path $q)){$script:rc=127;return}
    $lines=& $q 2>$null
    if($LASTEXITCODE){$script:rc=1;return}
    $lines
}
$drives={foreach($d in [IO.DriveInfo]::GetDrives()){if($d.DriveType -eq $args[0]){$d}}}
S winDisks {
    foreach($d in (& $drives Fixed)){
        try{if($d.IsReady -and $d.TotalSize -gt 0){"$($d.Name.TrimEnd('\'))`t$($d.TotalSize)`t$($d.TotalFreeSpace)`t$($d.DriveFormat)"}}catch{}
    }
}
S winNetDrives {
    $paths=@{}
    foreach($d in (& $drives Network)){
        $letter=$d.Name[0];$paths[$d.Name]=(Get-ItemProperty "HKCU:\Network\$letter" -ErrorAction SilentlyContinue).RemotePath
    }
    if(!$paths.Count){return}
    $ps=[PowerShell]::Create()
    $job=$ps.AddScript({param($names) foreach($n in $names){try{$d=[IO.DriveInfo]::new($n);@{n=$n;s=$d.TotalSize;f=$d.TotalFreeSpace}}catch{}}}).AddArgument(@($paths.Keys)).BeginInvoke()
    if(!$job.AsyncWaitHandle.WaitOne(2000)){$script:rc=137;$script:hung=$true;return}
    try{foreach($d in $ps.EndInvoke($job)){if($d.s -gt 0){"$($d.n.TrimEnd('\'))`t$($d.s)`t$($d.f)`t$($paths[$d.n])"}}}finally{$ps.Dispose()}
}
$o.Write("${p}V1_END__`n")
$o.Flush()
if($env:TFM_TIMING -eq '1'){[Console]::Error.WriteLine("cpu_ms $((Get-Process -Id $PID).TotalProcessorTime.TotalMilliseconds)")}
if($script:hung){
    try{Native;$null=$K::TerminateProcess([IntPtr]::new(-1),0)}catch{}
    [Environment]::Exit(0)
}
exit 0
