<#
  CorpusScope — Phase 0 converter.
  Turns Syed's 24-month research-master .xlsx into clean, versioned JSON.

  Source (NOT committed; 27 MB): Google Drive id 1ZnImdN4SjXAod0TLq7Qwob0yZeiwIZhG
    export:  https://docs.google.com/spreadsheets/d/<id>/export?format=xlsx
  Regenerate:
    powershell -File scripts/convert-xlsx.ps1 -Xlsx <path-to.xlsx> -OutDir data

  Outputs (data/):
    constructs.json   167 clusters: no, code, name, identifiers[], counts
    papers.json       unique papers (dedup by DOI): bibliographic + Scopus + abstract + real link URLs + constructCodes[]
    memberships.json  paper<->construct edges {c: code, p: paperId}
    summary.json      counts, distributions, cleaning report

  Pure transform. NO AI, NO fabrication: every field is copied/normalised from the sheet.
#>
param(
  [string]$Xlsx   = (Join-Path $env:TEMP 'research_master.xlsx'),
  [string]$OutDir = (Join-Path $PSScriptRoot '..\data'),
  [switch]$SkipMasterCheck
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Force -Path $OutDir | Out-Null }
Write-Host "xlsx : $Xlsx"
Write-Host "out  : $OutDir"

function Unescape($s){
  if($null -eq $s){return ''}
  # Source data is sometimes double-encoded (e.g. "&amp;amp;"); decode until stable.
  $prev=[string]$s
  for($i=0;$i -lt 4;$i++){ $cur=[System.Net.WebUtility]::HtmlDecode($prev); if($cur -eq $prev){break}; $prev=$cur }
  $prev
}
# minimal JSON string escaper
function J($s){
  if($null -eq $s){ return 'null' }
  $t = [string]$s
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.Append('"')
  foreach($ch in $t.ToCharArray()){
    switch($ch){
      '"'  { [void]$sb.Append('\"') }
      '\'  { [void]$sb.Append('\\') }
      "`n" { [void]$sb.Append('\n') }
      "`r" { [void]$sb.Append('\r') }
      "`t" { [void]$sb.Append('\t') }
      default {
        if([int][char]$ch -lt 32){ [void]$sb.Append('\u{0:x4}' -f [int][char]$ch) }
        else { [void]$sb.Append($ch) }
      }
    }
  }
  [void]$sb.Append('"')
  $sb.ToString()
}
function Jnum($v){ if($null -eq $v -or $v -eq ''){ 'null' } else { [string]$v } }
function Jbool($b){ if($b){'true'}else{'false'} }
function Jarr($items){ '[' + (($items | ForEach-Object { J $_ }) -join ',') + ']' }

$zip = [System.IO.Compression.ZipFile]::OpenRead($Xlsx)
function Entry($name){ $zip.GetEntry($name) }
function ReadText($name){ $e=Entry $name; if(-not $e){return $null}; $r=New-Object System.IO.StreamReader($e.Open()); $t=$r.ReadToEnd(); $r.Close(); $t }

# ---- shared strings ----
Write-Host "building shared strings..."
$ss = New-Object System.Collections.Generic.List[string]
$e=Entry 'xl/sharedStrings.xml'; $rs=$e.Open(); $xr=[System.Xml.XmlReader]::Create($rs)
while(-not $xr.EOF){
  if($xr.NodeType -eq 'Element' -and $xr.LocalName -eq 'si'){
    $o=$xr.ReadOuterXml()
    $t=([regex]::Matches($o,'<t[^>]*>(.*?)</t>','Singleline')|ForEach-Object{$_.Groups[1].Value}) -join ''
    $ss.Add((Unescape $t)); continue
  }
  [void]$xr.Read()
}
$xr.Close(); $rs.Close()
Write-Host "  shared strings: $($ss.Count)"

