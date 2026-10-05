import * as THREE from 'three';

function toBytes(value){
  if(value instanceof Uint8Array)return value;
  if(value instanceof ArrayBuffer)return new Uint8Array(value);
  if(ArrayBuffer.isView(value))return new Uint8Array(value.buffer,value.byteOffset,value.byteLength);
  if(Array.isArray(value))return Uint8Array.from(value);
  return new Uint8Array();
}

function triangulateFaces(faces,vertexCount){
  const indices=[];
  for(let i=0;i<faces.length;){
    let count=Number(faces[i++]);
    if(count<3)count+=3;
    if(count<3||count>4096||i+count>faces.length)break;
    const first=Number(faces[i]);
    if(first<0||first>=vertexCount){i+=count;continue}
    for(let j=1;j<count-1;j++){
      const b=Number(faces[i+j]);
      const c=Number(faces[i+j+1]);
      if(b>=0&&b<vertexCount&&c>=0&&c<vertexCount)indices.push(first,b,c);
    }
    i+=count;
  }
  return indices;
}

function readCoord(view,offset,size){
  return size===8?view.getFloat64(offset,true):view.getFloat32(offset,true);
}

function probeLayout(view,total,vertexCount,faceIntCount,vertexOffset,size){
  const faceOffset=vertexOffset+vertexCount*3*size;
  const end=faceOffset+faceIntCount*4;
  if(vertexOffset<24||end>total)return null;
  let min=Infinity,max=-Infinity;
  const sample=Math.min(vertexCount,32);
  for(let i=0;i<sample;i++){
    const base=vertexOffset+i*3*size;
    for(let j=0;j<3;j++){
      const value=readCoord(view,base+j*size,size);
      if(!Number.isFinite(value)||Math.abs(value)>1e16)return null;
      min=Math.min(min,value);max=Math.max(max,value);
    }
  }
  let cursor=faceOffset,checked=0,valid=0,polygons=0;
  while(checked<256&&cursor+4<=end&&polygons<24){
    let count=view.getInt32(cursor,true);cursor+=4;checked++;
    if(count<3)count+=3;
    if(count<3||count>4096||checked+count>faceIntCount)break;
    let ok=true;
    for(let j=0;j<count;j++){
      const index=view.getInt32(cursor+j*4,true);
      if(index>=0&&index<vertexCount)valid++;else ok=false;
      checked++;
    }
    if(ok)polygons++;
    cursor+=count*4;
  }
  if(!polygons||valid<3)return null;
  const exact=end===total?40:(total-end<64?20:0);
  return {vertexOffset,faceOffset,size,score:polygons*4+valid+exact,extent:max-min};
}

