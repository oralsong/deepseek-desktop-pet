param(
  [ValidateSet("find", "click", "launch")]
  [string]$Action = "find",
  [string]$Query = "",
  [double]$X = 0,
  [double]$Y = 0,
  [string]$Target = "",
  [string]$OutFile = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

if (-not ("PetDesktopNative" -as [type])) {
  Add-Type -TypeDefinition @"
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class PetDesktopIconInfo {
  public string Name;
  public int X;
  public int Y;
}

public static class PetDesktopNative {
  private const uint PROCESS_VM_OPERATION = 0x0008;
  private const uint PROCESS_VM_READ = 0x0010;
  private const uint PROCESS_VM_WRITE = 0x0020;
  private const uint PROCESS_QUERY_INFORMATION = 0x0400;
  private const uint MEM_COMMIT = 0x1000;
  private const uint MEM_RESERVE = 0x2000;
  private const uint MEM_RELEASE = 0x8000;
  private const uint PAGE_READWRITE = 0x04;
  private const uint LVIF_TEXT = 0x0001;
  private const uint LVM_GETITEMCOUNT = 0x1004;
  private const uint LVM_GETITEMPOSITION = 0x1010;
  private const uint LVM_GETITEMTEXTW = 0x1073;
  private const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
  private const uint MOUSEEVENTF_LEFTUP = 0x0004;

  [StructLayout(LayoutKind.Sequential)]
  private struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

  [StructLayout(LayoutKind.Sequential)]
  private struct POINT { public int X; public int Y; }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct LVITEM {
    public uint mask;
    public int iItem;
    public int iSubItem;
    public uint state;
    public uint stateMask;
    public IntPtr pszText;
    public int cchTextMax;
    public int iImage;
    public IntPtr lParam;
    public int iIndent;
    public int iGroupId;
    public uint cColumns;
    public IntPtr puColumns;
    public IntPtr piColFmt;
    public int iGroup;
  }

  private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindow(string className, string windowName);

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr childAfter, string className, string windowName);

  [DllImport("user32.dll")]
  private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

  [DllImport("user32.dll")]
  private static extern IntPtr SendMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

  [DllImport("user32.dll")]
  private static extern bool SetCursorPos(int x, int y);

  [DllImport("user32.dll")]
  private static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);

  [DllImport("user32.dll")]
  private static extern IntPtr GetForegroundWindow();

  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  private static extern int GetClassName(IntPtr hWnd, StringBuilder className, int maxCount);

  [DllImport("kernel32.dll")]
  private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);

  [DllImport("kernel32.dll")]
  private static extern bool CloseHandle(IntPtr handle);

  [DllImport("kernel32.dll")]
  private static extern IntPtr VirtualAllocEx(IntPtr process, IntPtr address, UIntPtr size, uint allocationType, uint protect);

  [DllImport("kernel32.dll")]
  private static extern bool VirtualFreeEx(IntPtr process, IntPtr address, UIntPtr size, uint freeType);

  [DllImport("kernel32.dll")]
  private static extern bool WriteProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr written);

  [DllImport("kernel32.dll")]
  private static extern bool ReadProcessMemory(IntPtr process, IntPtr address, byte[] buffer, UIntPtr size, out UIntPtr read);

  private static IntPtr DesktopListView() {
    IntPtr progman = FindWindow("Progman", null);
    IntPtr defView = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
    if (defView == IntPtr.Zero) {
      EnumWindows(delegate(IntPtr hwnd, IntPtr ignored) {
        IntPtr candidate = FindWindowEx(hwnd, IntPtr.Zero, "SHELLDLL_DefView", null);
        if (candidate != IntPtr.Zero) {
          defView = candidate;
          return false;
        }
        return true;
      }, IntPtr.Zero);
    }
    if (defView == IntPtr.Zero) return IntPtr.Zero;
    return FindWindowEx(defView, IntPtr.Zero, "SysListView32", null);
  }

  public static List<PetDesktopIconInfo> ReadIcons() {
    var result = new List<PetDesktopIconInfo>();
    IntPtr list = DesktopListView();
    if (list == IntPtr.Zero) return result;
    uint pid;
    GetWindowThreadProcessId(list, out pid);
    IntPtr process = OpenProcess(
      PROCESS_VM_OPERATION | PROCESS_VM_READ | PROCESS_VM_WRITE | PROCESS_QUERY_INFORMATION,
      false,
      pid
    );
    if (process == IntPtr.Zero) return result;

    IntPtr itemMemory = IntPtr.Zero;
    IntPtr textMemory = IntPtr.Zero;
    IntPtr pointMemory = IntPtr.Zero;
    try {
      itemMemory = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)Marshal.SizeOf(typeof(LVITEM)), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
      textMemory = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)2048, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
      pointMemory = VirtualAllocEx(process, IntPtr.Zero, (UIntPtr)Marshal.SizeOf(typeof(POINT)), MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
      if (itemMemory == IntPtr.Zero || textMemory == IntPtr.Zero || pointMemory == IntPtr.Zero) return result;

      RECT listRect;
      GetWindowRect(list, out listRect);
      int count = (int)SendMessage(list, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
      var textBuffer = new byte[2048];
      for (int i = 0; i < count; i++) {
        var item = new LVITEM();
        item.mask = LVIF_TEXT;
        item.iItem = i;
        item.iSubItem = 0;
        item.pszText = textMemory;
        item.cchTextMax = 1024;
        int itemSize = Marshal.SizeOf(typeof(LVITEM));
        byte[] itemBytes = new byte[itemSize];
        IntPtr localItem = Marshal.AllocHGlobal(itemSize);
        try {
          Marshal.StructureToPtr(item, localItem, false);
          Marshal.Copy(localItem, itemBytes, 0, itemSize);
        } finally {
          Marshal.FreeHGlobal(localItem);
        }
        UIntPtr written;
        if (!WriteProcessMemory(process, itemMemory, itemBytes, (UIntPtr)itemSize, out written)) continue;
        SendMessage(list, LVM_GETITEMTEXTW, (IntPtr)i, itemMemory);
        Array.Clear(textBuffer, 0, textBuffer.Length);
        UIntPtr read;
        ReadProcessMemory(process, textMemory, textBuffer, (UIntPtr)textBuffer.Length, out read);
        int terminator = Array.IndexOf(textBuffer, (byte)0);
        if (terminator < 0) terminator = textBuffer.Length;
        if ((terminator & 1) != 0) terminator--;
        string name = Encoding.Unicode.GetString(textBuffer, 0, terminator).Trim();
        if (name.Length == 0) continue;

        UIntPtr pointRead;
        SendMessage(list, LVM_GETITEMPOSITION, (IntPtr)i, pointMemory);
        byte[] pointBytes = new byte[Marshal.SizeOf(typeof(POINT))];
        if (!ReadProcessMemory(process, pointMemory, pointBytes, (UIntPtr)pointBytes.Length, out pointRead)) continue;
        IntPtr localPoint = Marshal.AllocHGlobal(pointBytes.Length);
        POINT point;
        try {
          Marshal.Copy(pointBytes, 0, localPoint, pointBytes.Length);
          point = (POINT)Marshal.PtrToStructure(localPoint, typeof(POINT));
        } finally {
          Marshal.FreeHGlobal(localPoint);
        }
        result.Add(new PetDesktopIconInfo {
          Name = name,
          X = listRect.Left + point.X + 24,
          Y = listRect.Top + point.Y + 24
        });
      }
    } finally {
      if (itemMemory != IntPtr.Zero) VirtualFreeEx(process, itemMemory, UIntPtr.Zero, MEM_RELEASE);
      if (textMemory != IntPtr.Zero) VirtualFreeEx(process, textMemory, UIntPtr.Zero, MEM_RELEASE);
      if (pointMemory != IntPtr.Zero) VirtualFreeEx(process, pointMemory, UIntPtr.Zero, MEM_RELEASE);
      CloseHandle(process);
    }
    return result;
  }

  public static bool Click(int x, int y) {
    if (!SetCursorPos(x, y)) return false;
    mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
    mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
    return true;
  }

  public static bool IsDesktopForeground() {
    IntPtr hwnd = GetForegroundWindow();
    if (hwnd == IntPtr.Zero) return false;
    var className = new StringBuilder(256);
    GetClassName(hwnd, className, className.Capacity);
    string name = className.ToString();
    return name == "Progman" || name == "WorkerW" || name == "SysListView32";
  }

  public static long DebugListView() {
    return DesktopListView().ToInt64();
  }

  public static int DebugItemCount() {
    IntPtr list = DesktopListView();
    return list == IntPtr.Zero ? -1 : (int)SendMessage(list, LVM_GETITEMCOUNT, IntPtr.Zero, IntPtr.Zero);
  }
}
"@
}

