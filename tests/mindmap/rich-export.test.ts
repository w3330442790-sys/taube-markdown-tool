import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
const {embedCssResources, jpegToPdf}=require("../../vendor/personal-mindmap/webview/src/export");
test("desktop PDF saves through the Obsidian CommonJS loader after the dialog",async()=>{
  const result=await build({
    entryPoints:["vendor/personal-mindmap/src/obsidian/pdf-save.ts"],
    bundle:true,write:false,format:"cjs",platform:"browser",
    external:["obsidian","fs","node:fs/promises"],
  });
  const destination="C:\\exports\\map.pdf";
  const bytes=new Uint8Array([37,80,68,70]);
  const writes:unknown[][]=[];
  let canceled=true;
  const module={exports:{} as typeof import("../../vendor/personal-mindmap/src/obsidian/pdf-save")};
  runInNewContext(result.outputFiles[0].text,{
    module,
    window:{electron:{remote:{dialog:{showSaveDialog:async()=>({canceled,filePath:destination})}}}},
    require(id:string){
      if(id==="obsidian")return {Platform:{isDesktopApp:true},Notice:class {}};
      if(id==="fs")return {promises:{writeFile:async(...args:unknown[])=>{writes.push(args);}}};
      throw new Error(`Unexpected module: ${id}`);
    },
  });
  const app={} as Parameters<typeof module.exports.saveMindmapPdf>[0];
  await module.exports.saveMindmapPdf(app,"map.pdf",bytes);
  assert.deepEqual(writes,[]);
  canceled=false;
  await module.exports.saveMindmapPdf(app,"map.pdf",bytes);
  assert.deepEqual(writes,[[destination,bytes]]);
});
test("PDF export keeps the full image at its aspect ratio and writes byte-correct xref offsets",()=>{
  const pdf=jpegToPdf(new Uint8Array([255,216,255,217]),1600,900);
  const source=Buffer.from(pdf).toString("latin1");
  assert.match(source,/^%PDF-1\.4/);
  assert.match(source,/\/MediaBox \[0 0 1200 675\]/);
  assert.match(source,/\/Width 1600 \/Height 900/);
  const offset=Number(/startxref\n(\d+)/.exec(source)![1]);
  assert.equal(source.slice(offset,offset+4),"xref");
  const entries=source.slice(offset).split("\n").slice(3,8);
  assert.equal(entries.length,5);
  entries.forEach((entry,index)=>assert.ok(source.startsWith(`${index+1} 0 obj`,Number(entry.slice(0,10)))));
});
test("math font CSS export embeds font bytes and resolves relative stylesheet URLs",async()=>{
  const urls:string[]=[];
  const css=await embedCssResources('@font-face{font-family:MJX;src:url("fonts/math.woff2")} .mjx-c::before{content:"x"}',"https://host.test/styles/math.css",async(url:string)=>{urls.push(url);return new Blob([new Uint8Array([1,2,3])],{type:"font/woff2"});});
  assert.deepEqual(urls,["https://host.test/styles/fonts/math.woff2"]);
  assert.match(css,/url\("data:font\/woff2;base64,AQID"\)/);
  assert.match(css,/\.mjx-c::before/);assert.doesNotMatch(css,/url\("fonts/);
});
test("font embedding fails explicitly rather than silently exporting missing glyphs",async()=>{
  await assert.rejects(embedCssResources('@font-face{src:url(bad.woff)}',"https://host.test/",async()=>{throw new Error("denied");}),/embed.*font|denied/i);
});