# ---- read a sheet's rows as ordered hashtables + hyperlink URLs by cellref ----
function Read-Sheet($entryName){
  $en=Entry $entryName; $s=$en.Open(); $r=[System.Xml.XmlReader]::Create($s)
  $rows=New-Object System.Collections.Generic.List[object]
  $hyper=@{}   # cellref -> rId
  while(-not $r.EOF){
    if($r.NodeType -eq 'Element' -and $r.LocalName -eq 'row'){
      $rowXml=$r.ReadOuterXml()
      $rn=([regex]::Match($rowXml,'<row[^>]*\br="(\d+)"')).Groups[1].Value
      $h=@{ _r=$rn }
      foreach($m in [regex]::Matches($rowXml,'<c r="([A-Z]+)\d+"([^>]*?)(?:/>|>(.*?)</c>)','Singleline')){
        $col=$m.Groups[1].Value; $t=([regex]::Match($m.Groups[2].Value,'t="([^"]+)"')).Groups[1].Value; $inner=$m.Groups[3].Value
        $val=''; $vm=[regex]::Match($inner,'<v>(.*?)</v>','Singleline')
        if($vm.Success){$val=$vm.Groups[1].Value}else{$tm=[regex]::Match($inner,'<t[^>]*>(.*?)</t>','Singleline'); if($tm.Success){$val=$tm.Groups[1].Value}}
        if($t -eq 's'){$i=[int]$val; if($i -ge 0 -and $i -lt $ss.Count){$val=$ss[$i]}} else {$val=Unescape $val}
        $h[$col]=$val.Trim()
      }
      $rows.Add($h); continue
    }
    elseif($r.NodeType -eq 'Element' -and $r.LocalName -eq 'hyperlinks'){
      $hx=$r.ReadOuterXml()
      foreach($m in [regex]::Matches($hx,'<hyperlink[^>]*\bref="([^"]+)"[^>]*\br:id="([^"]+)"')){ $hyper[$m.Groups[1].Value]=$m.Groups[2].Value }
      continue
    }
    [void]$r.Read()
  }
  $r.Close(); $s.Close()
  # resolve rId -> url from this sheet's rels
  $relName = $entryName -replace 'worksheets/','worksheets/_rels/'
  $relName = $relName + '.rels'
  $url=@{}
  $relTxt = ReadText $relName
  if($relTxt){
    foreach($m in [regex]::Matches($relTxt,'<Relationship[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*?>')){ $url[$m.Groups[1].Value]=(Unescape $m.Groups[2].Value) }
    foreach($m in [regex]::Matches($relTxt,'<Relationship[^>]*\bTarget="([^"]+)"[^>]*\bId="([^"]+)"[^>]*?>')){ if(-not $url.ContainsKey($m.Groups[2].Value)){ $url[$m.Groups[2].Value]=(Unescape $m.Groups[1].Value) } }
  }
  $linkFor = @{}   # cellref -> url
  foreach($k in $hyper.Keys){ $rid=$hyper[$k]; if($url.ContainsKey($rid)){ $linkFor[$k]=$url[$rid] } }
  [pscustomobject]@{ rows=$rows; links=$linkFor }
}

# ---- workbook: tab name -> sheet file ----
$wb = ReadText 'xl/workbook.xml'
$rels = ReadText 'xl/_rels/workbook.xml.rels'
$relMap=@{}
foreach($m in [regex]::Matches($rels,'<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"')){ $relMap[$m.Groups[1].Value]=$m.Groups[2].Value }
foreach($m in [regex]::Matches($rels,'<Relationship[^>]*Target="([^"]+)"[^>]*Id="([^"]+)"')){ if(-not $relMap.ContainsKey($m.Groups[2].Value)){$relMap[$m.Groups[2].Value]=$m.Groups[1].Value} }
$tabFile=[ordered]@{}
foreach($m in [regex]::Matches($wb,'<sheet\b[^>]*/>')){
  $el=$m.Value
  $name=([regex]::Match($el,'name="([^"]*)"')).Groups[1].Value
  $rid =([regex]::Match($el,'r:id="([^"]*)"')).Groups[1].Value
  $tgt =$relMap[$rid]; if($tgt -and $tgt -notlike 'xl/*'){ $tgt = 'xl/' + $tgt }
  $tabFile[$name]=$tgt
}