function Write-Result([hashtable]$Value) {
  $json = $Value | ConvertTo-Json -Depth 8 -Compress
  if ($OutFile) {
    $dir = Split-Path -Parent $OutFile
    if ($dir) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
    [System.IO.File]::WriteAllText($OutFile, $json, [System.Text.UTF8Encoding]::new($false))
  } else {
    [Console]::Out.Write($json)
  }
}

function Normalize-Text([string]$Text) {
  if (-not $Text) { return "" }
  $value = $Text.ToLowerInvariant()
  $value = $value -replace "\.lnk$|\.url$|\.exe$", ""
  $value = $value -replace "[\s\p{P}\p{S}]+", ""
  return $value
}

function Get-Acronym([string]$Text) {
  $parts = [regex]::Split($Text, "[\s\p{P}\p{S}]+") | Where-Object { $_ }
  if (-not $parts) { return "" }
  $letters = foreach ($part in $parts) {
    if ($part -match "^[0-9]+$") { $part }
    elseif ($part.Length -gt 0) { $part.Substring(0, 1) }
  }
  return (-join $letters).ToLowerInvariant()
}

function Get-MatchScore([string]$QueryNorm, [string]$Name) {
  $nameNorm = Normalize-Text $Name
  if (-not $nameNorm) { return -1 }
  if ($nameNorm -eq $QueryNorm) { return 1000 }
  $acronym = Get-Acronym $Name
  if ($acronym -eq $QueryNorm) { return 950 }
  if ($nameNorm.StartsWith($QueryNorm)) { return 850 - [Math]::Min(100, $nameNorm.Length - $QueryNorm.Length) }
  if ($nameNorm.Contains($QueryNorm)) { return 750 - [Math]::Min(100, $nameNorm.Length - $QueryNorm.Length) }
  if ($acronym.StartsWith($QueryNorm)) { return 700 - [Math]::Min(100, $acronym.Length - $QueryNorm.Length) }
  if ($QueryNorm.Contains($nameNorm)) { return 600 - [Math]::Min(100, $QueryNorm.Length - $nameNorm.Length) }
  return -1
}

