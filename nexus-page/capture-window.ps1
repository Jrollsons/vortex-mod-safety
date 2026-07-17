param([string]$OutFile = "capture.png")

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Win32Cap {
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [StructLayout(LayoutKind.Sequential)]
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$proc = Get-Process -Name Vortex -ErrorAction Stop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if ($null -eq $proc) { throw "no Vortex window found" }
$hwnd = $proc.MainWindowHandle

# restore + foreground so the window renders at full size
[Win32Cap]::ShowWindow($hwnd, 9) | Out-Null
[Win32Cap]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 800

$rect = New-Object Win32Cap+RECT
[Win32Cap]::GetWindowRect($hwnd, [ref]$rect) | Out-Null
$w = $rect.Right - $rect.Left
$h = $rect.Bottom - $rect.Top
if ($w -le 0 -or $h -le 0) { throw "window has no size" }

$bmp = New-Object System.Drawing.Bitmap($w, $h)
$gfx = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $gfx.GetHdc()
# PW_RENDERFULLCONTENT (2) needed for Chromium/Electron surfaces
[Win32Cap]::PrintWindow($hwnd, $hdc, 2) | Out-Null
$gfx.ReleaseHdc($hdc)
$gfx.Dispose()
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutFile ($w x $h)"
