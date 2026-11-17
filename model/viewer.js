'use strict';
const $=s=>document.querySelector(s),canvas=$('#view'),wingZ=[-3.4,0,3.4,6.8,10.2,13.6,17,20.4,23.8,27.2,38.1],slabZ=[-2.85,0,5.45,9.9,13.45,17,20.55,24.1,27.65,32.45,38.1];
const floorNames=['Цокольный этаж','1 этаж','2 этаж','3 этаж','4 этаж','5 этаж','6 этаж','7 этаж','Мансарда','Башни'];
const names={yard:'Двор · ТБО, парковка, площадка',utility:'Инженерные сети · трассы',geobase:'Инженерные сети · исходный план',sill:'У1 · Отливы',belt:'У2 · Покрытия поясков',hood:'У3 · Сандрики: кандидаты',cornice:'У4 · Венчающий карниз кровли',foundation:'Фундаменты',media:'Медиаэкран',shell:'Наружные стены',inside:'Внутренние стены',slabs:'Перекрытия',stairs:'Внутренние лестницы',roof:'Кровля',windows:'Остекление',doors:'Дверные заполнения',decor:'Фасадный декор',water:'Водосток',outside:'Наружные элементы',site:'Благоустройство'};
let layer={},cuts=[],model,gl,prog,lineProg,geom,ind,linesBuffer,lineData=[],sel=0,mode='all',floor=-1,spread=0,queued=false,angle=-.31,elev=.58,span=112,target=[0,0,13],pixelRatio=1;
const axes=['X','Y','Z'],limits=[[-40,60],[-44,55],[-7.2,38.2]];
const byId=new Map(),held=new Map();let lastPointer=null,gesture=null,moved=0,sectionTimer,sceneBounds;
const vshader=`#version 300 es
layout(location=0) in vec3 aPos;layout(location=1) in vec3 aNorm;layout(location=2) in vec3 aColor;layout(location=3) in float aId;
uniform vec3 rightV,upV,eyeV,targetV;uniform vec2 scale;uniform float offsetZ;out vec3 orig,world,norm,col;flat out float objId;
void main(){orig=aPos*.002;world=orig+vec3(0,0,offsetZ);vec3 d=world-targetV;gl_Position=vec4(dot(d,rightV)*scale.x,dot(d,upV)*scale.y,-dot(d,eyeV)/280.,1);norm=aNorm;col=aColor;objId=aId;}`;
const frag=`#version 300 es
precision highp float;in vec3 orig,world,norm,col;flat in float objId;uniform vec3 cutSign,cutValue;uniform vec2 floorLimit;uniform float alpha,selected,picking,flatColor,repairColors;out vec4 pixel;
void main(){if(orig.z<floorLimit.x||orig.z>floorLimit.y||any(greaterThan((orig-cutValue)*cutSign,vec3(.0001))))discard;
if (picking>.5){pixel=vec4(mod(objId,256.)/255.,floor(objId/256.)/255.,0,1);return;}
float light=.75+.25*max(0.,dot(normalize(norm),normalize(vec3(-.45,-.48,.8))))+.07*max(0.,norm.z);
vec3 base=col;if(objId>1764.5 && objId<2357.5 && repairColors<.5)base=col.b>.8?vec3(.26,.17,.14):vec3(.66,.68,.69);if(abs(objId-11.)<.1||abs(objId-12.)<.1||abs(objId-125.)<.1||abs(objId-126.)<.1){vec2 uv=abs(norm.x)>.5?orig.yz:(abs(norm.y)>.5?orig.xz:orig.xy);vec2 f=fract(uv/.3);float edge=min(min(f.x,1.-f.x),min(f.y,1.-f.y));float seam=1.-smoothstep(.004,.012,edge);float speck=fract(sin(dot(floor(uv*110.),vec2(127.1,311.7)))*43758.5453);base+=vec3((speck-.5)*.055);base=mix(base,vec3(.32,.33,.32),seam*.65);}vec3 c=base*mix(light,1.,flatColor);if(abs(selected-objId)<.1)c=mix(c,vec3(.93,.47,.15),.64);pixel=vec4(c,alpha);}`;
const lineVert=`#version 300 es
layout(location=0) in vec3 p;uniform vec3 rightV,upV,eyeV,targetV;uniform vec2 scale;out vec3 wp;void main(){wp=p;vec3 d=p-targetV;gl_Position=vec4(dot(d,rightV)*scale.x,dot(d,upV)*scale.y,-dot(d,eyeV)/280.-.000015,1.);}`;
const lineFrag=`#version 300 es
precision highp float;uniform vec3 tint;out vec4 pixel;void main(){pixel=vec4(tint,1.);}`;
function program(v,f){let p=gl.createProgram();for(let [type,source] of [[gl.VERTEX_SHADER,v],[gl.FRAGMENT_SHADER,f]]){let s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));gl.attachShader(p,s)}gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));return p}
function state(){let a=Math.cos(angle),b=Math.sin(angle),c=Math.cos(elev),d=Math.sin(elev);return {eye:[b*c,a*c,d],right:[-a,b,0],up:[-b*d,-a*d,c],scale:[2/(span*canvas.width/canvas.height),2/span]}}
function un(p,n){return gl.getUniformLocation(p,n)}
function cameraUniform(p){let s=state();for(let [k,v] of [['rightV',s.right],['upV',s.up],['eyeV',s.eye],['targetV',target]])gl.uniform3fv(un(p,k),v);gl.uniform2fv(un(p,'scale'),s.scale)}
function resize(){pixelRatio=Math.min(devicePixelRatio||1,1.6);let w=Math.max(1,Math.round(canvas.clientWidth*pixelRatio)),h=Math.max(1,Math.round(canvas.clientHeight*pixelRatio));if(w!==canvas.width||h!==canvas.height){canvas.width=w;canvas.height=h}gl.viewport(0,0,w,h)}
function groups(){return model.meta.groups.filter(([k,f])=>layer[k].on&&layer[k].a>0&&(floor<0||f<0||floor===f)&&!(spread>.01&&floor<0&&f<0&&['outside','water','decor','media'].includes(k)))}
function zOff(k,f){if(floor>=0)return 0;if(f>=0)return f*spread;if(k==='roof')return 9*spread;return 0}
function floorRange(f,region){let z=region?wingZ:slabZ;return floor<0||f>=0?[-1000,1000]:[z[floor]-.18,z[floor+1]-.001]}
function draw(picking=false){if(!model||!gl)return;resize();gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);gl.depthFunc(gl.LEQUAL);gl.disable(gl.CULL_FACE);if(!picking&&layer.geobase?.on)drawGeoBase();gl.useProgram(prog);gl.bindVertexArray(geom);cameraUniform(prog);gl.uniform1f(un(prog,'repairColors'),+$('#repairColors').checked);
 gl.uniform3fv(un(prog,'cutSign'),cuts.map(c=>c.on?(c.flip?-1:1):0));gl.uniform3fv(un(prog,'cutValue'),cuts.map(c=>c.v));gl.uniform1f(un(prog,'flatColor'),+$('#flat').checked);gl.uniform1f(un(prog,'selected'),sel);gl.uniform1f(un(prog,'picking'),+picking);
 const drawGroup=([k,f,first,count,region])=>{gl.uniform1f(un(prog,'alpha'),layer[k].a/100);gl.uniform1f(un(prog,'offsetZ'),zOff(k,f));gl.uniform2fv(un(prog,'floorLimit'),floorRange(f,region));gl.drawElements(gl.TRIANGLES,count,gl.UNSIGNED_INT,first*4)};
 const gs=groups();gl.depthMask(true);gl.disable(gl.BLEND);if(picking)gs.forEach(drawGroup);else{gs.filter(g=>layer[g[0]].a===100).forEach(drawGroup);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gs.filter(g=>layer[g[0]].a<100).forEach(drawGroup);gl.depthMask(true);gl.disable(gl.BLEND);
 if(lineData.length){gl.bindVertexArray(null);gl.useProgram(lineProg);cameraUniform(lineProg);gl.enableVertexAttribArray(0);if(capData.length){gl.uniform3f(un(lineProg,'tint'),.82,.58,.37);gl.bindBuffer(gl.ARRAY_BUFFER,capBuffer);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.drawArrays(gl.TRIANGLES,0,capData.length/3)}gl.uniform3f(un(lineProg,'tint'),.46,.20,.07);gl.bindBuffer(gl.ARRAY_BUFFER,linesBuffer);gl.vertexAttribPointer(0,3,gl.FLOAT,false,0,0);gl.drawArrays(gl.LINES,0,lineData.length/3)}}gl.bindVertexArray(null)}
