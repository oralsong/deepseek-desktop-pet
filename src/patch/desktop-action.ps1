param(
  [ValidateSet("find", "invoke", "launch")]
  [string]$Action = "find",
  [string]$Query = "",
  [string]$Target = ""
)

$ErrorActionPreference = "Stop"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

function Write-Result([hashtable]$Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Depth 8 -Compress))
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

function Get-DesktopList {
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $desktopCondition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty,
    "Progman"
  )
  $desktop = $root.FindFirst([System.Windows.Automation.TreeScope]::Children, $desktopCondition)
  if (-not $desktop) { return $null }
  return $desktop
}

function Get-DesktopItems {
  $desktop = Get-DesktopList
  $condition = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::ListItem
  )
  $items = $null
  if ($desktop) {
    for ($attempt = 0; $attempt -lt 8; $attempt++) {
      $items = $desktop.FindAll([System.Windows.Automation.TreeScope]::Descendants, $condition)
      if ($items.Count -gt 0) { break }
      Start-Sleep -Milliseconds 150
    }
  }
  if (-not $items -or $items.Count -eq 0) {
    $items = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
      [System.Windows.Automation.TreeScope]::Descendants,
      $condition
    )
  }
  $out = @()
  for ($i = 0; $i -lt $items.Count; $i++) {
    $item = $items.Item($i)
    $rect = $item.Current.BoundingRectangle
    if (-not $item.Current.Name -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $out += [pscustomobject]@{
      Name = $item.Current.Name
      X = [int]($rect.X + $rect.Width / 2)
      Y = [int]($rect.Y + $rect.Height / 2)
      Element = $item
    }
  }
  return $out
}

function Get-GlobalItems {
  $types = @(
    [System.Windows.Automation.ControlType]::Button,
    [System.Windows.Automation.ControlType]::MenuItem,
    [System.Windows.Automation.ControlType]::ListItem,
    [System.Windows.Automation.ControlType]::Hyperlink,
    [System.Windows.Automation.ControlType]::TabItem,
    [System.Windows.Automation.ControlType]::CheckBox
  )
  $conditions = foreach ($type in $types) {
    New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      $type
    )
  }
  $condition = New-Object System.Windows.Automation.OrCondition([System.Windows.Automation.Condition[]]$conditions)
  $elements = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Descendants,
    $condition
  )
  $out = @()
  for ($i = 0; $i -lt $elements.Count; $i++) {
    $element = $elements.Item($i)
    $rect = $element.Current.BoundingRectangle
    if ($element.Current.IsOffscreen -or -not $element.Current.IsEnabled) { continue }
    if (-not $element.Current.Name -or $rect.IsEmpty -or $rect.Width -le 0 -or $rect.Height -le 0) { continue }
    $out += [pscustomobject]@{
      Name = $element.Current.Name
      X = [int]($rect.X + $rect.Width / 2)
      Y = [int]($rect.Y + $rect.Height / 2)
      Element = $element
    }
  }
  return $out
}

function Find-BestItem([object[]]$Items, [string]$QueryNorm) {
  $ranked = foreach ($item in $Items) {
    $score = Get-MatchScore $QueryNorm $item.Name
    if ($score -ge 0) {
      [pscustomobject]@{ Item = $item; Score = $score }
    }
  }
  return @($ranked | Sort-Object Score -Descending | Select-Object -First 1)
}

function Invoke-DesktopItem($Item) {
  try {
    $pattern = $Item.Element.GetCurrentPattern([System.Windows.Automation.LegacyIAccessiblePattern]::Pattern)
    $pattern.DoDefaultAction()
    return $true
  } catch { }
  try {
    $pattern = $Item.Element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return $true
  } catch { }
  return $false
}

try {
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
    Write-Result @{ ok = $false; action = $Action; reason = "empty-query" }
    exit 2
  }

  $items = @(Get-DesktopItems)
  $match = Find-BestItem $items $queryNorm
  $match = if ($match.Count -gt 0) { $match[0] } else { $null }
  $source = "desktop"
  if (-not $match) {
    $globalItems = @(Get-GlobalItems)
    $match = Find-BestItem $globalItems $queryNorm
    $match = if ($match.Count -gt 0) { $match[0] } else { $null }
    $source = "uia"
  }

  if ($Action -eq "invoke") {
    if (-not $match) {
      Write-Result @{ ok = $false; action = "invoke"; reason = "desktop-target-not-found"; query = $Query }
      exit 2
    }
    $invoked = Invoke-DesktopItem $match.Item
    $result = @{
      ok = $invoked
      action = "invoke"
      query = $Query
      name = $match.Item.Name
      x = $match.Item.X
      y = $match.Item.Y
      source = $source
    }
    if (-not $invoked) { $result.reason = "invoke-unsupported" }
    Write-Result $result
    exit $(if ($invoked) { 0 } else { 2 })
  }

  $paths = Get-DesktopPaths
  if ($source -eq "uia" -and $match) {
    $best = [pscustomobject]@{
      name = $match.Item.Name
      path = ""
      x = $match.Item.X
      y = $match.Item.Y
      score = $match.Score
      visible = $true
      source = "uia"
    }
  } else {
    $candidates = foreach ($item in $items) {
      $score = Get-MatchScore $queryNorm $item.Name
      if ($score -lt 0) { continue }
      [pscustomobject]@{
        name = $item.Name
        path = if ($paths.ContainsKey($item.Name)) { $paths[$item.Name] } else { "" }
        x = $item.X
        y = $item.Y
        score = $score
        visible = $true
        source = "desktop"
      }
    }
    $best = @($candidates | Sort-Object score -Descending | Select-Object -First 1)
    $best = if ($best.Count -gt 0) { $best[0] } else { $null }
  }
  $screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
  Write-Result @{
    ok = [bool]$best
    action = "find"
    query = $Query
    match = $best
    source = $source
    iconCount = $items.Count
    screen = @{
      x = $screen.Left
      y = $screen.Top
      width = $screen.Width
      height = $screen.Height
    }
    foreground = @{ desktop = [bool](Get-DesktopList) }
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