# ---- taxonomy (sheet "Variable Clusters") ----
Write-Host "parsing taxonomy..."
$taxFile = $tabFile['Variable Clusters']
$tax = (Read-Sheet $taxFile).rows
$constructs=New-Object System.Collections.Generic.List[object]
$codeSet=New-Object 'System.Collections.Generic.HashSet[string]'
foreach($row in $tax){
  if($row['A'] -match '^\d+$' -and $row['C']){
    $ids = @()
    if($row['F']){ $ids = $row['F'].Split('|') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
    $code = $row['C'].Trim()
    [void]$codeSet.Add($code)
    $constructs.Add([pscustomobject]@{ no=[int]$row['A']; code=$code; name=$row['B'].Trim(); identifiers=$ids; paperCountSheet=([int]($row['D'])) })
  }
}
Write-Host "  constructs: $($constructs.Count)"

# ---- clean helpers ----
function NormDoi($s){ if(-not $s){return $null}; $m=[regex]::Match($s,'10\.\d{4,9}/[^\s"<>]+'); if(-not $m.Success){return $null}; ($m.Value -replace '[.,;]+$','').ToLower() }
function CleanYear($s){ if($s -match '(\d{4})'){ $y=[int]$matches[1]; if($y -ge 1900 -and $y -le 2026){ return $y } }; return $null }
function CleanAbstract($s){ if(-not $s){return $null}; if($s -match '(?i)abstract\s*not\s*found'){return $null}; $t=$s -replace '^\s*Abstract\s*',''; $t=$t.Trim(); if($t.Length -lt 60){return $null}; $t }
function CleanJournal($s){ if(-not $s){return $null}; if($s -match '(?i)journal\s*name\s*not\s*found'){return $null}; $s.Trim() }
function CleanPct($s){ if($s -match '(\d+)'){ return [int]$matches[1] }; return $null }
function RealUrl($u){ if($u -and $u -match '^https?://'){ return $u }; return $null }
function Authors($s){ if(-not $s){return @()}; $s.Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ } }
# null literal placeholder values ("N/A", "No Link Available", "-", …)
function Nullish($s){ if($null -eq $s){return $null}; $t=([string]$s).Trim(); if($t -eq ''){return $null}; if($t -match '^(n/?a|na|none|null|nil|unknown|-+|—+|not\s*available|no\s+.*available|not\s*found)$'){return $null}; $t }
# classify record kind from the source name (datasets & preprints are not journal articles)
function PaperType($j){ if(-not $j){return 'article'}; $x=$j.ToLower(); if($x -match 'psyctests|psycextra' -or $x -match 'dataset$'){return 'dataset'}; if($x -match 'ssrn|preprint|arxiv|biorxiv|osf preprints'){return 'preprint'}; if($x -match 'proceedings'){return 'proceedings'}; 'article' }
# journal-name normalization helpers (merge SAME journal across case/space/trailing-punct variants)
function JournalKey($s){ if(-not $s){return $null}; $t=[string]$s; $t=$t -replace '\s+',' '; $t=$t.Trim(); $t=$t -replace '[.,;:]+$',''; $t=$t.Trim(); $t.ToLowerInvariant() }
# prefer mixed/proper case over ALL-CAPS or all-lowercase when choosing the canonical spelling
function CaseScore($s){ $lo=$s -cmatch '[a-z]'; $up=$s -cmatch '[A-Z]'; if($lo -and $up){2}elseif($up){1}else{0} }

