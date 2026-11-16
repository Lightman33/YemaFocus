// 内存数据来源；仅用于复盘页测试。
export function memorySource(snapshot={}) {
 const listeners=new Set();
 const state={joined:true,today:'2026-11-13',timeZone:'Asia/Shanghai',planner:{tasks:[],projects:[],habits:[],reviews:[],deleted:{}},conflicts:[],...snapshot};
 return {state,fail:false,calls:[],snapshot(){return structuredClone(state);},subscribe(fn){listeners.add(fn);return()=>listeners.delete(fn);},publish(){for(const fn of listeners)fn();},async change(description,fn){if(this.fail)throw new Error('存储空间不足');if(!state.joined)throw new Error('先在设置里连接并完成第一次同步');const next=structuredClone(state.planner);fn(next);this.calls.push(description);state.planner=next;this.publish();},async resolve(key,choice){this.resolved={key,choice};state.conflicts=state.conflicts.filter(c=>c.key!==key);this.publish();}};
}