function detectLayout(view,total,vertexCount,faceIntCount,minVertexOffset=24){
  const candidates=[];
  for(const size of [8,4]){
    for(let offset=minVertexOffset;offset<=Math.min(minVertexOffset+512,total-4);offset+=4){
      const result=probeLayout(view,total,vertexCount,faceIntCount,offset,size);
      if(result)candidates.push(result);
    }
    for(let padding=0;padding<=256;padding+=4){
      const faceOffset=total-padding-faceIntCount*4;
      const offset=faceOffset-vertexCount*3*size;
      if(offset<minVertexOffset)continue;
      const result=probeLayout(view,total,vertexCount,faceIntCount,offset,size);
      if(result)candidates.push(result);
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

function detectSgeoStructure(view,total){
  const candidates=[];
  const maxHeader=Math.min(192,total-8);

  for(let countOffset=8;countOffset<=maxHeader;countOffset+=4){
    const vertexCount=view.getUint32(countOffset,true);
    const faceIntCount=view.getUint32(countOffset+4,true);
    if(
      !vertexCount||vertexCount>10_000_000||
      !faceIntCount||faceIntCount>40_000_000
    )continue;

    const layout=detectLayout(view,total,vertexCount,faceIntCount,countOffset+8);
    if(!layout)continue;

    let score=layout.score;
    if(countOffset===16)score+=30;
    if(layout.vertexOffset===countOffset+8)score+=25;
    if(vertexCount<5_000_000)score+=5;
    if(faceIntCount<20_000_000)score+=5;

    candidates.push({
      countOffset,
      vertexCount,
      faceIntCount,
      layout,
      score
    });
  }

  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]||null;
}

export function decodeSgeoMesh(value){
  const bytes=toBytes(value);
  if(bytes.byteLength<24)return null;
  if(String.fromCharCode(...bytes.slice(0,4))!=='SGEO')return null;

  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const version=bytes[4];
  const primitive=bytes[5];
  const flags=view.getUint16(6,true);
  const unitsCode=view.getUint16(8,true);
  if(version!==1||primitive!==0)return null;

  const structure=detectSgeoStructure(view,bytes.byteLength);
  if(!structure)return null;

  const {vertexCount,faceIntCount,layout,countOffset}=structure;

  const positions=new Float32Array(vertexCount*3);
  let offset=layout.vertexOffset;
  for(let i=0;i<positions.length;i++,offset+=layout.size){
    const n=readCoord(view,offset,layout.size);
    if(!Number.isFinite(n)||Math.abs(n)>3.3e38)return null;
    positions[i]=n;
  }

  const faces=new Int32Array(faceIntCount);
  offset=layout.faceOffset;
  for(let i=0;i<faces.length;i++,offset+=4)faces[i]=view.getInt32(offset,true);

  const indices=triangulateFaces(faces,vertexCount);
  if(!indices.length)return null;

  return {
    positions,indices,flags,unitsCode,vertexCount,faceIntCount,
    layout:{countOffset,vertexOffset:layout.vertexOffset,faceOffset:layout.faceOffset,bytesPerCoordinate:layout.size,score:structure.score,extent:layout.extent}
  };
}

export function inspectSgeo(value){
  const bytes=toBytes(value);
  const hex=[...bytes.slice(0,48)].map(v=>v.toString(16).padStart(2,'0')).join(' ');
  if(bytes.byteLength<6)return {length:bytes.byteLength,magic:'',version:null,primitive:null,hex};
  const magic=String.fromCharCode(...bytes.slice(0,4));
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength);
  const u32=[];
  for(let offset=8;offset+4<=Math.min(bytes.byteLength,64);offset+=4){
    u32.push([offset,view.getUint32(offset,true)]);
  }
  return {
    length:bytes.byteLength,
    magic,
    version:bytes[4],
    primitive:bytes[5],
    flags:bytes.byteLength>=8?view.getUint16(6,true):null,
    unitsCode:bytes.byteLength>=10?view.getUint16(8,true):null,
    u32,
    hex
  };
}

export function matrixFromBundleTransform(value){
  if(!value)return null;
  const values=Array.isArray(value)
    ? value.map(Number)
    : String(value).split(',').map(Number);
  if(values.length!==16||values.some(v=>!Number.isFinite(v)))return null;

  // Speckle Bundle armazena 16 doubles em row-major. Para uma transformação
  // affine válida, a última linha deve ser aproximadamente [0, 0, 0, 1].
  // Matrizes projetivas/malformadas fazem Vector3.applyMatrix4 dividir por w
  // e podem explodir coordenadas normais para 1e18/1e19.
  const affineTolerance=1e-8;
  if(
    Math.abs(values[12])>affineTolerance||
    Math.abs(values[13])>affineTolerance||
    Math.abs(values[14])>affineTolerance||
    Math.abs(values[15]-1)>affineTolerance
  )return null;

  const matrix=new THREE.Matrix4();
  matrix.set(...values);

  const e=matrix.elements;
  const maxLinear=Math.max(
    Math.abs(e[0]),Math.abs(e[1]),Math.abs(e[2]),
    Math.abs(e[4]),Math.abs(e[5]),Math.abs(e[6]),
    Math.abs(e[8]),Math.abs(e[9]),Math.abs(e[10])
  );
  const maxTranslation=Math.max(Math.abs(e[12]),Math.abs(e[13]),Math.abs(e[14]));
  if(!Number.isFinite(maxLinear)||!Number.isFinite(maxTranslation)||maxLinear>1e6||maxTranslation>1e9)return null;

  return matrix;
}

export function finiteBox(box){
  if(!box||box.isEmpty())return false;
  return [
    box.min.x,box.min.y,box.min.z,
    box.max.x,box.max.y,box.max.z
  ].every(Number.isFinite);
}

export function createThreeGeometry(content){
  const decoded=decodeSgeoMesh(content);
  if(!decoded)return null;

  const geometry=new THREE.BufferGeometry();
  geometry.setAttribute('position',new THREE.BufferAttribute(decoded.positions,3));
  geometry.setIndex(decoded.indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  geometry.userData.phdSgeoLayout=decoded.layout;
  geometry.userData.phdSgeoFlags=decoded.flags;
  geometry.userData.phdSgeoUnitsCode=decoded.unitsCode;
  return geometry;
}
