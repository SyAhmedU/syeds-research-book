// All-years imports are separate from hand coding and the 2024+ tier.
const managementShardCache=new Map();
async function managementJson(path){
  const response=await fetch(path);if(!response.ok)throw Error('Import evidence unavailable');
  if(!path.endsWith('.gz'))return response.json();
  return new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).json();
}
function managementShardOf(value){let h=0;for(let i=0;i<value.length;i++)h=(h*31+value.charCodeAt(i))>>>0;return String(h%64).padStart(2,'0');}
async function managementShard(kind,key){
  const path=`./data/management/${kind}/${managementShardOf(key)}.json${S.managementManifest?.compression==='gzip'?'.gz':''}`;
  if(!managementShardCache.has(path))managementShardCache.set(path,managementJson(path).catch(error=>{managementShardCache.delete(path);throw error;}));
  return managementShardCache.get(path);
}
async function managementAbstract(id){const shard=await managementShard('abstracts',id);return shard[id]||'';}
function applyManagementSourceAliases(){
  if(!S.sourceTypes||!S.managementSourceAliases)return;
  S.managementConferenceDois=new Set(S.managementSourceAliases.conferenceDois);
  S.sourceAliases=new Map();
  for(const alias of S.managementSourceAliases.aliases){
    const key=sourceTitleKey(alias.name),existing=S.sourceTypes.get(key);
    if(existing&&existing!==alias.sourceType)continue;
    S.sourceTypes.set(key,alias.sourceType);S.sourceAliases.set(key,alias);
  }
}
function canonicalSourceName(name){return S.sourceAliases?.get(sourceTitleKey(name))?.canonicalName||name;}
function managementCrossrefCoverage(manifest){
  const report=manifest.crossref;if(!report)return '';
  if(report.mode!=='full-cursor')return `Crossref adds ${report.records.toLocaleString()} DOI-deduplicated records from bounded batches in ${report.batches.length} Q1/Q2 journals. `;
  const states=report.sourceStatus||{};
  return `Crossref contributes ${report.records.toLocaleString()} DOI-deduplicated records and ${report.abstracts.toLocaleString()} publisher-deposited abstracts. Full pagination completed for ${(states.complete||0).toLocaleString()} of ${report.batches.length.toLocaleString()} selected sources; ${(states.unavailable||0).toLocaleString()} have no matching Crossref endpoint and ${(states.error||0).toLocaleString()} require review. Journal and conference queues are separate. `;
}
function managementReferenceCoverage(manifest){
  const states=manifest.referenceTargets||{};
  return `${manifest.referenceEdges.toLocaleString()} observed reference links; ${(states.pending||0).toLocaleString()} identities still queued for metadata lookup. ${(states['not-returned-by-openalex']||0).toLocaleString()} identities were not returned by OpenAlex and ${(states['missing-title-in-openalex']||0).toLocaleString()} returned without a title. ${(states['outside-management-journals']||0).toLocaleString()} targets were classified outside the management-journal scope. ${manifest.citedManagementJournals.toLocaleString()} management journals identified in resolved references.`;
}
async function initManagementImport(){
  const checkbox=$('#fManagement'),label=$('#fManagementLbl');
  checkbox.disabled=true;
  checkbox.onchange=async()=>{
    F.management=checkbox.checked;S.page=0;
    if(F.management)await loadManagementImport();
    refreshLibraryFacets();applyAndRender();updateFreshNote();
  };
  try{
    const response=await fetch('./data/management/manifest.json');
    if(!response.ok){$('#fManagementBox').hidden=true;return;}
    S.managementManifest=await response.json();
    if(S.managementManifest.sourceAliases){
      S.managementSourceAliases=await managementJson('./data/management/'+S.managementManifest.sourceAliases);
      applyManagementSourceAliases();
    }
    checkbox.disabled=false;
    const manifest=S.managementManifest;
    label.textContent=`+ All-years import (${manifest.publishedNewPapers.toLocaleString()} · ${manifest.status==='complete'?'complete':'partial'})`;
    const panel=$('#managementCoverage');panel.hidden=false;
    panel.innerHTML=`<summary>Management import coverage · ${manifest.publishedNewPapers.toLocaleString()} additional papers</summary><p>${manifest.receivedJournalWorks.toLocaleString()} OpenAlex Q1/Q2 journal records retrieved from searches returning ${manifest.knownAvailableJournalWorks.toLocaleString()} all-years records. The current snapshot starts with older records; newer years are also covered by the separate recent tier. ${managementCrossrefCoverage(manifest)} ${manifest.papersWithAbstract.toLocaleString()} additional papers have provider-supplied abstracts. ${manifest.papersWithoutDoi.toLocaleString()} have an OpenAlex identity but no DOI.</p><p>${managementReferenceCoverage(manifest)} Conference records remain a separate source type. Highest-category 2025 rankings describe the source selection, not each historical paper.</p><p>${manifest.status==='complete'?'All current source imports and reference lookups completed.':'Partial snapshot: more records remain. '+(manifest.status==='daily-budget-limited'?'The OpenAlex snapshot stopped at its daily API allowance. ':'The import has a saved continuation checkpoint. ')}Construct tags are machine-matched against the existing lexicon; verify before citing.</p><div id="managementCitedJournals"></div>`;
    const citedResponse=await fetch('./data/management/cited-journals.json');
    if(citedResponse.ok){
      const cited=await citedResponse.json();
      $('#managementCitedJournals').innerHTML='<b>Most referenced management journals in this imported snapshot</b><div class="chips">'+cited.journals.slice(0,10).map(j=>`<button class="chip" type="button" data-import-journal="${esc(j.name)}">${esc(j.name)} · ${j.referenceEdges.toLocaleString()} links</button>`).join('')+'</div><small>Observed links in fetched papers, not a journal impact metric or complete citation coverage.</small>';
      $('#managementCitedJournals').onclick=async event=>{
        const target=event.target.closest('[data-import-journal]');if(!target)return;
        checkbox.checked=true;F.management=true;await loadManagementImport();
        F.sourceType='journal';$('#fSourceType').value='journal';F.journal=target.dataset.importJournal;buildJournalSelect();S.page=0;applyAndRender();
      };
    }
    updateFreshNote();
    if(F.management){checkbox.checked=true;await loadManagementImport();refreshLibraryFacets();applyAndRender();}
  }catch(error){label.textContent='Import coverage unavailable';S.managementImportError=true;updateFreshNote();}
}
async function loadManagementImport(){
  if(S.managementLoaded)return;
  if(S.managementLoading)return S.managementLoading;
  S.managementLoading=(async()=>{
    if(!S.managementManifest)return;
    await loadRecent();
    const files=S.managementManifest.files,label=$('#fManagementLbl');
    const have=new Set(S.papers.map(p=>p.id.toLowerCase()));
    let added=0;
    for(let start=0;start<files.length;start+=4){
      const pages=await Promise.all(files.slice(start,start+4).map(async file=>{
        return managementJson('./data/management/'+file.path);
      }));
      for(const rows of pages)for(const paper of rows){
        if(!paper.id||have.has(paper.id.toLowerCase()))continue;
        have.add(paper.id.toLowerCase());paper._management=true;
        paper._s=((paper.title||'')+' '+(paper.authors||[]).join(' ')+' '+(paper.journal||'')).toLowerCase();
        S.papers.push(paper);added++;
      }
      label.textContent=`Importing ${added.toLocaleString()} / ${S.managementManifest.publishedNewPapers.toLocaleString()} papers…`;
      await new Promise(resolve=>setTimeout(resolve,0));
    }
    S.managementLoaded=true;S.managementAdded=S.papers.filter(p=>p._management).length;
    label.textContent=`+ All-years import (${S.managementAdded.toLocaleString()} · ${S.managementManifest.status==='complete'?'complete':'partial'})`;
    S.managementImportError=false;S.absIndexed=false;refreshLibraryFacets();applyAndRender();updateFreshNote();
  })().catch(error=>{S.managementLoading=null;S.managementImportError=true;$('#fManagementLbl').textContent='Import incomplete · retry';updateFreshNote();throw error;});
  return S.managementLoading;
}
async function renderManagementReferences(paper){
  const container=$('#managementReferences');if(!container)return;
  try{
    const shard=await managementShard('references',paper.id);
    if(!container.isConnected)return;
    const references=shard[paper.id];
    if(!references){container.textContent=paper.referenceCount===0?'OpenAlex returned no indexed references for this record; this does not establish that the paper has no references.':'Reference evidence has not been imported for this paper.';return;}
    const groups=new Map();for(const id of references){const sh=managementShardOf(id);if(!groups.has(sh))groups.set(sh,[]);groups.get(sh).push(id);}
    const resolved=[];
    const batches=[...groups.values()];
    for(let start=0;start<batches.length;start+=4){
      const batch=batches.slice(start,start+4);
      const pages=await Promise.all(batch.map(ids=>managementShard('targets',ids[0])));
      for(let i=0;i<batch.length;i++)for(const id of batch[i])if(pages[i][id])resolved.push(pages[i][id]);
    }
    if(!container.isConnected)return;
    container.innerHTML=`<p>${references.length.toLocaleString()} indexed reference identities; ${resolved.length.toLocaleString()} with imported management metadata. Resolution is partial and scoped; absent metadata does not mean an absent citation.</p>`+
      resolved.slice(0,30).map(target=>`<p><a href="${esc(target.doi?'https://doi.org/'+target.doi:target.openalexId)}" target="_blank" rel="noopener">${esc(target.title)}</a><br><small>${target.year||'Year unavailable'} · ${esc(target.journal||'Source unavailable')}</small></p>`).join('')+
      (resolved.length>30?`<p>${resolved.length-30} further resolved references are recorded in this snapshot.</p>`:'');
  }catch(error){if(container.isConnected)container.textContent='Reference evidence unavailable; reopen to retry.';}
}
