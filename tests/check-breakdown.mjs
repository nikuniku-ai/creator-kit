#!/usr/bin/env node
// AC2 checker: node tests/check-breakdown.mjs <breakdown.json> <truth.json>
// Passes (exit 0) when the shot count differs from the human labels by at most 1 and every labelled cut has a detected
// cut within 0.5 s (and every detected cut is within 0.5 s of a labelled one). Prints one JSON line either way.
import {readFileSync} from 'node:fs';
export function compare(breakdown,truth,{tolerance=0.5,countSlack=1}={}){
 const cuts=s=>s.slice(1).map(x=>x.start_s);
 const got=cuts(breakdown.shots),want=cuts(truth.shots),problems=[];
 if(Math.abs(breakdown.shots.length-truth.shots.length)>countSlack)problems.push(`shot count ${breakdown.shots.length} vs labelled ${truth.shots.length}`);
 for(const t of want)if(!got.some(g=>Math.abs(g-t)<=tolerance))problems.push(`labelled cut at ${t}s not detected within ${tolerance}s`);
 for(const g of got)if(!want.some(t=>Math.abs(g-t)<=tolerance))problems.push(`detected cut at ${g}s has no labelled cut within ${tolerance}s`);
 return {ok:problems.length===0,detected:breakdown.shots.length,labelled:truth.shots.length,problems};
}
if(import.meta.url===`file://${process.argv[1]}`){
 const [b,t]=process.argv.slice(2).map(p=>JSON.parse(readFileSync(p,'utf8')));
 const r=compare(b,t);process.stdout.write(JSON.stringify(r)+'\n');process.exitCode=r.ok?0:1;
}
