import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const cli = new URL('../src/cli.mjs', import.meta.url).pathname;
const bin = new URL('../bin/approval-sla-calculator.mjs', import.meta.url).pathname;
const exampleRoot = new URL('../examples/', import.meta.url).pathname;
const policy = { schemaVersion:'1', timeZone:'America/New_York', weekdays:[1,2,3,4,5], businessHours:{start:'09:00',end:'17:00'}, holidays:[], asOf:'2026-03-10T00:00:00Z', slaMinutes:{normal:120,critical:60} };
const approval = (id,requestedAt,completedAt,pauses=[]) => ({ id,queue:'private-queue',owner:'private-owner',priority:'normal',requestedAt,...(completedAt ? {completedAt} : {}),pauses });

function run(approvals, rules=policy) {
  const dir=mkdtempSync(join(tmpdir(),'sla-calculator-'));
  try {
    writeFileSync(join(dir,'approvals.json'),JSON.stringify({schemaVersion:'1',approvals}));
    writeFileSync(join(dir,'policy.json'),JSON.stringify(rules));
    const p=spawnSync(process.execPath,[cli,'--root',dir,'--approvals','approvals.json','--policy','policy.json'],{encoding:'utf8'});
    return {...p,report:p.stdout ? JSON.parse(p.stdout) : null};
  } finally { rmSync(dir,{recursive:true,force:true}); }
}
function runRaw(raw,rules=policy) {
  const dir=mkdtempSync(join(tmpdir(),'sla-calculator-'));
  try {
    writeFileSync(join(dir,'approvals.json'),raw);
    writeFileSync(join(dir,'policy.json'),JSON.stringify(rules));
    const p=spawnSync(process.execPath,[cli,'--root',dir,'--approvals','approvals.json','--policy','policy.json'],{encoding:'utf8'});
    return {...p,report:p.stdout?JSON.parse(p.stdout):null};
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test('good DST-spanning approval excludes a pause from elapsed and business minutes', () => {
  const a=run([approval('secret-id','2026-03-06T21:00:00Z','2026-03-09T14:00:00Z',[{start:'2026-03-09T13:00:00Z',end:'2026-03-09T13:30:00Z'}])]);
  const b=run([approval('secret-id','2026-03-06T21:00:00Z','2026-03-09T14:00:00Z',[{start:'2026-03-09T13:00:00Z',end:'2026-03-09T13:30:00Z'}])]);
  assert.equal(a.status,0);
  assert.equal(a.stdout,b.stdout);
  assert.equal(a.report.status,'pass');
  assert.equal(a.report.approvals[0].elapsedMinutes,3900);
  assert.equal(a.report.approvals[0].activeElapsedMinutes,3870);
  assert.equal(a.report.approvals[0].businessMinutes,90);
  assert.equal(a.report.approvals[0].state,'completed');
  assert.doesNotMatch(a.stdout,/secret-id|private-queue|private-owner/);
});

test('breach uses business time after pauses and produces failure', () => {
  const r=run([approval('a','2026-03-06T21:00:00Z','2026-03-09T14:00:00Z',[{start:'2026-03-09T13:00:00Z',end:'2026-03-09T13:30:00Z'}])],{...policy,slaMinutes:{normal:89,critical:60}});
  assert.equal(r.status,1);
  assert.equal(r.report.findings[0].ruleId,'sla-breach');
  assert.equal(r.report.findings[0].location.pointer,'/approvals/0');
});

test('open approval has no invented completion and is incomplete', () => {
  const r=run([approval('a','2026-03-09T13:00:00Z')]);
  assert.equal(r.status,2);
  assert.equal(r.report.status,'incomplete');
  assert.equal(r.report.approvals[0].state,'open');
  assert.equal(r.report.approvals[0].businessMinutes,480);
  assert.equal(Object.hasOwn(r.report.approvals[0],'completedAt'),false);
  assert.equal(r.report.findings[0].ruleId,'open-approval');
});

test('holiday removes business minutes without changing elapsed minutes', () => {
  const r=run([approval('a','2026-03-09T13:00:00Z','2026-03-09T15:00:00Z')],{...policy,holidays:['2026-03-09']});
  assert.equal(r.status,0);
  assert.equal(r.report.approvals[0].elapsedMinutes,120);
  assert.equal(r.report.approvals[0].businessMinutes,0);
});

test('missing timezone is incomplete instead of silently evaluating as UTC', async () => {
  const { evaluateApprovals }=await import('../src/index.mjs');
  const { timeZone, ...missingZone }=policy;
  const r=evaluateApprovals({schemaVersion:'1',approvals:[approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z')]},missingZone);
  assert.equal(r.status,'incomplete');
  assert.equal(r.findings[0].ruleId,'input-invalid');
  assert.equal(r.findings[0].location.file,'@policy');
});

test('record limit allows N and refuses N+1', () => {
  const make=n=>Array.from({length:n},(_,i)=>approval(`a${i}`,'2026-03-09T13:00:00Z','2026-03-09T13:01:00Z'));
  assert.equal(run(make(100)).status,0);
  const r=run(make(101));
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'approval-limit');
});

test('exact byte bound is accepted and one extra byte is incomplete', () => {
  const base=JSON.stringify({schemaVersion:'1',approvals:[approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z')]});
  const exact=base+' '.repeat(1_048_576-Buffer.byteLength(base));
  assert.equal(runRaw(exact).status,0);
  const over=runRaw(exact+' ');
  assert.equal(over.status,2);
  assert.equal(over.report.findings[0].ruleId,'input-unavailable');
});

test('JSON depth 16 is accepted and depth 17 is incomplete', () => {
  const nested=n=>{const a=approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z');let x=a;for(let i=0;i<n;i++){x.extra={};x=x.extra;}return [a];};
  assert.equal(run(nested(14)).status,0);
  const over=run(nested(15));
  assert.equal(over.status,2);
  assert.equal(over.report.findings[0].ruleId,'input-unavailable');
});

test('injected time limit accepts 5000 ms and rejects 5001 ms', async () => {
  const {evaluateApprovals}=await import('../src/index.mjs');
  const exported={schemaVersion:'1',approvals:[approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z')]};
  assert.equal(evaluateApprovals(exported,policy,5000,()=>5000).status,'pass');
  const over=evaluateApprovals(exported,policy,5000,()=>5001);
  assert.equal(over.status,'incomplete');
  assert.equal(over.findings[0].ruleId,'timeout');
});

test('CLI clock seam enforces exact 5000/5001 ms bound', async () => {
  const {runCli}=await import('../src/cli.mjs');
  const dir=mkdtempSync(join(tmpdir(),'sla-clock-'));
  const oldArgv=process.argv,oldLog=console.log,oldExit=process.exitCode;
  try {
    writeFileSync(join(dir,'approvals.json'),JSON.stringify({schemaVersion:'1',approvals:[approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z')]}));
    writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));
    process.argv=[process.execPath,cli,'--root',dir,'--approvals','approvals.json','--policy','policy.json'];
    const invoke=elapsed=>{const ticks=[0,elapsed];let output='';console.log=x=>{output=x;};runCli(()=>ticks.shift()??elapsed);return {code:process.exitCode,report:JSON.parse(output)};};
    assert.equal(invoke(5000).code,0);
    const over=invoke(5001);
    assert.equal(over.code,2);assert.equal(over.report.findings[0].ruleId,'timeout');
  } finally {process.argv=oldArgv;console.log=oldLog;process.exitCode=oldExit;rmSync(dir,{recursive:true,force:true});}
});

test('31-day span is legal and one minute more is incomplete', () => {
  const atLimit=run([approval('a','2026-01-01T00:00:00Z','2026-02-01T00:00:00Z')],{...policy,asOf:'2026-02-02T00:00:00Z'});
  assert.equal(atLimit.status,1);
  assert.notEqual(atLimit.report.findings[0]?.ruleId,'span-limit');
  const over=run([approval('a','2026-01-01T00:00:00Z','2026-02-01T00:01:00Z')],{...policy,asOf:'2026-02-02T00:00:00Z'});
  assert.equal(over.status,2);
  assert.equal(over.report.findings[0].ruleId,'span-limit');
});

test('conflicting repeated ID is incomplete with ordinal provenance', () => {
  const r=run([approval('secret-id','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z'),approval('secret-id','2026-03-09T13:00:00Z','2026-03-09T13:02:00Z')]);
  assert.equal(r.status,2);
  assert.equal(r.report.findings[0].ruleId,'duplicate-approval');
  assert.equal(r.report.findings[0].location.pointer,'/approvals/1');
  assert.doesNotMatch(r.stdout,/secret-id/);
});

test('symlink outside root is refused without reading its content', () => {
  const dir=mkdtempSync(join(tmpdir(),'sla-calculator-'));
  const outside=mkdtempSync(join(tmpdir(),'sla-outside-'));
  try {
    writeFileSync(join(outside,'approvals.json'),'PRIVATE_SENTINEL');
    symlinkSync(join(outside,'approvals.json'),join(dir,'approvals.json'));
    writeFileSync(join(dir,'policy.json'),JSON.stringify(policy));
    const p=spawnSync(process.execPath,[cli,'--root',dir,'--approvals','approvals.json','--policy','policy.json'],{encoding:'utf8'});
    assert.equal(p.status,2);
    assert.equal(JSON.parse(p.stdout).findings[0].ruleId,'input-unavailable');
    assert.doesNotMatch(p.stdout,/PRIVATE_SENTINEL/);
  } finally { rmSync(dir,{recursive:true,force:true}); rmSync(outside,{recursive:true,force:true}); }
});

test('a file supplied as root is invalid usage with empty stdout', () => {
  const dir=mkdtempSync(join(tmpdir(),'sla-calculator-'));
  try {
    writeFileSync(join(dir,'not-a-directory.json'),'{}');
    const p=spawnSync(process.execPath,[cli,'--root',join(dir,'not-a-directory.json'),'--approvals','approvals.json','--policy','policy.json'],{encoding:'utf8'});
    assert.equal(p.status,2);
    assert.equal(p.stdout,'');
    assert.match(p.stderr,/Invalid --root/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('packaged bin runs passing and failing examples', async () => {
  const { TOOL_ID, evaluateApprovals } = await import('../src/index.mjs');
  assert.equal(TOOL_ID,'approval-sla-calculator');
  const direct=evaluateApprovals({schemaVersion:'1',approvals:[approval('a','2026-03-09T13:00:00Z','2026-03-09T13:01:00Z')]},policy);
  assert.equal(direct.status,'pass');
  assert.equal(direct.approvals[0].businessMinutes,1);
  for (const [folder,code] of [['pass',0],['fail',1]]) {
    const p=spawnSync(process.execPath,[bin,'--root',join(exampleRoot,folder),'--approvals','approvals.json','--policy','policy.json'],{encoding:'utf8'});
    assert.equal(p.status,code,p.stderr);
    assert.equal(JSON.parse(p.stdout).tool,TOOL_ID);
  }
});
