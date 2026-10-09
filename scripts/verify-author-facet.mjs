// Synthetic UI fixtures only; no corpus records are generated or changed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const html=fs.readFileSync(new URL('../index.html',import.meta.url),'utf8');
const source=html.slice(html.indexOf('function buildAuthorSelect(){'),html.indexOf('function buildYearSelect(){'));
const select={options:[],value:'',title:'',replaceChildren(...options){this.options=options;},appendChild(option){this.options.push(option);}};
const state={papers:[],author:''};
const context=vm.createContext({
  $:selector=>{assert.equal(selector,'#fAuthor');return select;},
  F:state,libraryPapers:()=>state.papers,
  Option:function(text,value){this.text=text;this.value=value;}
});
vm.runInContext(source,context);
state.papers=Array.from({length:1200},(_,i)=>({authors:[`Simulated author ${String(i).padStart(4,'0')}`]}));
state.papers.push(...state.papers.slice());
state.papers.push({authors:['Simulated singleton','__proto__']});
context.buildAuthorSelect();
assert.equal(select.options.length,501);
assert.match(select.options[0].text,/top 500/);
assert.match(select.title,/1,200 authors/);
assert.equal(select.options[1].value,'Simulated author 0000');
state.author='Simulated author 1199';context.syncAuthorSelect();
assert.equal(select.options.length,502);assert.equal(select.value,state.author);
context.syncAuthorSelect();assert.equal(select.options.length,502);
context.buildAuthorSelect();assert.equal(select.options.length,502);assert.equal(select.value,state.author);
state.papers=[{authors:['Simulated singleton']}];state.author='Simulated singleton';context.buildAuthorSelect();
assert.equal(select.options.length,2);assert.equal(select.value,state.author);
state.author='';context.buildAuthorSelect();assert.equal(select.options.length,1);assert.equal(select.value,'');
console.log('PASS bounded author dropdown, stable ordering, selected off-list/singleton authors, rebuild and reset; simulated fixtures only.');
