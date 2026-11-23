$ProgressPreference='SilentlyContinue'
$p="__TFM_${n}_";$l=@("${p}V1_BEGIN__")
function S($k,$v,$e=0){
 $script:l+="${p}SECTION_${k}_BEGIN__"
 foreach($s in $v){$script:l+=-join $(foreach($c in ([string]$s).ToCharArray()){if($c -cmatch '[^ -~]|\\'){'\u{0:x4}' -f [int]$c}else{$c}})}
 $script:l+="${p}SECTION_${k}_END_${e}__"
}
S platform Windows
S hostname $env:COMPUTERNAME
S architecture $env:PROCESSOR_ARCHITECTURE
$b='blocked 1'
$v=Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion' -ErrorAction SilentlyContinue
$r=@($b)
if($v){$a=$v.ProductName;if([int]$v.CurrentBuild -ge 22000){$a=$a -replace '^Windows 10','Windows 11'};$r+="caption $a","version 10.0.$($v.CurrentBuild).$($v.UBR)"}
S winOs $r 126
S winCpu $b 126
S winNet $b 126
$q="$env:SystemRoot\System32\quser.exe"
if(Test-Path $q){$u=& $q 2>$null;if($LASTEXITCODE){S winUsers @() 1}else{S winUsers $u}}else{S winUsers @() 127}
S winDisks $b 126
S winNetDrives $b 126
Write-Host -NoNewline ((($l+"${p}V1_END__") -join "`n")+"`n")