function Get-DesktopPaths {
  $map = @{}
  $roots = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("CommonDesktopDirectory")
  )
  foreach ($root in $roots) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    Get-ChildItem -LiteralPath $root -Force -ErrorAction SilentlyContinue | ForEach-Object {
      if ($_.Name -eq "desktop.ini") { return }
      $displayName = $_.Name
      if ($_.Extension -in @(".lnk", ".url", ".exe")) {
        $displayName = [System.IO.Path]::GetFileNameWithoutExtension($_.Name)
      }
      if (-not $map.ContainsKey($_.Name)) { $map[$_.Name] = $_.FullName }
      if (-not $map.ContainsKey($displayName)) { $map[$displayName] = $_.FullName }
    }
  }
  return $map
}

function Get-UiAutomationIcons {
  try {
    $root = [System.Windows.Automation.AutomationElement]::RootElement
    $condition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty,
      "Progman"
    )
    $desktop = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition)
    if (-not $desktop) { return @() }
    $itemCondition = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::ListItem
    )
    $items = $desktop.FindAll([System.Windows.Automation.TreeScope]::Descendants, $itemCondition)
    $out = @()
    for ($i = 0; $i -lt $items.Count; $i++) {
      $item = $items.Item($i)
      $name = $item.Current.Name
      $rect = $item.Current.BoundingRectangle
      if (-not $name -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
      $out += [pscustomobject]@{
        Name = $name
        X = [int]($rect.X + $rect.Width / 2)
        Y = [int]($rect.Y + $rect.Height / 2)
      }
    }
    return $out
  } catch {
    return @()
  }
}

