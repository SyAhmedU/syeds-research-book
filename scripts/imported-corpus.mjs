// Optional journal import contributes to journal corpus analysis; conferences never do.
import fs from 'node:fs';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
const readJson=filename=>JSON.parse(filename.endsWith('.gz')?gunzipSync(fs.readFileSync(filename)).toString('utf8'):fs.readFileSync(filename,'utf8'));
export function appendManagementCorpus(data, papers, abstracts) {
  const filename=path.join(data,'management','manifest.json');
  if(!fs.existsSync(filename))return;
  const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
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
