<#
  One-off backfill: strip placeholder authors ("Authors Not Found", "undefined undefined")
  from the already-generated data/papers.json, then re-run split-data.ps1.
  Uses the SAME serializer as convert-xlsx.ps1 and self-checks that a no-op re-serialization
  is byte-identical to the committed file, so the ONLY change is the author arrays.
  (The same rule now lives in convert-xlsx.ps1's Authors() for future regenerations.)
#>
$ErrorActionPreference='Stop'
$dir = (Join-Path $PSScriptRoot '..\data'); $dir=[System.IO.Path]::GetFullPath($dir)
$src = Join-Path $dir 'papers.json'

function CleanAuthor($a){ $t=([string]$a).Trim(); while($t -cmatch '^undefined\s+'){ $t=($t -creplace '^undefined\s+','').Trim() }; if($t -match '(?i)^(authors?\s+not\s+found|undefined|n/a|not\s+found)$'){ return '' }; $t }

# --- serializer: identical to convert-xlsx.ps1 ---
function J($s){ if($null -eq $s){return 'null'}; $t=[string]$s; $sb=New-Object System.Text.StringBuilder; [void]$sb.Append('"')
  foreach($ch in $t.ToCharArray()){ switch($ch){ '"'{[void]$sb.Append('\"')} '\'{[void]$sb.Append('\\')} "`n"{[void]$sb.Append('\n')} "`r"{[void]$sb.Append('\r')} "`t"{[void]$sb.Append('\t')}
    default{ if([int][char]$ch -lt 32){[void]$sb.Append('\u{0:x4}' -f [int][char]$ch)}else{[void]$sb.Append($ch)} } } }
  [void]$sb.Append('"'); $sb.ToString() }
function Jnum($v){ if($null -eq $v -or $v -eq ''){'null'}else{[string]$v} }
function Jbool($b){ if($b){'true'}else{'false'} }
function Jarr($a){ if($null -eq $a){return '[]'}; '['+(($a|ForEach-Object{ J $_ }) -join ',')+']' }

function Serialize($papers,[bool]$clean){
  $pb=New-Object System.Text.StringBuilder; [void]$pb.Append('['); $first=$true
  $cleaned=0; $emptied=0
  foreach($p in $papers){
    $a = @($p.authors)
    if($clean){ $f=@($a | ForEach-Object { CleanAuthor $_ } | Where-Object { $_ }); if(($f -join '|') -ne ($a -join '|')){ $cleaned++; if($f.Count -eq 0){$emptied++} }; $a=$f }
    if(-not $first){[void]$pb.Append(',')}; $first=$false
    [void]$pb.Append('{')
    [void]$pb.Append('"id":'+(J $p.id))
    [void]$pb.Append(',"doi":'+(J $p.doi))
    [void]$pb.Append(',"title":'+(J $p.title))
    [void]$pb.Append(',"briefTitle":'+(J $p.briefTitle))
    [void]$pb.Append(',"authors":'+(Jarr $a))
    [void]$pb.Append(',"year":'+(Jnum $p.year))
    [void]$pb.Append(',"citations":'+(Jnum $p.citations))
    [void]$pb.Append(',"journal":'+(J $p.journal))
    [void]$pb.Append(',"type":'+(J $p.type))
    [void]$pb.Append(',"scopusCategory":'+(J $p.scopusCategory))
    [void]$pb.Append(',"scopusPercentile":'+(Jnum $p.scopusPercentile))
    [void]$pb.Append(',"publisher":'+(J $p.publisher))
    [void]$pb.Append(',"openAccess":'+(Jbool $p.openAccess))
    [void]$pb.Append(',"oaUrl":'+(J $p.oaUrl))
    [void]$pb.Append(',"abstract":'+(J $p.abstract))
    [void]$pb.Append(',"rgUrl":'+(J $p.rgUrl))
    [void]$pb.Append(',"connectedPapersUrl":'+(J $p.connectedPapersUrl))
    [void]$pb.Append(',"scihubUrl":'+(J $p.scihubUrl))
    [void]$pb.Append(',"bibtexUrl":'+(J $p.bibtexUrl))
    [void]$pb.Append(',"constructCodes":'+(Jarr $p.constructCodes))
    [void]$pb.Append('}')
  }
  [void]$pb.Append(']')
  [pscustomobject]@{ text=$pb.ToString(); cleaned=$cleaned; emptied=$emptied }
}

Write-Host "reading papers.json..."
$papers = Get-Content $src -Raw | ConvertFrom-Json
Write-Host "  papers: $($papers.Count)"

# --- SELF-CHECK: re-serialize with NO cleaning, must equal the original file exactly ---
$orig = [System.IO.File]::ReadAllText($src)
$noop = (Serialize $papers $false).text
if($noop -ne $orig){
  $i=0; while($i -lt [Math]::Min($noop.Length,$orig.Length) -and $noop[$i] -eq $orig[$i]){$i++}
  Write-Host "SELF-CHECK FAILED at char $i (orig len $($orig.Length), reserialized $($noop.Length))"
  Write-Host ("  orig ...: " + $orig.Substring([Math]::Max(0,$i-40),80))
  Write-Host ("  new  ...: " + $noop.Substring([Math]::Max(0,$i-40),80))
  throw "Serializer is not faithful - aborting, no files written."
}
Write-Host "SELF-CHECK OK: no-op re-serialization is byte-identical to papers.json"

# --- write the cleaned version ---
$res = Serialize $papers $true
[System.IO.File]::WriteAllText($src, $res.text, [System.Text.Encoding]::UTF8)
Write-Host "cleaned author lists: $($res.cleaned)  (emptied: $($res.emptied))  -> papers.json rewritten"
