import type { MindDoc } from '../core/types';
import { parse } from '../core/doc';
export interface MarkdownMapRecord { source:string; doc:MindDoc; legacySource?:string }
interface MapAdapter { exists(path:string):Promise<boolean>; read(path:string):Promise<string>; write(path:string,text:string):Promise<unknown> }

/** Graphical metadata is separate from both Markdown and annotation storage. */
export class MarkdownMapStore {
  private entries:Record<string,MarkdownMapRecord>=Object.create(null) as Record<string,MarkdownMapRecord>;
  private expected:string|null=null;
  private ready=false;
  private queue:Promise<void>=Promise.resolve();
  constructor(private adapter:MapAdapter,private path:string){}
  async load():Promise<void>{
    this.ready=false;
    const raw=await this.read();
    if(raw!==null){
      const data=JSON.parse(raw) as {version?:number;entries?:Record<string,MarkdownMapRecord>};
      if(data.version!==1||!data.entries||typeof data.entries!=='object'||Array.isArray(data.entries))throw Error('脑图元数据格式异常，原数据已保留');
      for(const record of Object.values(data.entries)){
        if(!record||typeof record.source!=='string')throw Error('脑图元数据无效，原数据已保留');
        const parsed=parse(JSON.stringify(record.doc));if(!parsed.doc||parsed.readOnly)throw Error('脑图元数据无效或使用未来版本，原数据已保留');
      }
      this.entries=Object.assign(Object.create(null),data.entries) as Record<string,MarkdownMapRecord>;
    }
    this.expected=raw;this.ready=true;
  }
  get(path:string):MarkdownMapRecord|undefined{const value=this.entries[path];return value?structuredClone(value):undefined;}
  private async read():Promise<string|null>{return await this.adapter.exists(this.path)?this.adapter.read(this.path):null;}
  private mutate(change:(entries:Record<string,MarkdownMapRecord>)=>void):Promise<void>{
    const operation=this.queue.then(async()=>{
      if(!this.ready)throw Error('脑图元数据尚未安全读取，已停止覆盖');
      const disk=await this.read();if(disk!==this.expected)throw new SaveConflict();
      const next=Object.assign(Object.create(null),structuredClone(this.entries)) as Record<string,MarkdownMapRecord>;change(next);
      const raw=JSON.stringify({version:1,entries:next});if(raw===disk)return;
      if(disk!==null)await this.adapter.write(this.path+'.bak',disk);
      await this.adapter.write(this.path,raw);this.expected=raw;this.entries=next;
    });
    this.queue=operation.catch(()=>undefined);return operation;
  }
  set(path:string,record:MarkdownMapRecord,expected?:string):Promise<void>{const copy=structuredClone(record);return this.mutate(entries=>{
    if(expected!==undefined&&JSON.stringify(entries[path]??null)!==expected)throw new SaveConflict();
    entries[path]={...copy,...(entries[path]?.legacySource?{legacySource:entries[path].legacySource}:{})};
  });}
  rename(oldPath:string,newPath:string):Promise<void>{return this.mutate(entries=>{
    for(const path of Object.keys(entries))if(path===oldPath||path.startsWith(oldPath+'/')){
      const target=newPath+path.slice(oldPath.length);if(entries[target])throw new SaveConflict();entries[target]=entries[path];delete entries[path];
    }
  });}
}

export class SaveConflict extends Error {
  constructor() { super('文件已被其他编辑器修改；本地编辑已保留，请先解决冲突。'); this.name = 'SaveConflict'; }
}

/** Serial compare-and-swap writes. Each queued edit compares against the last successful disk write. */
export class SnapshotWriter {
  private queue: Promise<void> = Promise.resolve();
  private queuedSnapshots = new Map<string, number>();
  pending: string | undefined;
  constructor(private expected: string, private process: (transform: (disk: string) => string) => Promise<unknown>) {}
  write(next: string, guard?:()=>void): Promise<void> {
    this.pending = next;
    this.queuedSnapshots.set(next, (this.queuedSnapshots.get(next) ?? 0) + 1);
    const operation = this.queue.then(async () => {
      await this.process(disk => {
        guard?.();
        if (disk !== this.expected && disk !== next) throw new SaveConflict();
        return next;
      });
      this.expected = next;
      if (this.pending === next) this.pending = undefined;
    });
    const tracked = operation.finally(() => {
      const remaining = (this.queuedSnapshots.get(next) ?? 1) - 1;
      if (remaining) this.queuedSnapshots.set(next, remaining); else this.queuedSnapshots.delete(next);
    });
    this.queue = tracked.catch(() => undefined);
    return tracked;
  }
  isOwnSnapshot(source: string): boolean { return source === this.expected || this.queuedSnapshots.has(source); }
  isDirty(source: string): boolean { return source !== this.expected; }
  settled(): Promise<void> { return this.queue; }
}
