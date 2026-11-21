param(
    [Parameter(Mandatory=$true)][string]$WorkDirectory,
    [Parameter(Mandatory=$true)][string]$CecilPath
)
$ErrorActionPreference='Stop'
Add-Type -LiteralPath $CecilPath
$repository=Split-Path -Parent $PSScriptRoot
$map=Get-Content "$repository\resources\jellyfin-plugins\localization\zh-CN.json" -Raw|ConvertFrom-Json -AsHashtable
$records=Get-Content "$WorkDirectory\verified-packages.json" -Raw|ConvertFrom-Json
$displayMethods=@('get_Description')
function TranslateDisplayMethods($types) {
 foreach($type in $types) {
  foreach($method in $type.Methods) {
   if($method.HasBody -and ($method.Name -in $displayMethods) -and $type.BaseType.FullName -like 'MediaBrowser.Common.Plugins.BasePlugin*') {
    foreach($instruction in $method.Body.Instructions) {
     if($instruction.OpCode.Name -eq 'ldstr' -and $map.ContainsKey([string]$instruction.Operand)) {
      $instruction.Operand=$map[[string]$instruction.Operand]
     }
    }
   }
  }
  TranslateDisplayMethods $type.NestedTypes
 }
}
function CheckMethods($left,$right) {
 if($left.Count -ne $right.Count){throw 'Type count changed'}
 for($i=0;$i -lt $left.Count;$i++) {
  $a=$left[$i];$b=$right[$i]
  if($a.FullName -ne $b.FullName -or $a.Methods.Count -ne $b.Methods.Count){throw 'Type identity changed'}
  for($j=0;$j -lt $a.Methods.Count;$j++) {
   $x=$a.Methods[$j];$y=$b.Methods[$j]
   if(!$x.HasBody){continue}
   if($x.Body.Instructions.Count -ne $y.Body.Instructions.Count){throw 'Method instructions changed'}
   for($k=0;$k -lt $x.Body.Instructions.Count;$k++) {
    $u=$x.Body.Instructions[$k];$v=$y.Body.Instructions[$k]
    if($u.OpCode.Name -ne $v.OpCode.Name){throw 'Opcode changed'}
    if($u.OpCode.Name -eq 'ldstr' -and $x.Name -in $displayMethods){continue}
    if([string]$u.Operand -ne [string]$v.Operand){throw 'Functional operand changed'}
   }
  }
  CheckMethods $a.NestedTypes $b.NestedTypes
 }
}
foreach($record in $records) {
 $source=Join-Path "$WorkDirectory\stock" $record.Folder
 $target=Join-Path "$WorkDirectory\localized" $record.Folder
 New-Item -ItemType Directory -Path $target -Force|Out-Null
 Get-ChildItem -LiteralPath $source -File|Copy-Item -Destination $target
 $file=Get-ChildItem -LiteralPath $source -Filter 'Jellyfin.Plugin.*.dll'|Select-Object -First 1
 $module=[Mono.Cecil.ModuleDefinition]::ReadModule($file.FullName)
 $resourceChanges=0
 for($i=0;$i -lt $module.Resources.Count;$i++) {
  $r=$module.Resources[$i]
  $translated=Join-Path "$WorkDirectory\$($record.Folder)\translated" $r.Name
  if(Test-Path -LiteralPath $translated -PathType Leaf){
   $module.Resources[$i]=[Mono.Cecil.EmbeddedResource]::new($r.Name,$r.Attributes,[IO.File]::ReadAllBytes($translated))
   $resourceChanges++
  }
 }
 if($record.Name -eq 'Home Screen Sections') {
  $zh=[IO.File]::ReadAllBytes("$repository\resources\jellyfin-plugins\localization\home-sections-zh-CN.json")
  foreach($culture in 'zh','zh-CN','zh-Hans'){
   $module.Resources.Add([Mono.Cecil.EmbeddedResource]::new("Jellyfin.Plugin.HomeScreenSections._Localization.$culture.json",[Mono.Cecil.ManifestResourceAttributes]::Private,$zh))
  }
 }
 TranslateDisplayMethods $module.Types
 $output=Join-Path $target $file.Name
 $module.Write($output);$module.Dispose()
 $a=[Mono.Cecil.ModuleDefinition]::ReadModule($file.FullName)
 $b=[Mono.Cecil.ModuleDefinition]::ReadModule($output)
 if($a.Assembly.Name.Version -ne $b.Assembly.Name.Version){throw 'Assembly version changed'}
 CheckMethods $a.Types $b.Types
 $a.Dispose();$b.Dispose()
 Write-Output "$($record.Name) checked, replaced $resourceChanges UI resources"
}
