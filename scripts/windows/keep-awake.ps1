param([Parameter(Mandatory=$true)][int]$ParentPid, [switch]$DisplayOn)
$source = @"
using System;
using System.Runtime.InteropServices;
public static class PowerRequest {
  [DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);
}
"@
Add-Type -TypeDefinition $source
$continuous = 0x80000000
$systemRequired = 0x00000001
$displayRequired = 0x00000002
$flags = $continuous -bor $systemRequired
if ($DisplayOn) { $flags = $flags -bor $displayRequired }
[void][PowerRequest]::SetThreadExecutionState($flags)
try {
  while (Get-Process -Id $ParentPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 5 }
} finally {
  [void][PowerRequest]::SetThreadExecutionState($continuous)
}