function request(){if(!queued){queued=true;requestAnimationFrame(()=>{queued=false;draw()})}}
function pick(x,y){if(!model)return;draw(true);let r=canvas.getBoundingClientRect(),px=new Uint8Array(4);gl.readPixels(Math.min(canvas.width-1,Math.floor((x-r.left)*pixelRatio)),Math.max(0,canvas.height-1-Math.floor((y-r.top)*pixelRatio)),1,1,gl.RGBA,gl.UNSIGNED_BYTE,px);sel=px[0]+px[1]*256;let obj=model.meta.objects[sel-1];$('#picked').hidden=!obj;if(obj){$('#nodeLink').hidden=true;$('#nodeLink').href='nodes.html#'+(obj[2]['Узел']||'');$('#picked b').textContent=obj[0];$('#picked small').textContent=[obj[1],obj[2]['Зона уровней'],obj[2]['Основание']||obj[2]['Подтверждение'],obj[2]['Отделка'],obj[2]['Узел'],obj[2]['Статус'],obj[2]['Примечание']].filter(Boolean).join(' · ')}request()}
function clearPick(){sel=0;$('#picked').hidden=true;request()}
function contourWorker(){
 let pos,idx,ids;
 self.onmessage=e=>{
  if(e.data.init){({pos,idx,ids}=e.data);return}
  const {jobs,planes,version}=e.data,lines=[],caps=[],read=(i,a)=>pos[i*3+a]*.002;
  for(const {first,count,off,range} of jobs)for(let ax=0;ax<3;ax++){
   if(!planes[ax].on)continue;
   const h=planes[ax].v,u=(ax+1)%3,v=(ax+2)%3,byObj=new Map();
   const trims=planes.flatMap((p,l)=>p.on&&l!==ax?[[l,p.v,p.flip?-1:1]]:[]).concat([[2,range[0],-1],[2,range[1],1]]);
   const lerp=(p,q,t)=>p.map((x,k)=>x+(q[k]-x)*t);
   const add=(to,p)=>to.push(p[0],p[1],p[2]+off);
   for(let t=first;t<first+count;t+=3){
    let i=idx[t],j=idx[t+1],k=idx[t+2],a=read(i,ax)-h,b=read(j,ax)-h,c=read(k,ax)-h;
    if((a>=0&&b>=0&&c>=0)||(a<0&&b<0&&c<0))continue;
    const pts=[];for(const [s,r,x,y] of [[i,j,a,b],[j,k,b,c],[k,i,c,a]])if((x<0)!==(y<0)){let d=x/(x-y);pts.push([0,1,2].map(l=>read(s,l)+(read(r,l)-read(s,l))*d))}
    if(pts.length!==2)continue;let [p,q]=pts,lo=0,hi=1;
    for(const [l,bound,sign] of trims){let x=(p[l]-bound)*sign,y=(q[l]-bound)*sign;if(x>0&&y>0){lo=2;break}if((x>0)!==(y>0)){let d=x/(x-y);if(x>0)lo=Math.max(lo,d);else hi=Math.min(hi,d)}}
    if(lo<=hi){add(lines,lerp(p,q,lo));add(lines,lerp(p,q,hi))}
    if(Math.abs(p[v]-q[v])<.00001)continue;if(p[v]>q[v])[p,q]=[q,p];
    const key=ids[i];if(!byObj.has(key))byObj.set(key,[]);byObj.get(key).push([p[u],p[v],q[u],q[v]]);
   }
   // Even–odd scan conversion preserves holes inside each individual cut solid.
   for(const edges of byObj.values()){
    const events=new Map();
    for(let i=0;i<edges.length;i++){const edge=edges[i];for(const [val,sgn] of [[edge[1],1],[edge[3],-1]]){let k=Math.round(val*100000);if(!events.has(k))events.set(k,[]);events.get(k).push((i+1)*sgn)}}
    const levels=[...events.keys()].sort((a,b)=>a-b),active=new Set();
    const xAt=(s,y)=>s[0]+(y-s[1])*(s[2]-s[0])/(s[3]-s[1]);
    const point=(x,y)=>{let p=[0,0,0];p[ax]=h;p[u]=x;p[v]=y;return p};
    for(let j=0;j<levels.length-1;j++){let row=levels[j],low=row/100000,high=levels[j+1]/100000;
     for(let ev of events.get(row)){if(ev>0)active.add(ev-1);else active.delete(-ev-1)}
     const spans=[...active].map(i=>edges[i]).sort((a,b)=>xAt(a,(low+high)/2)-xAt(b,(low+high)/2));
     for(let i=1;i<spans.length;i+=2){const a=spans[i-1],b=spans[i];if(xAt(b,(low+high)/2)-xAt(a,(low+high)/2)<.00001)continue;
      let poly=[point(xAt(a,low),low),point(xAt(b,low),low),point(xAt(b,high),high),point(xAt(a,high),high)];
      for(let [l,bound,sign] of trims){let dst=[];for(let k=0;k<poly.length;k++){let p=poly[k],q=poly[(k+1)%poly.length],s=(p[l]-bound)*sign,r=(q[l]-bound)*sign;if(s<=0)dst.push(p);if((s<=0)!==(r<=0))dst.push(lerp(p,q,s/(s-r)))}poly=dst}
      for(let k=1;k<poly.length-1;k++){add(caps,poly[0]);add(caps,poly[k]);add(caps,poly[k+1])}
     }
    }
   }
  }
  let l=new Float32Array(lines),c=new Float32Array(caps);self.postMessage({version,l,c},[l.buffer,c.buffer])
 }
}
let calcWorker,sectionVersion=0,capData=[],capBuffer;
function sections(){clearTimeout(sectionTimer);sectionVersion++;lineData=[];capData=[];request();if(!model||!cuts.some(c=>c.on))return;sectionTimer=setTimeout(()=>{
 const jobs=groups().map(([k,f,first,count,region])=>({first,count,off:zOff(k,f),range:floorRange(f,region)})),planes=cuts.map(({on,v,flip})=>({on,v,flip}));
 calcWorker.postMessage({jobs,planes,version:sectionVersion})
},60)}
function fit(){const aspect=Math.max(.25,canvas.clientWidth/canvas.clientHeight);span=Math.max(100,125/aspect)+(floor<0?spread*6:0);target=[0,0,floor<0?13+spread*3.5:(slabZ[floor]+slabZ[floor+1])/2];request()}
function preset(v){if(v==='media'){angle=-2.12;elev=.15;target=[-29,-26.48,19];span=Math.max(44,35/Math.max(.25,canvas.clientWidth/canvas.clientHeight));$('#vtitle').textContent='Торец с медиаэкраном';$('#camera').value='media';request();return}let pairs={yard:[-.33,.60,'Вид со двора'],street:[2.84,.51,'Вид с улицы'],front:[Math.PI,.012,'Главный фасад'],top:[Math.PI,Math.PI/2-.0001,'План сверху']};[angle,elev]=pairs[v];$('#vtitle').textContent=pairs[v][2];$('#camera').value=v;fit()}
function setMode(m){mode=m;for(let k in names){layer[k]={on:m==='all'?!['utility','geobase'].includes(k):(m==='repair'?['shell','roof','windows','decor','water','sill','belt','hood','cornice'].includes(k):m==='foundation'?k==='foundation':m==='structure'?['foundation','shell','inside','slabs','stairs'].includes(k):['shell','outside','water','utility','geobase'].includes(k)),a:m==='structure'&&k==='shell'?22:m==='systems'&&k==='shell'?16:k==='geobase'?65:100}}
 document.querySelectorAll('[data-mode]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.mode===m)));$('#badge').textContent=({all:'01 / ОБЩИЙ ВИД',structure:'02 / КОНСТРУКТИВ',systems:'03 / СИСТЕМЫ',foundation:'04 / ФУНДАМЕНТЫ',repair:'05 / КАПРЕМОНТ ФАСАДА'})[m];for(let k in layer){let e=byId.get(k);e.ck.checked=layer[k].on;e.range.value=layer[k].a;e.out.textContent=layer[k].a+'%'}clearPick();sections()}
function showCornice(){showRepair();for(let k of ['sill','belt','hood']){layer[k].on=false;byId.get(k).ck.checked=false}$('#vtitle').textContent='Венчающий карниз кровли · периметр';sections();request()}
function showRepair(){reset();setMode('repair');$('#repairColors').checked=true;preset('street');$('#vtitle').textContent='Капремонт: металлические покрытия';request()}
function showFoundations(){reset();setMode('foundation');angle=-.62;elev=.9;target=[0,0,-5];span=Math.max(76,100/Math.max(.25,canvas.clientWidth/canvas.clientHeight));$('#vtitle').textContent='Фундаменты корпусов А и Б';$('#camera').selectedIndex=-1;sections()}
function setupUI(){$('#yardView').onclick=showYard;$('#networksView').onclick=showNetworks;$('#repairColors').onchange=request;$('#repairView').onclick=showRepair;$('#corniceView').onclick=showCornice;$('#foundationView').onclick=showFoundations;for(let [k,n] of Object.entries(names)){let d=document.createElement('div');d.className='layer';d.innerHTML='<label><input type="checkbox">'+n+'</label><input type="range" min="0" max="100" step="1" aria-label="Непрозрачность: '+n+'"><output></output>';let [ck,range]=d.querySelectorAll('input'),out=d.querySelector('output');ck.onchange=()=>{layer[k].on=ck.checked;clearPick();sections()};range.oninput=()=>{layer[k].a=+range.value;out.textContent=range.value+'%';if(layer[k].a&&!ck.checked){layer[k].on=ck.checked=true}sections()};byId.set(k,{ck,range,out});$('#layers').append(d)}
 for(let i=0;i<3;i++){let d=document.createElement('div'),ax=axes[i];d.className='cut';d.innerHTML='<label class="axis"><input type="checkbox" aria-label="Сечение '+ax+'">'+ax+'</label><input type="range" step=".1" aria-label="Положение сечения '+ax+'"><output></output><button title="Развернуть '+ax+'" aria-label="Развернуть сечение '+ax+'">⇄</button>';let [ck,r]=d.querySelectorAll('input'),o=d.querySelector('output'),btn=d.querySelector('button');[r.min,r.max]=limits[i];let c={on:false,v:i===2?14:0,flip:false,ck,r,o,btn};cuts.push(c);ck.onchange=()=>{c.on=ck.checked;sections()};r.oninput=()=>{c.v=+r.value;c.on=ck.checked=true;o.textContent=c.v.toFixed(1)+' м';sections()};btn.onclick=()=>{c.flip=!c.flip;c.on=ck.checked=true;btn.textContent=c.flip?'←':'→';btn.setAttribute('aria-pressed',String(c.flip));sections()};$('#cuts').append(d)}
 for(let i=0;i<floorNames.length;i++)$('#floor').add(new Option(floorNames[i],i));$('#floor').onchange=e=>{floor=+e.target.value;$('#spread').disabled=floor>=0;clearPick();sections();fit()};$('#spread').oninput=e=>{spread=+e.target.value;$('#spreadval').textContent=spread.toFixed(1)+' м';sections();fit()};$('#camera').onchange=e=>preset(e.target.value);$('#zoomout').onclick=()=>zoom(1.2);$('#zoomin').onclick=()=>zoom(1/1.2);$('#fit').onclick=fit;$('#picked .close').onclick=clearPick;$('#modes').onclick=e=>{if(e.target.dataset.mode)setMode(e.target.dataset.mode)};$('#flat').onchange=request;$('#wingcut').onclick=()=>{reset();setMode('structure');let c=cuts[1];c.v=18;c.r.value=18;c.o.textContent='18,0 м';c.ck.checked=c.on=true;angle=0;elev=.025;target=[0,18,10.2];span=Math.max(40,73/Math.max(.25,canvas.clientWidth/canvas.clientHeight));$('#camera').selectedIndex=-1;$('#vtitle').textContent='Разрез дворовых крыльев';sections()};$('#reset').onclick=reset;$('#archive').onclick=$('#help').onclick=()=>$('#about').showModal();$('#about .close').onclick=()=>$('#about').close();reset()}
function reset(){floor=-1;spread=0;$('#floor').value='-1';$('#spread').value=0;$('#spread').disabled=false;$('#spreadval').textContent='0 м';for(let [i,c] of cuts.entries()){c.on=c.ck.checked=false;c.flip=false;c.btn.textContent='→';c.btn.setAttribute('aria-pressed','false');c.v=i===2?14:0;c.r.value=c.v;c.o.textContent=c.v.toFixed(1)+' м'}setMode('all');preset('yard')}
function zoom(f){span=Math.min(340,Math.max(3,span*f));request()}
function pan(dx,dy){let s=state(),u=span/canvas.clientHeight;target=target.map((v,k)=>v+(-dx*s.right[k]+dy*s.up[k])*u)}
function pointerState(){let pts=[...held.values()];if(pts.length!==2)return null;return {x:(pts[0].x+pts[1].x)/2,y:(pts[0].y+pts[1].y)/2,d:Math.hypot(pts[0].x-pts[1].x,pts[0].y-pts[1].y)}}
canvas.onpointerdown=e=>{canvas.setPointerCapture(e.pointerId);held.set(e.pointerId,{x:e.clientX,y:e.clientY});lastPointer=[e.clientX,e.clientY];if(held.size===1)moved=0;else moved=10;gesture=pointerState()};
canvas.onpointermove=e=>{if(!held.has(e.pointerId))return;let dx=e.clientX-lastPointer[0],dy=e.clientY-lastPointer[1];held.set(e.pointerId,{x:e.clientX,y:e.clientY});let g=pointerState();if(g&&gesture){pan(g.x-gesture.x,g.y-gesture.y);zoom(gesture.d/Math.max(g.d,1));moved=20}else if(held.size===1){moved+=Math.hypot(dx,dy);if(e.shiftKey||e.buttons===2)pan(dx,dy);else{angle+=dx*.008;elev=Math.max(-1.44,Math.min(1.56,elev+dy*.008));if(moved>4)$('#vtitle').textContent='Свободный ракурс'}}lastPointer=[e.clientX,e.clientY];gesture=g;request()};
canvas.onpointerup=e=>{if(moved<4&&held.size===1)pick(e.clientX,e.clientY);held.delete(e.pointerId);gesture=pointerState();if(held.size){let p=[...held.values()][0];lastPointer=[p.x,p.y];moved=20}};canvas.onpointercancel=e=>{held.delete(e.pointerId);gesture=null};canvas.oncontextmenu=e=>e.preventDefault();canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(Math.exp(Math.max(-300,Math.min(300,e.deltaY))*.0015))},{passive:false});
canvas.onkeydown=e=>{if(e.key==='ArrowLeft')angle-=.12;else if(e.key==='ArrowRight')angle+=.12;else if(e.key==='ArrowUp')elev=Math.min(1.56,elev+.12);else if(e.key==='ArrowDown')elev=Math.max(-1.44,elev-.12);else if(e.key==='+')zoom(.8);else if(e.key==='-')zoom(1.25);else return;e.preventDefault();request()};
async function start(){setupUI();try{gl=canvas.getContext('webgl2',{alpha:true,antialias:true,preserveDrawingBuffer:false});if(!gl)throw Error('WebGL 2 недоступен. Для вращения и сечений откройте сайт в браузере с аппаратным ускорением.');prog=program(vshader,frag);lineProg=program(lineVert,lineFrag);
 let bytes=Uint8Array.from(atob(window.KP9_DATA),c=>c.charCodeAt(0));window.KP9_DATA=null;let buf=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();let size=new DataView(buf).getUint32(0,true),meta=JSON.parse(new TextDecoder().decode(new Uint8Array(buf,4,size))),vo=4+size,io=vo+meta.vertices*16;let vertex=buf.slice(vo,io),indices=new Uint32Array(buf.slice(io));
 geom=gl.createVertexArray();gl.bindVertexArray(geom);let vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,vertex,gl.STATIC_DRAW);
 for(let [i,n,type,normal,off] of [[0,3,gl.SHORT,false,0],[1,3,gl.BYTE,true,6],[2,3,gl.UNSIGNED_BYTE,true,9],[3,1,gl.UNSIGNED_SHORT,false,12]]){gl.enableVertexAttribArray(i);gl.vertexAttribPointer(i,n,type,normal,16,off)}
 ind=gl.createBuffer();gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,ind);gl.bufferData(gl.ELEMENT_ARRAY_BUFFER,indices,gl.STATIC_DRAW);gl.bindVertexArray(null);linesBuffer=gl.createBuffer();capBuffer=gl.createBuffer();const coords=new Int16Array(vertex),us=new Uint16Array(vertex),pos=new Int16Array(meta.vertices*3),ids=new Uint16Array(meta.vertices);
 for(let i=0;i<meta.vertices;i++){for(let a=0;a<3;a++)pos[i*3+a]=coords[8*i+a];ids[i]=us[8*i+6]}
 const workerURL=URL.createObjectURL(new Blob(['('+contourWorker.toString()+')()'],{type:'application/javascript'}));calcWorker=new Worker(workerURL);calcWorker.postMessage({init:true,pos,ids,idx:indices},[pos.buffer,ids.buffer,indices.buffer]);
 calcWorker.onmessage=e=>{if(e.data.version!==sectionVersion)return;lineData=e.data.l;capData=e.data.c;for(let [buf,data] of [[linesBuffer,lineData],[capBuffer,capData]]){gl.bindBuffer(gl.ARRAY_BUFFER,buf);gl.bufferData(gl.ARRAY_BUFFER,data,gl.DYNAMIC_DRAW)}request()};
 model={meta};setupGeoBase();resize();if(new URLSearchParams(location.search).get('view')==='yard')showYard();else if(new URLSearchParams(location.search).get('view')==='networks')showNetworks();else if(new URLSearchParams(location.search).get('view')==='foundations')showFoundations();else if(new URLSearchParams(location.search).get('view')==='media')preset('media');else if(new URLSearchParams(location.search).get('view')==='cornice')showCornice();else if(new URLSearchParams(location.search).get('view')==='repair')showRepair();else fit();sections();draw();$('#loading').hidden=true;document.body.dataset.ready='true';new ResizeObserver(()=>{request()}).observe(canvas);
 }catch(e){if(new URLSearchParams(location.search).get('view')==='yard'){$('#loading img').src='yard/plan.png';$('#loadtext').insertAdjacentHTML('afterend','<a hidden href="#">Открыть план двора и источник →</a>')}$('#loadtext').textContent='3D-просмотр недоступен. '+e.message;if(new URLSearchParams(location.search).get('view')==='repair')$('#loading img').src='Sheet_1.png';if(new URLSearchParams(location.search).get('view')==='networks'){$('#loading img').src='networks/registration.png';$('#loadtext').insertAdjacentHTML('afterend','<a hidden href="#">Открыть интерактивный план сетей без WebGL →</a>')}console.error(e)}}
