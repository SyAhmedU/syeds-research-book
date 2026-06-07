<#
  Syed's Research Book — Phase 1 data split.
  Reads data/papers.json (canonical full export) and writes the two files the app loads:
    papers.index.json   every field EXCEPT abstract  (loaded eagerly, instant)
    abstracts.json      { paperId: abstract }        (loaded lazily on first detail open)
  Pure transform, no deps.
#>
param(
  [string]$DataDir = (Join-Path $PSScriptRoot '..\data')
)
$ErrorActionPreference='Stop'
$DataDir = [System.IO.Path]::GetFullPath($DataDir)

function J($s){
  if($null -eq $s){ return 'null' }
  $t=[string]$s; $sb=New-Object System.Text.StringBuilder; [void]$sb.Append('"')
  foreach($ch in $t.ToCharArray()){
    switch($ch){
      '"'{[void]$sb.Append('\"')} '\'{[void]$sb.Append('\\')}
      "`n"{[void]$sb.Append('\n')} "`r"{[void]$sb.Append('\r')} "`t"{[void]$sb.Append('\t')}
      default{ if([int][char]$ch -lt 32){[void]$sb.Append('\u{0:x4}' -f [int][char]$ch)}else{[void]$sb.Append($ch)} }
    }
  }
  [void]$sb.Append('"'); $sb.ToString()
}
function Jnum($v){ if($null -eq $v -or $v -eq ''){'null'}else{[string]$v} }
function Jbool($b){ if($b){'true'}else{'false'} }
function Jarr($a){ if($null -eq $a){return '[]'}; '['+(($a|ForEach-Object{ J $_ }) -join ',')+']' }

Write-Host "reading papers.json..."
$papers = Get-Content (Join-Path $DataDir 'papers.json') -Raw | ConvertFrom-Json
Write-Host "  papers: $($papers.Count)"

$ib=New-Object System.Text.StringBuilder; [void]$ib.Append('['); $f1=$true
$ab=New-Object System.Text.StringBuilder; [void]$ab.Append('{'); $f2=$true; $nAbs=0
foreach($p in $papers){
  if(-not $f1){[void]$ib.Append(',')}; $f1=$false
  [void]$ib.Append('{"id":'+(J $p.id))
  [void]$ib.Append(',"doi":'+(J $p.doi))
  [void]$ib.Append(',"title":'+(J $p.title))
  [void]$ib.Append(',"briefTitle":'+(J $p.briefTitle))
  [void]$ib.Append(',"authors":'+(Jarr $p.authors))
  [void]$ib.Append(',"year":'+(Jnum $p.year))
  [void]$ib.Append(',"citations":'+(Jnum $p.citations))
  [void]$ib.Append(',"journal":'+(J $p.journal))
  [void]$ib.Append(',"type":'+(J $p.type))
  [void]$ib.Append(',"scopusCategory":'+(J $p.scopusCategory))
  [void]$ib.Append(',"scopusPercentile":'+(Jnum $p.scopusPercentile))
  [void]$ib.Append(',"publisher":'+(J $p.publisher))
  [void]$ib.Append(',"openAccess":'+(Jbool $p.openAccess))
  [void]$ib.Append(',"oaUrl":'+(J $p.oaUrl))
  [void]$ib.Append(',"rgUrl":'+(J $p.rgUrl))
  [void]$ib.Append(',"connectedPapersUrl":'+(J $p.connectedPapersUrl))
  [void]$ib.Append(',"scihubUrl":'+(J $p.scihubUrl))
  [void]$ib.Append(',"bibtexUrl":'+(J $p.bibtexUrl))
  [void]$ib.Append(',"constructCodes":'+(Jarr $p.constructCodes))
  [void]$ib.Append(',"hasAbstract":'+(Jbool ([bool]$p.abstract)))
  [void]$ib.Append(',"absSrc":'+(J $p.absSrc))
  [void]$ib.Append('}')
  if($p.abstract){ if(-not $f2){[void]$ab.Append(',')}; $f2=$false; [void]$ab.Append((J $p.id)+':'+(J $p.abstract)); $nAbs++ }
}
[void]$ib.Append(']'); [void]$ab.Append('}')
[System.IO.File]::WriteAllText((Join-Path $DataDir 'papers.index.json'), $ib.ToString(), [System.Text.Encoding]::UTF8)
[System.IO.File]::WriteAllText((Join-Path $DataDir 'abstracts.json'),    $ab.ToString(), [System.Text.Encoding]::UTF8)

$idx=Get-Item (Join-Path $DataDir 'papers.index.json'); $abs=Get-Item (Join-Path $DataDir 'abstracts.json')
Write-Host ("DONE.  papers.index.json {0:N1} MB ({1} papers)  |  abstracts.json {2:N1} MB ({3} abstracts)" -f ($idx.Length/1MB),$papers.Count,($abs.Length/1MB),$nAbs)