# ---- parse all cluster sheets, dedup by DOI ----
Write-Host "parsing cluster sheets..."
$papers=[ordered]@{}            # key -> paper object
$order=New-Object System.Collections.Generic.List[string]
$memberships=New-Object System.Collections.Generic.List[object]
$actualCount=@{}                # code -> distinct papers
$dirtyYear=0; $noDoi=0; $totalRows=0
foreach($c in $constructs){
  $file=$tabFile[$c.code]; if(-not $file){ Write-Host "  WARN no sheet for code $($c.code)"; continue }
  $sh=Read-Sheet $file
  $seenInThis=New-Object 'System.Collections.Generic.HashSet[string]'
  $first=$true
  foreach($row in $sh.rows){
    if($first){ $first=$false; continue }   # header
    if(-not ($row.Keys | Where-Object { $_ -ne '_r' })){ continue }
    if(-not $row['B'] -and -not $row['C'] -and -not $row['G']){ continue }
    $totalRows++
    $doi=NormDoi $row['G']
    $title=if($row['B']){$row['B'].Trim()}else{''}
    $key = if($doi){ "doi:$doi" } else { $noDoi++; "ttl:" + (($title.ToLower() -replace '[^a-z0-9]','')) }
    if($key -eq 'ttl:'){ continue }
    $rn=$row['_r']
    if(-not $papers.Contains($key)){
      $yr=CleanYear $row['F']; if(-not $yr -and $row['F']){ $dirtyYear++ }
      $jr = Nullish (CleanJournal $row['H'])
      $p=[ordered]@{
        id        = if($doi){$doi}else{$key}
        doi       = $doi
        title     = $title
        briefTitle= Nullish $row['C']
        authors   = Authors $row['D']
        year      = $yr
        citations = if($row['E'] -match '^\d+$'){[int]$row['E']}else{$null}
        journal   = $jr
        type      = PaperType $jr
        scopusCategory   = Nullish $row['I']
        scopusPercentile = CleanPct $row['J']
        publisher = Nullish $row['K']
        openAccess= ($row['L'] -match '(?i)^open access')
        oaStatus  = if($row['L']){$row['L'].Trim()}else{$null}
        oaUrl     = RealUrl $sh.links["M$rn"]
        abstract  = CleanAbstract $row['N']
        rgUrl     = RealUrl $sh.links["O$rn"]
        connectedPapersUrl = RealUrl $sh.links["P$rn"]
        scihubUrl = RealUrl $sh.links["Q$rn"]
        bibtexUrl = RealUrl $sh.links["R$rn"]
        constructCodes = New-Object System.Collections.Generic.List[string]
      }
      $papers[$key]=$p; $order.Add($key)
    } else {
      # merge: fill gaps from this occurrence
      $p=$papers[$key]
      if(-not $p.abstract){ $p.abstract = CleanAbstract $row['N'] }
      if(-not $p.year){ $p.year = CleanYear $row['F'] }
      if(-not $p.journal){ $j2=Nullish (CleanJournal $row['H']); if($j2){ $p.journal=$j2; $p.type=PaperType $j2 } }
      if(-not $p.publisher){ $p.publisher = Nullish $row['K'] }
      if(-not $p.scopusCategory){ $p.scopusCategory = Nullish $row['I'] }
      if(-not $p.oaUrl){ $p.oaUrl = RealUrl $sh.links["M$rn"] }
      if(($p.authors).Count -eq 0){ $p.authors = Authors $row['D'] }
    }
    $p=$papers[$key]
    if(-not $p.constructCodes.Contains($c.code)){ $p.constructCodes.Add($c.code) }
    if($seenInThis.Add($key)){ $memberships.Add([pscustomobject]@{ c=$c.code; p=$p.id }) }
  }
  $actualCount[$c.code]=$seenInThis.Count
}
Write-Host "  cluster rows read: $totalRows ; unique papers: $($papers.Count) ; no-DOI dropped: $noDoi"

# ---- optional: confirm master tabs add nothing (DOIs not in clusters) ----
$masterOrphans=0
if(-not $SkipMasterCheck){
  Write-Host "checking master tabs for orphan DOIs..."
  $clusterDois=New-Object 'System.Collections.Generic.HashSet[string]'
  foreach($k in $order){ $d=$papers[$k].doi; if($d){[void]$clusterDois.Add($d)} }
  foreach($mt in @('1-7000','7001-17942')){
    $mf=$tabFile[$mt]; if(-not $mf){continue}
    $ms=Read-Sheet $mf; $f=$true
    foreach($row in $ms.rows){ if($f){$f=$false;continue}; $d=NormDoi $row['G']; if($d -and -not $clusterDois.Contains($d)){ $masterOrphans++ } }
  }
  Write-Host "  master orphan DOIs (not in any cluster): $masterOrphans"
}