start();

let geoProg,geoVAO,geoTexture,geoReady=false;
function showNetworks(){if(!model){return}reset();setMode('systems');for(const k of ['outside','water']){layer[k].on=false;byId.get(k).ck.checked=false}angle=Math.PI;elev=Math.PI/2-.0001;target=[0,0,0];span=Math.max(102,120/Math.max(.25,canvas.clientWidth/canvas.clientHeight));$('#camera').value='top';$('#vtitle').textContent='Инженерные сети · проекция в плане';$('#badge').textContent='ГЛУБИНЫ НЕ УСТАНОВЛЕНЫ';request()}
function setupGeoBase(){
 geoProg=program(`#version 300 es
 layout(location=0) in vec3 p;layout(location=1) in vec2 uv;uniform vec3 rightV,upV,eyeV,targetV;uniform vec2 scale;out vec2 tex;void main(){vec3 d=p-targetV;gl_Position=vec4(dot(d,rightV)*scale.x,dot(d,upV)*scale.y,-dot(d,eyeV)/280.,1);tex=uv;}`,`#version 300 es
 precision highp float;in vec2 tex;uniform sampler2D map;uniform float opacity;out vec4 pixel;void main(){pixel=vec4(texture(map,tex).rgb,opacity);}`);
 const T=window.KP9_NETWORKS.registration,M=T.matrix,t=T.translation;
 const pt=(u,v)=>[M[0][0]*u+M[0][1]*v+t[0],M[1][0]*u+M[1][1]*v+t[1],-.50,u/1790,v/919];
 const a=pt(0,0),b=pt(1790,0),c=pt(1790,919),d=pt(0,919);
 geoVAO=gl.createVertexArray();gl.bindVertexArray(geoVAO);const vb=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,vb);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([...a,...b,...c,...a,...c,...d]),gl.STATIC_DRAW);gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,3,gl.FLOAT,false,20,0);gl.enableVertexAttribArray(1);gl.vertexAttribPointer(1,2,gl.FLOAT,false,20,12);gl.bindVertexArray(null);
 geoTexture=gl.createTexture();const im=new Image();im.onload=()=>{gl.bindTexture(gl.TEXTURE_2D,geoTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,im);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);geoReady=true;request()};im.src=(window.KP9_GEOBASE||'');
}
function drawGeoBase(){if(!geoReady||!layer.geobase.a)return;gl.useProgram(geoProg);cameraUniform(geoProg);gl.bindVertexArray(geoVAO);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,geoTexture);gl.uniform1i(un(geoProg,'map'),0);gl.uniform1f(un(geoProg,'opacity'),layer.geobase.a/100);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.depthMask(false);gl.drawArrays(gl.TRIANGLES,0,6);gl.depthMask(true);gl.disable(gl.BLEND);gl.bindVertexArray(null)}

function showYard(){if(!model){return}reset();setMode('all');angle=Math.PI;elev=Math.PI/2-.0001;target=[10,5,0];span=Math.max(108,122/Math.max(.25,canvas.clientWidth/canvas.clientHeight));$('#camera').value='top';$('#vtitle').textContent='Двор · ТБО и западная зона';$('#badge').textContent='ПРИВЯЗКА ПО ПАСПОРТУ';request()}
