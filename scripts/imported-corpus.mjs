// Optional journal import contributes to journal corpus analysis; conferences never do.
import fs from 'node:fs';
import path from 'node:path';
export function appendManagementCorpus(data, papers, abstracts) {
  const filename=path.join(data,'management','manifest.json');
  if(!fs.existsSync(filename))return;
  const manifest=JSON.parse(fs.readFileSync(filename,'utf8'));
  const have=new Set(papers.map(p=>(p.doi||p.id).toLowerCase()));
  for(const file of manifest.files){
    if(file.sourceType!=='journal')continue;
    const rows=JSON.parse(fs.readFileSync(path.join(data,'management',file.path),'utf8'));
    for(const paper of rows){const id=(paper.doi||paper.id).toLowerCase();if(have.has(id))continue;have.add(id);papers.push(paper);}
  }
  const wanted=new Set(papers.map(p=>p.doi||p.id));
  for(const file of fs.readdirSync(path.join(data,'management','abstracts'))){
    if(!file.endsWith('.json'))continue;
    const rows=JSON.parse(fs.readFileSync(path.join(data,'management','abstracts',file),'utf8'));
    for(const [id,text] of Object.entries(rows))if(wanted.has(id)&&typeof text==='string'&&text.length>30&&!abstracts.has(id))abstracts.set(id,text);
  }
}
