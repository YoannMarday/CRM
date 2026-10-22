/* Kikoo payment receipt -> PDF (A5, logo on top). Used by the app and by the server for shareable receipt links. */
(function(root){
const pdfStr=s=>String(s==null?'':s).replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"').replace(/[\u2013\u2014]/g,'-').replace(/\u2026/g,'...').replace(/[\u{1F000}-\u{1FFFF}\u2600-\u27BF\uFE0F\u200D]/gu,'').replace(/[^\x20-\x7E\xA0-\xFF]/g,'?').replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)');
function receiptPdf(x){
  const {o,c,p,i,money,fmt,paid,bal,logo,logoPx}=x;
  const W=420,H=595,M=40,ops=[],biz=x.biz||'Kikoo',own=/^\s*kikoo\s*$/i.test(biz),no=`R-${o.no}-${i+1}`;
  const T=(t,x,top,size,bold,col)=>ops.push(`BT /${bold?'F2':'F1'} ${size} Tf ${col||'0.1 0.1 0.1 rg'} ${x} ${H-top} Td (${pdfStr(t)}) Tj ET`);
  const hr=top=>ops.push(`0.75 G 0.7 w ${M} ${H-top} m ${W-M} ${H-top} l S`),GR='0.45 0.45 0.45 rg';
  if(logo)ops.push(`q 170 0 0 170 ${(W-170)/2} ${H-28-170} cm /Im1 Do Q`);
  let t=222;if(!own){T(biz,M,t,13,1);t+=22}
  T('Payment receipt '+no,M,t,16,1);t+=18;T(fmt(p.date),M,t,11,0,GR);t+=14;hr(t);t+=26;
  T('Received from',M,t,10,0,GR);t+=17;T(c.name,M,t,15,1);t+=26;
  T('For',M,t,10,0,GR);t+=17;T(`${o.title} (Order #${o.no})`,M,t,12);t+=44;
  T(money(p.amount),M,t,28,1,'0.07 0.45 0.85 rg');t+=24;T('Method: '+p.method,M,t,11,0,GR);t+=18;hr(t);t+=26;
  T('Order total',M,t,12);T(money(o.amount),200,t,12);t+=18;
  T('Paid to date',M,t,12);T(money(paid(o)),200,t,12);t+=18;
  T('Balance',M,t,13,1);T(money(bal(o)),200,t,13,1);t+=38;
  T('Thank you!',M,t,14,1);
  return buildPdf(ops.join('\n'),W,H,logo,logoPx);
}
function buildPdf(content,W,H,logo,logoPx){
  const enc=s=>{const a=new Uint8Array(s.length);for(let k=0;k<s.length;k++)a[k]=s.charCodeAt(k)&255;return a};
  const chunks=[],offs=[];let pos=0;const add=x=>{const a=typeof x=='string'?enc(x):x;chunks.push(a);pos+=a.length};
  const obj=(n,body)=>{offs[n]=pos;add(`${n} 0 obj\n${body}\nendobj\n`)};
  add('%PDF-1.4\n');
  obj(1,'<< /Type /Catalog /Pages 2 0 R >>');obj(2,'<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3,`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >>${logo?' /XObject << /Im1 6 0 R >>':''} >> /Contents 7 0 R >>`);
  obj(4,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  obj(5,'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  if(logo){offs[6]=pos;add(`6 0 obj\n<< /Type /XObject /Subtype /Image /Width ${logoPx} /Height ${logoPx} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${logo.length} >>\nstream\n`);add(logo);add('\nendstream\nendobj\n')}
  else obj(6,'null');
  obj(7,`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  const xr=pos;add('xref\n0 8\n0000000000 65535 f \n');for(let n=1;n<=7;n++)add(String(offs[n]).padStart(10,'0')+' 00000 n \n');
  add(`trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xr}\n%%EOF`);
  const out=new Uint8Array(pos);let at=0;chunks.forEach(a=>{out.set(a,at);at+=a.length});return out;
}
const api={receiptPdf};
if(typeof module!=='undefined'&&module.exports)module.exports=api;else root.KikooReceipt=api;
})(typeof window!=='undefined'?window:this);