# ---- journal-name normalization ----
# Merge spelling variants of the SAME journal (case / whitespace / trailing punctuation).
# Canonical = the most common real spelling already present in the corpus; tie-break prefers
# proper (mixed) case, then ordinal. No name is invented and distinct journals never merge.
Write-Host "normalizing journal names..."
$jFreq = New-Object 'System.Collections.Generic.Dictionary[string,int]' ([System.StringComparer]::Ordinal)
foreach($k in $order){ $jn=$papers[$k].journal; if($jn){ if($jFreq.ContainsKey($jn)){$jFreq[$jn]++}else{$jFreq[$jn]=1} } }
$jGroups = New-Object 'System.Collections.Generic.Dictionary[string,System.Collections.Generic.List[string]]' ([System.StringComparer]::Ordinal)
foreach($raw in $jFreq.Keys){ $nk=JournalKey $raw; if(-not $jGroups.ContainsKey($nk)){ $jGroups[$nk]=New-Object System.Collections.Generic.List[string] }; $jGroups[$nk].Add($raw) }
$jCanon = New-Object 'System.Collections.Generic.Dictionary[string,string]' ([System.StringComparer]::Ordinal)
$journalMerges = 0
foreach($nk in $jGroups.Keys){
  $variants = $jGroups[$nk]
  $canon = ($variants | Sort-Object @{Expression={$jFreq[$_]};Descending=$true}, @{Expression={CaseScore $_};Descending=$true}, @{Expression={$_};Descending=$false} | Select-Object -First 1)
  foreach($v in $variants){ $jCanon[$v]=$canon }
  if($variants.Count -gt 1){ $journalMerges += ($variants.Count - 1) }
}
foreach($k in $order){ $p=$papers[$k]; if($p.journal -and $jCanon.ContainsKey($p.journal) -and $jCanon[$p.journal] -ne $p.journal){ $p.journal=$jCanon[$p.journal]; $p.type=PaperType $p.journal } }
Write-Host "  journals: $($jFreq.Count) raw -> $($jGroups.Count) canonical ($journalMerges variant(s) merged)"

# ---- write JSON ----
Write-Host "writing JSON..."
# constructs.json
$cb=New-Object System.Text.StringBuilder; [void]$cb.Append('[')
for($i=0;$i -lt $constructs.Count;$i++){
  $c=$constructs[$i]; if($i){[void]$cb.Append(',')}
  [void]$cb.Append('{"no":'+$c.no+',"code":'+(J $c.code)+',"name":'+(J $c.name)+',"identifiers":'+(Jarr $c.identifiers)+',"paperCountSheet":'+$c.paperCountSheet+',"paperCount":'+([int]$actualCount[$c.code])+'}')
}
[void]$cb.Append(']')
[System.IO.File]::WriteAllText((Join-Path $OutDir 'constructs.json'), $cb.ToString(), [System.Text.Encoding]::UTF8)

