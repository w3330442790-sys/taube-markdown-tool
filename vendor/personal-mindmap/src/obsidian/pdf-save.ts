import { FuzzySuggestModal, Notice, Platform, type App, type TFolder } from 'obsidian';

type SaveDialog = {
  showSaveDialog(options:{defaultPath:string;filters:{name:string;extensions:string[]}[];properties:string[]}):Promise<{canceled:boolean;filePath?:string}>;
};

export async function saveMindmapPdf(app:App,name:string,bytes:Uint8Array<ArrayBuffer>):Promise<void>{
  const electron=(window as Window & {electron?:{remote?:{dialog?:SaveDialog}}}).electron;
  const dialog=Platform.isDesktopApp?electron?.remote?.dialog:undefined;
  if(dialog){
    const destination=await dialog.showSaveDialog({defaultPath:name,filters:[{name:'PDF',extensions:['pdf']}],properties:['showOverwriteConfirmation']});
    if(destination.canceled||!destination.filePath)return;
    const {writeFile}=await import('node:fs/promises');
    await writeFile(destination.filePath,bytes);
    new Notice(`已导出 PDF：${destination.filePath}`);
    return;
  }
  class FolderPicker extends FuzzySuggestModal<TFolder>{
    getItems():TFolder[]{return app.vault.getAllFolders(true);}
    getItemText(folder:TFolder):string{return folder.path||'/';}
    onChooseItem(folder:TFolder):void{
      void (async()=>{
        const stem=folder.isRoot()?name.slice(0,-4):`${folder.path}/${name.slice(0,-4)}`;
        for(let suffix=1;;suffix++){
          const path=suffix===1?`${stem}.pdf`:`${stem} ${suffix}.pdf`;
          if(await app.vault.adapter.exists(path))continue;
          try{await app.vault.createBinary(path,bytes.buffer);}
          catch(error){if(await app.vault.adapter.exists(path))continue;throw error;}
          new Notice(`已导出 PDF：${path}`);
          return;
        }
      })().catch(error=>new Notice(`导出失败：${String(error)}`));
    }
  }
  const picker=new FolderPicker(app);
  picker.setPlaceholder('选择 PDF 保存文件夹（笔记库内）');
  picker.open();
}