try {
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  if ($Action -eq "click") {
    $ok = [PetDesktopNative]::Click([int]$X, [int]$Y)
    Write-Result @{ ok = $ok; action = "click"; x = [int]$X; y = [int]$Y }
    exit $(if ($ok) { 0 } else { 2 })
  }
  if ($Action -eq "launch") {
    if (-not $Target -or -not (Test-Path -LiteralPath $Target)) {
      Write-Result @{ ok = $false; action = "launch"; reason = "target-not-found" }
      exit 2
    }
    Start-Process -FilePath $Target -WorkingDirectory (Split-Path -Parent $Target)
    Write-Result @{ ok = $true; action = "launch"; target = $Target }
    exit 0
  }

  $queryNorm = Normalize-Text $Query
  if (-not $queryNorm) {
    Write-Result @{ ok = $false; action = "find"; reason = "empty-query" }
    exit 2
  }
  $paths = Get-DesktopPaths
  $icons = @(Get-UiAutomationIcons)
  $iconSource = "uia"
  if (-not $icons -or $icons.Count -eq 0) {
    $icons = @([PetDesktopNative]::ReadIcons())
    $iconSource = "win32"
  }
  $iconCandidates = foreach ($icon in $icons) {
    $score = Get-MatchScore $queryNorm $icon.Name
    if ($score -lt 0) { continue }
    [pscustomobject]@{
      name = $icon.Name
      path = if ($paths.ContainsKey($icon.Name)) { $paths[$icon.Name] } else { "" }
      x = $icon.X
      y = $icon.Y
      score = $score
      visible = $true
    }
  }
  $fileCandidates = foreach ($entry in $paths.GetEnumerator()) {
    $score = Get-MatchScore $queryNorm $entry.Key
    if ($score -lt 0) { continue }
    [pscustomobject]@{
      name = $entry.Key
      path = $entry.Value
      x = $null
      y = $null
      score = $score - 400
      visible = $false
    }
  }
  $candidates = @($iconCandidates) + @($fileCandidates)
  $match = @($candidates | Sort-Object score -Descending | Select-Object -First 1)
  $match = if ($match.Count -gt 0) { $match[0] } else { $null }
  $foreground = @{
    desktop = [PetDesktopNative]::IsDesktopForeground()
  }
  Write-Result @{
    ok = [bool]$match
    action = "find"
    query = $Query
    match = $match
    debug = @{
      iconCount = @($icons).Count
      iconSource = $iconSource
      listView = [PetDesktopNative]::DebugListView()
      listViewItems = [PetDesktopNative]::DebugItemCount()
      pathCount = $paths.Count
      candidateCount = @($candidates).Count
      sampleScores = @(
        $paths.Keys |
          Where-Object { (Normalize-Text $_) -match "pcl|plain" } |
          Select-Object -First 8 |
          ForEach-Object {
            @{
              name = $_
              score = Get-MatchScore $queryNorm $_
            }
          }
      )
    }
    screen = @{
      x = $screen.Left
      y = $screen.Top
      width = $screen.Width
      height = $screen.Height
    }
    foreground = $foreground
  }
} catch {
  Write-Result @{
    ok = $false
    action = $Action
    reason = "desktop-action-error"
    message = $_.Exception.Message
  }
  exit 2
}