# papers.json
$pb=New-Object System.Text.StringBuilder; [void]$pb.Append('['); $firstP=$true
foreach($k in $order){
  $p=$papers[$k]; if(-not $firstP){[void]$pb.Append(',')}; $firstP=$false
  [void]$pb.Append('{')
  [void]$pb.Append('"id":'+(J $p.id))
  [void]$pb.Append(',"doi":'+(J $p.doi))
  [void]$pb.Append(',"title":'+(J $p.title))
  [void]$pb.Append(',"briefTitle":'+(J $p.briefTitle))
  [void]$pb.Append(',"authors":'+(Jarr $p.authors))
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
[System.IO.File]::WriteAllText((Join-Path $OutDir 'papers.json'), $pb.ToString(), [System.Text.Encoding]::UTF8)

# memberships.json
$mb=New-Object System.Text.StringBuilder; [void]$mb.Append('['); $firstM=$true
foreach($m in $memberships){ if(-not $firstM){[void]$mb.Append(',')}; $firstM=$false; [void]$mb.Append('{"c":'+(J $m.c)+',"p":'+(J $m.p)+'}') }
[void]$mb.Append(']')
[System.IO.File]::WriteAllText((Join-Path $OutDir 'memberships.json'), $mb.ToString(), [System.Text.Encoding]::UTF8)

# ---- summary ----
$withAbs=0; $oa=0; $byYear=@{}; $byBand=@{}; $journals=@{}
foreach($k in $order){
  $p=$papers[$k]
  if($p.abstract){$withAbs++}
  if($p.openAccess){$oa++}
  if($p.year){ $d=[math]::Floor($p.year/10)*10; $byYear["${d}s"]=1+$byYear["${d}s"] }
  if($null -ne $p.scopusPercentile){ $b=$p.scopusPercentile; $key=if($b -ge 90){'p90_99'}elseif($b -ge 75){'p75_89'}elseif($b -ge 50){'p50_74'}elseif($b -ge 25){'p25_49'}else{'p0_24'}; $byBand[$key]=1+$byBand[$key] }
  if($p.journal){ $journals[$p.journal]=1+$journals[$p.journal] }
}
$topJ=$journals.GetEnumerator()|Sort-Object Value -Descending|Select-Object -First 40
$sb2=New-Object System.Text.StringBuilder
[void]$sb2.Append('{')
[void]$sb2.Append('"generatedAt":'+(J (Get-Date -Format 's')))
[void]$sb2.Append(',"constructs":'+$constructs.Count)
[void]$sb2.Append(',"uniquePapers":'+$papers.Count)
[void]$sb2.Append(',"clusterMemberships":'+$memberships.Count)
[void]$sb2.Append(',"clusterRowsRead":'+$totalRows)
[void]$sb2.Append(',"withAbstract":'+$withAbs)
[void]$sb2.Append(',"openAccess":'+$oa)
[void]$sb2.Append(',"droppedNoDoi":'+$noDoi)
[void]$sb2.Append(',"dirtyYears":'+$dirtyYear)
[void]$sb2.Append(',"masterOrphanDois":'+$masterOrphans)
[void]$sb2.Append(',"distinctJournals":'+$jGroups.Count)
[void]$sb2.Append(',"journalVariantsMerged":'+$journalMerges)
[void]$sb2.Append(',"byDecade":{'+(($byYear.GetEnumerator()|Sort-Object Name|ForEach-Object{ (J $_.Name)+':'+$_.Value }) -join ',')+'}')
[void]$sb2.Append(',"byScopusBand":{'+(($byBand.GetEnumerator()|Sort-Object Name|ForEach-Object{ (J $_.Name)+':'+$_.Value }) -join ',')+'}')
[void]$sb2.Append(',"topJournals":['+(($topJ|ForEach-Object{ '{"journal":'+(J $_.Name)+',"papers":'+$_.Value+'}' }) -join ',')+']')
[void]$sb2.Append('}')
[System.IO.File]::WriteAllText((Join-Path $OutDir 'summary.json'), $sb2.ToString(), [System.Text.Encoding]::UTF8)

$zip.Dispose()
Write-Host ""
Write-Host "DONE."
Write-Host ("  constructs.json   {0:N0} constructs" -f $constructs.Count)
Write-Host ("  papers.json       {0:N0} unique papers" -f $papers.Count)
Write-Host ("  memberships.json  {0:N0} edges" -f $memberships.Count)
Write-Host ("  withAbstract={0}  openAccess={1}  noDoiDropped={2}  dirtyYears={3}  masterOrphans={4}" -f $withAbs,$oa,$noDoi,$dirtyYear,$masterOrphans)
