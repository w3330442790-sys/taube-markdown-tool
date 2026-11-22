import test from "node:test";
import assert from "node:assert/strict";
const {embedCssResources, jpegToPdf}=require("../../vendor/personal-mindmap/webview/src/export");
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
