// Optional journal import contributes to journal corpus analysis; conferences never do.
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
const readJson=filename=>JSON.parse(filename.endsWith('.gz')?gunzipSync(fs.readFileSync(filename)).toString('utf8'):fs.readFileSync(filename,'utf8'));
export function appendManagementCorpus(data, papers, abstracts) {
  const filename=path.join(data,'management','manifest.json');
  if(!fs.existsSync(filename))return;
  const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
  const norm=name=>String(name||'').normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase();
  const byName=new Map();
  for(const source of readJson(path.join(data,'management-journals.json')).sources){
    const key=norm(source.name);if(!byName.has(key))byName.set(key,new Set());byName.get(key).add(source.sourceType);
  }
  const excludedNames=new Set([...byName].filter(([,types])=>types.size===1&&!types.has('journal')).map(([name])=>name));
  const aliases=manifest.sourceAliases?readJson(path.join(data,'management',manifest.sourceAliases)):{conferenceDois:[],aliases:[]};
  const conferenceDois=new Set(aliases.conferenceDois);
  for(const alias of aliases.aliases)if(alias.sourceType!=='journal')excludedNames.add(norm(alias.name));
  const journals=papers.filter(p=>!conferenceDois.has((p.doi||p.id).toLowerCase())&&!excludedNames.has(norm(p.journal)));
  papers.length=0;for(const paper of journals)papers.push(paper);
  const have=new Set(papers.map(p=>(p.doi||p.id).toLowerCase()));
  for(const file of manifest.files){
    if(file.sourceType!=='journal')continue;
    const rows=readJson(path.join(data,'management',file.path));
    for(const paper of rows){const id=(paper.doi||paper.id).toLowerCase();if(have.has(id))continue;have.add(id);papers.push(paper);}
  }
  const wanted=new Set(papers.map(p=>p.doi||p.id));
  for(const file of fs.readdirSync(path.join(data,'management','abstracts'))){
    if(!file.endsWith(manifest.compression==='gzip'?'.json.gz':'.json'))continue;
    const rows=readJson(path.join(data,'management','abstracts',file));
    for(const [id,text] of Object.entries(rows))if(wanted.has(id)&&typeof text==='string'&&text.length>30&&!abstracts.has(id))abstracts.set(id,text);
  }
}
