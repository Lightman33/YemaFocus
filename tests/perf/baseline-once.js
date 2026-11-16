// 旧代码的限量补测：重项仅一次，snapshot后续及空update各30次。不能冒充完整30次基线。
// 直接node运行以即时输出；旧代码目录应取交接记录的Git版本，不能指向当前修改版。
import { performance } from 'node:perf_hooks';
import { appendFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
if (!process.argv[2]) throw new Error('用法：node tests/perf/baseline-once.js 旧代码web目录 [日志文件]');
const oldRoot = resolve(process.argv[2]);
const old = name => import(pathToFileURL(join(oldRoot, name)).href);
import { makeBigData } from './bigdata.js';
const { MemoryStore, freshRecord } = await old('app/store.js');
const { DataSource } = await old('app/datasource.js');
const { TaskActions } = await old('app/task-actions.js');
const { createEngine } = await old('sync/engine.js');
const { SyncState } = await old('app/syncstate.js');
const { MemoryTransport } = await old('transport/memory.js');
const { updateUnit } = await old('sync/edit.js');
const { unitKey } = await old('sync/canonical.js');
let clock = 1794528000123;
const now = () => clock, timers = { setTimeout() { return 1; }, clearTimeout() {} };
const log = text => { console.log(text); if (process.argv[3]) appendFileSync(process.argv[3], text + '\n'); };
async function one(name, fn) { const start = performance.now(); const result = await fn(); log(name + '=' + (performance.now()-start).toFixed(3)); return result; }
async function thirty(name, fn) { const times=[]; for(let i=0;i<30;i++) { const start=performance.now(); await fn(); times.push(performance.now()-start); } times.sort((a,b)=>a-b);log(name + ' median=' + ((times[14]+times[15])/2).toFixed(3) + ' max=' + times[29].toFixed(3)); }
const {state,taskId,reviewId} = makeBigData(); log('units=' + Object.keys(state.units).length);
const raw = new MemoryStore({...freshRecord(),state,settings:{deviceId:'phone',joined:true}});
const source = new DataSource({store:raw,now,demo:true}); source.record=await raw.read();
await one('snapshot冷首次',()=>source.snapshot()); await thirty('snapshot后续',()=>source.snapshot());
await source.init();
const store = new MemoryStore({...freshRecord(), state:{format:'yema-engine-local',schema:1,device:'phone',joined:true,state,revision:1,sequence:0,seen:{},published:null,lastPublishedAt:null}, settings:{deviceId:'phone'}});
const engine=createEngine({store,transport:new MemoryTransport(),syncState:new SyncState(),now,timers,repositoryId:'fiction/repo'});
await one('engine.load',()=>engine.load());
const actions=new TaskActions(source,{now});
await one('勾完成总耗时',async()=>{await actions.toggle(taskId);await engine.commit((await raw.read()).state);});
await one('改单模块总耗时',async()=>{await source.change('虚构复盘',p=>{p.reviews.find(r=>r.id===reviewId).content=p.reviews.find(r=>r.id===reviewId).content.replace(/这是[^\n]*/,'这是单次虚构测量');}); await engine.commit((await raw.read()).state);});
await thirty('store.update空修改',()=>store.update(()=>{}));
await one('首次发布准备（非对照项）',()=>engine.syncNow());
clock+=60001; await one('无变化syncNow',()=>engine.syncNow());
const key=unitKey('task-status',taskId), next=updateUnit(engine.getState(),key,'phone',{done:false},{updatedAt:clock});
await engine.commit(next);clock+=60001;await one('改单任务后syncNow',()=>engine.syncNow());
engine.dispose();log('completed');
