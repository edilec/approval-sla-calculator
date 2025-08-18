#!/usr/bin/env node
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { resolve, isAbsolute } from 'node:path';
import { TOOL_ID } from './index.mjs';

const TOOL=TOOL_ID;
const MAX_BYTES=1024*1024, MAX_APPROVALS=100, MAX_DEPTH=16, MAX_SPAN_MINUTES=31*24*60, DEADLINE_MS=5000;
const SEVERITY=Object.freeze({
  'input-unavailable':'warning','input-invalid':'warning','approval-limit':'warning',
  'empty-export':'warning','invalid-approval':'warning','duplicate-approval':'warning',
  'span-limit':'warning','open-approval':'warning','timeout':'warning','sla-breach':'error'
});
const INCOMPLETE=new Set(Object.keys(SEVERITY).filter(k=>SEVERITY[k]==='warning'));
const cmp=(a,b)=>a<b?-1:a>b?1:0;
const obj=x=>x!==null && typeof x==='object' && !Array.isArray(x);
const clean=s=>String(s).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]/g,'').slice(0,80);
const own=(o,k)=>Object.hasOwn(o,k);
const messages={
  'input-unavailable':'Declared input could not be read within its root.',
  'input-invalid':'Declared input could not be decoded or parsed as a supported document.',
  'approval-limit':`Approval export exceeds ${MAX_APPROVALS} records.`,
  'empty-export':'Approval export contains no records.',
  'invalid-approval':'Approval record has missing, inconsistent, or unsupported values.',
  'duplicate-approval':'An approval ID occurs more than once.',
  'span-limit':`Approval evaluation span exceeds ${MAX_SPAN_MINUTES} minutes.`,
  'open-approval':'Approval is still open at the supplied as-of instant.',
  timeout:'Evaluation exceeded its time limit.',
  'sla-breach':'Completed approval exceeds its configured business-minute limit.'
};
function finding(ruleId,file,pointer='') {
  if (!own(SEVERITY,ruleId)) throw new Error('unknown rule');
  return {ruleId,severity:SEVERITY[ruleId],message:messages[ruleId],location:{file,...(pointer?{pointer}:{})}};
}
function report(findings,summary={checked:0,errors:0,warnings:0},extra={}) {
  findings.sort((a,b)=>cmp(a.location.file,b.location.file)||cmp(a.location.pointer??'',b.location.pointer??'')||cmp(a.ruleId,b.ruleId));
  const status=findings.some(f=>INCOMPLETE.has(f.ruleId))?'incomplete':findings.some(f=>f.severity==='error')?'fail':'pass';
  return {schemaVersion:'1',tool:TOOL,status,summary:{...summary,errors:findings.filter(f=>f.severity==='error').length,warnings:findings.filter(f=>f.severity==='warning').length},findings,...extra};
}
function args(argv) {
  if (argv.length===1 && argv[0]==='--help') return {help:true};
  const out={};
  for(let i=0;i<argv.length;i+=2) {
    if(!['--root','--approvals','--policy'].includes(argv[i])||!argv[i+1]||own(out,argv[i])) throw new Error('Usage: approval-sla-calculator --root DIR --approvals FILE --policy FILE');
    out[argv[i]]=argv[i+1];
  }
  if(Object.keys(out).length!==3) throw new Error('Usage: approval-sla-calculator --root DIR --approvals FILE --policy FILE');
  for(const key of ['--approvals','--policy']) if(isAbsolute(out[key])||out[key].split(/[\\/]/).includes('..')) throw new Error('Input files must be relative to --root.');
  return out;
}
function input(root,name) {
  const path=realpathSync(resolve(root,name));
  if(path!==root&&!path.startsWith(root+'/')) throw new Error('outside root');
  if(statSync(path).size>MAX_BYTES) throw new Error('too large');
  const document=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(readFileSync(path)));
  const stack=[[document,0]];
  while(stack.length) {
    const [v,d]=stack.pop();
    if(d>MAX_DEPTH) throw new Error('too deep');
    if(v&&typeof v==='object') for(const child of Object.values(v)) stack.push([child,d+1]);
  }
  return document;
}
function instant(s) {
  if(typeof s!=='string') return NaN;
  const m=/^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d):(\d\d)(Z|[+-]\d\d:\d\d)$/.exec(s);
  if(!m) return NaN;
  const [y,mo,d,h,mi,se]=m.slice(1,7).map(Number);
  const raw=Date.UTC(y,mo-1,d,h,mi,se), round=new Date(raw);
  if(round.getUTCFullYear()!==y||round.getUTCMonth()+1!==mo||round.getUTCDate()!==d||round.getUTCHours()!==h||round.getUTCMinutes()!==mi||round.getUTCSeconds()!==se||se!==0) return NaN;
  let offset=0;
  if(m[7]!=='Z') {
    const oh=Number(m[7].slice(1,3)), om=Number(m[7].slice(4));
    if(oh>14||om>59||(oh===14&&om!==0)) return NaN;
    offset=(m[7][0]==='+'?1:-1)*(oh*60+om);
  }
  return raw-offset*60000;
}
const day=s=>typeof s==='string'&&/^\d{4}-\d\d-\d\d$/.test(s)&&Number.isFinite(instant(`${s}T00:00:00Z`));
const hhmm=s=>typeof s==='string'&&/^\d\d:\d\d$/.test(s)&&Number(s.slice(0,2))<24&&Number(s.slice(3))<60 ? Number(s.slice(0,2))*60+Number(s.slice(3)):NaN;
function policyValid(p) {
  if(!obj(p)||Object.keys(p).some(k=>!['schemaVersion','timeZone','weekdays','businessHours','holidays','asOf','slaMinutes'].includes(k))||p.schemaVersion!=='1'||!Number.isFinite(instant(p.asOf))||!Array.isArray(p.weekdays)||!p.weekdays.length||new Set(p.weekdays).size!==p.weekdays.length||p.weekdays.some(n=>!Number.isInteger(n)||n<0||n>6)||!obj(p.businessHours)||Object.keys(p.businessHours).sort().join(',')!=='end,start'||!Number.isFinite(hhmm(p.businessHours.start))||!Number.isFinite(hhmm(p.businessHours.end))||hhmm(p.businessHours.start)>=hhmm(p.businessHours.end)||!Array.isArray(p.holidays)||p.holidays.some(d=>!day(d))||!obj(p.slaMinutes)||!Object.keys(p.slaMinutes).length||Object.values(p.slaMinutes).some(v=>!Number.isSafeInteger(v)||v<0)) return false;
  try { new Intl.DateTimeFormat('en-US',{timeZone:p.timeZone}).format(0); } catch { return false; }
  return true;
}
function localParts(formatter,t) {
  const p=Object.fromEntries(formatter.formatToParts(t).map(x=>[x.type,x.value]));
  const weekdays={Sun:0,Mon:1,Tue:2,Wed:3,Thu:4,Fri:5,Sat:6};
  return {day:`${p.year}-${p.month}-${p.day}`,weekday:weekdays[p.weekday],minute:Number(p.hour)*60+Number(p.minute)};
}
function evaluate(exported,policy,deadline) {
  if(!obj(exported)||exported.schemaVersion!=='1'||!Array.isArray(exported.approvals)) return report([finding('input-invalid','@approvals')]);
  if(!policyValid(policy)) return report([finding('input-invalid','@policy')]);
  if(exported.approvals.length>MAX_APPROVALS) return report([finding('approval-limit','@approvals')]);
  if(!exported.approvals.length) return report([finding('empty-export','@approvals')]);
  const formatter=new Intl.DateTimeFormat('en-US',{timeZone:policy.timeZone,year:'numeric',month:'2-digit',day:'2-digit',weekday:'short',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const holiday=new Set(policy.holidays), weekdays=new Set(policy.weekdays), asOf=instant(policy.asOf);
  const ids=new Set(), parsed=[];
  for(const [i,a] of exported.approvals.entries()) {
    const pointer=`/approvals/${i}`;
    if(!obj(a)||!['id','queue','owner','priority'].every(k=>typeof a[k]==='string'&&clean(a[k]).length)||!own(policy.slaMinutes,a.priority)||!Number.isFinite(instant(a.requestedAt))||(a.completedAt!==undefined&&!Number.isFinite(instant(a.completedAt)))||!Array.isArray(a.pauses)) return report([finding('invalid-approval','@approvals',pointer)]);
    if(ids.has(a.id)) return report([finding('duplicate-approval','@approvals',pointer)]);
    ids.add(a.id);
    const start=instant(a.requestedAt), complete=a.completedAt===undefined?null:instant(a.completedAt), end=complete??asOf;
    if(end<start||end>asOf||!Number.isSafeInteger(start/60000)||!Number.isSafeInteger(end/60000)) return report([finding('invalid-approval','@approvals',pointer)]);
    if((end-start)/60000>MAX_SPAN_MINUTES) return report([finding('span-limit','@approvals',pointer)]);
    const pauses=[];
    for(const pause of a.pauses) {
      if(!obj(pause)||!Number.isFinite(instant(pause.start))||!Number.isFinite(instant(pause.end))) return report([finding('invalid-approval','@approvals',pointer)]);
      const ps=instant(pause.start),pe=instant(pause.end);
      if(ps<start||pe>end||pe<ps||!Number.isSafeInteger(ps/60000)||!Number.isSafeInteger(pe/60000)) return report([finding('invalid-approval','@approvals',pointer)]);
      pauses.push([ps,pe]);
    }
    pauses.sort((x,y)=>x[0]-y[0]);
    let pauseMinutes=0, lastEnd=start;
    for(const [ps,pe] of pauses) { pauseMinutes+=Math.max(0,pe-Math.max(ps,lastEnd))/60000; lastEnd=Math.max(lastEnd,pe); }
    let business=0, pi=0;
    for(let t=start;t<end;t+=60000) {
      if((t-start)%(60000*1024)===0&&Date.now()>deadline) return report([finding('timeout','@approvals',pointer)]);
      while(pi<pauses.length&&pauses[pi][1]<=t) pi++;
      if(pi<pauses.length&&pauses[pi][0]<=t&&t<pauses[pi][1]) continue;
      const l=localParts(formatter,t);
      if(weekdays.has(l.weekday)&&!holiday.has(l.day)&&l.minute>=hhmm(policy.businessHours.start)&&l.minute<hhmm(policy.businessHours.end)) business++;
    }
    parsed.push({ordinal:i,queue:a.queue,owner:a.owner,priority:a.priority,state:complete===null?'open':'completed',elapsedMinutes:(end-start)/60000,activeElapsedMinutes:(end-start)/60000-pauseMinutes,businessMinutes:business,limitMinutes:policy.slaMinutes[a.priority]});
  }
  function labels(field,prefix) { return new Map([...new Set(parsed.map(a=>a[field]))].sort(cmp).map((s,i)=>[s,`${prefix}-${i+1}`])); }
  const maps={queue:labels('queue','queue'),owner:labels('owner','owner'),priority:labels('priority','priority')};
  const findings=[], rows=[];
  const byQueue={},byOwner={},byPriority={};
  for(const a of parsed) {
    const row={sourceOrdinal:a.ordinal,state:a.state,queue:maps.queue.get(a.queue),owner:maps.owner.get(a.owner),priority:maps.priority.get(a.priority),elapsedMinutes:a.elapsedMinutes,activeElapsedMinutes:a.activeElapsedMinutes,businessMinutes:a.businessMinutes,limitMinutes:a.limitMinutes};
    rows.push(row);
    if(a.state==='open') findings.push(finding('open-approval','@approvals',`/approvals/${a.ordinal}`));
    else if(a.businessMinutes>a.limitMinutes) findings.push(finding('sla-breach','@approvals',`/approvals/${a.ordinal}`));
    for(const [name,out] of [['queue',byQueue],['owner',byOwner],['priority',byPriority]]) {
      const key=row[name], m=out[key]??={completed:0,open:0,breaches:0,totalBusinessMinutes:0,totalActiveElapsedMinutes:0};
      m[a.state]++;
      m.totalBusinessMinutes+=a.businessMinutes;
      m.totalActiveElapsedMinutes+=a.activeElapsedMinutes;
      if(a.state==='completed'&&a.businessMinutes>a.limitMinutes) m.breaches++;
    }
  }
  return report(findings,{checked:rows.length,errors:0,warnings:0,completed:rows.filter(a=>a.state==='completed').length,open:rows.filter(a=>a.state==='open').length},{approvals:rows,groups:{byQueue,byOwner,byPriority}});
}
function main() {
  let a;
  try { a=args(process.argv.slice(2)); } catch(e) { console.error(e.message); process.exitCode=2; return; }
  if(a.help) { console.log('Usage: approval-sla-calculator --root DIR --approvals FILE --policy FILE\nLocal JSON exports only; stdout is a JSON report, stderr is diagnostics.'); return; }
  let root;
  try { root=realpathSync(a['--root']); } catch { console.error('Invalid --root directory.'); process.exitCode=2; return; }
  let approvals,policy;
  try { approvals=input(root,a['--approvals']); } catch { console.log(JSON.stringify(report([finding('input-unavailable','@approvals')]))); process.exitCode=2; return; }
  try { policy=input(root,a['--policy']); } catch { console.log(JSON.stringify(report([finding('input-unavailable','@policy')]))); process.exitCode=2; return; }
  const r=evaluate(approvals,policy,Date.now()+DEADLINE_MS);
  console.log(JSON.stringify(r));
  process.exitCode=r.status==='pass'?0:r.status==='fail'?1:2;
}
main();
