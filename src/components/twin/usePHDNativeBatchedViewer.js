import { useCallback, useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { SSAOPass } from 'three/addons/postprocessing/SSAOPass.js';
import { createThreeGeometry, finiteBox, matrixFromBundleTransform } from '@/components/twin/sgeoNative';

const BASE_COLOR=new THREE.Color(0x9fa3a7);
const SELECT_COLOR=new THREE.Color(0x19a8ff);
const IDENTITY=new THREE.Matrix4();

function configureBatchMaterial(material,mode='solid',globalOpacity=1){
  if(!material)return;
  const opacity=Math.max(.05,Math.min(1,Number(globalOpacity)||1));
  material.wireframe=mode==='skeleton';
  material.transparent=mode==='xray'||mode==='skeleton'||opacity<.999;
  material.opacity=mode==='xray'?Math.min(opacity,.18):mode==='skeleton'?Math.min(opacity,.68):opacity;
  material.depthWrite=mode==='solid'&&opacity>=.999;
  material.depthTest=true;
  material.alphaToCoverage=mode==='solid'&&opacity>=.999;
  material.needsUpdate=true;
}

function createQualityMaterial(clippingPlanes){
  return new THREE.MeshStandardMaterial({
    color:0xffffff,
    side:THREE.DoubleSide,
    vertexColors:false,
    roughness:.62,
    metalness:.06,
    envMapIntensity:.68,
    emissive:0x000000,
    dithering:true,
    clippingPlanes
  });
}

function createFastMaterial(clippingPlanes){
  return new THREE.MeshLambertMaterial({
    color:0xffffff,
    side:THREE.DoubleSide,
    vertexColors:false,
    emissive:0x000000,
    clippingPlanes
  });
}

function colorValue(value){
  try{return new THREE.Color(value||BASE_COLOR)}catch{return BASE_COLOR.clone()}
}

function eachEntryHandle(entry,fn){
  if(!entry)return;
  if(entry.batch)fn(entry.batch,entry.instanceId);
  for(const handle of entry.extraHandles||[])fn(handle.batch,handle.instanceId);
}

function addEntryHandle(entry,batch,instanceId){
  if(!entry.batch){
    entry.batch=batch;
    entry.instanceId=instanceId;
    return;
  }
  if(!entry.extraHandles)entry.extraHandles=[];
  entry.extraHandles.push({batch,instanceId});
}

function unionEntryBounds(entry,box){
  const next=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
  if(!entry.bounds){entry.bounds=next;return}
  entry.bounds[0]=Math.min(entry.bounds[0],next[0]);
  entry.bounds[1]=Math.min(entry.bounds[1],next[1]);
  entry.bounds[2]=Math.min(entry.bounds[2],next[2]);
  entry.bounds[3]=Math.max(entry.bounds[3],next[3]);
  entry.bounds[4]=Math.max(entry.bounds[4],next[4]);
  entry.bounds[5]=Math.max(entry.bounds[5],next[5]);
}

function saneWorldBox(box){
  if(!finiteBox(box))return false;
  const values=[box.min.x,box.min.y,box.min.z,box.max.x,box.max.y,box.max.z];
  if(values.some(value=>Math.abs(value)>1e9))return false;
  const size=box.getSize(new THREE.Vector3());
  return size.length()<1e8;
}

function boxFromEntry(entry){
  const b=entry?.bounds;
  if(!b||b.length!==6)return null;
  return new THREE.Box3(
    new THREE.Vector3(b[0],b[1],b[2]),
    new THREE.Vector3(b[3],b[4],b[5])
  );
}

function createPreparedGeometry(row){
  const prepared=row?.phdGeometry;
  if(prepared?.positions&&prepared?.indices){
    const geometry=new THREE.BufferGeometry();
    geometry.setAttribute('position',new THREE.BufferAttribute(prepared.positions,3));
    if(prepared.normals?.length===prepared.positions.length){
      geometry.setAttribute('normal',new THREE.BufferAttribute(prepared.normals,3));
    }else{
      geometry.computeVertexNormals();
    }
    geometry.setIndex(new THREE.BufferAttribute(prepared.indices,1));
    if(Array.isArray(prepared.bbox)&&prepared.bbox.length===6&&prepared.bbox.every(Number.isFinite)){
      geometry.boundingBox=new THREE.Box3(
        new THREE.Vector3(prepared.bbox[0],prepared.bbox[1],prepared.bbox[2]),
        new THREE.Vector3(prepared.bbox[3],prepared.bbox[4],prepared.bbox[5])
      );
    }else{
      geometry.computeBoundingBox();
    }
    geometry.computeBoundingSphere();
    geometry.userData.phdPrepared=true;
    return geometry;
  }
  return createThreeGeometry(row?.content);
}

export default function usePHDNativeBatchedViewer(hostRef,onObjectSelected){
  const callbackRef=useRef(onObjectSelected);
  const rendererRef=useRef(null);
  const sceneRef=useRef(null);
  const rootRef=useRef(null);
  const perspectiveRef=useRef(null);
  const orthoRef=useRef(null);
  const activeCameraRef=useRef(null);
  const controlsRef=useRef(null);
  const composerRef=useRef(null);
  const renderPassRef=useRef(null);
  const ssaoPassRef=useRef(null);
  const batchesRef=useRef(new Set());
  const chunksRef=useRef(new Map());
  const spatialProxyRef=useRef({mesh:null,records:new Map()});
  const objectsRef=useRef(new Map());
  const selectedRef=useRef(null);
  const modelBoundsRef=useRef(new THREE.Box3());
  const projectionRef=useRef('perspective');
  const interactionRef=useRef('orbit');
  const worldOriginRef=useRef(new THREE.Vector3());
  const renderModeRef=useRef('solid');
  const globalOpacityRef=useRef(1);
  const modelVisibleRef=useRef(true);
  const sectionEnabledRef=useRef(false);
  const sectionPlaneRef=useRef(new THREE.Plane(new THREE.Vector3(0,0,-1),0));
  const statsRef=useRef({objects:0,instances:0,batches:0,invalid:0});
  const [state,setState]=useState({
    status:'idle',ready:false,error:'',
    objectCount:0,meshCount:0,batchCount:0,
    selectedObjectIndex:null,projection:'perspective'
  });

  useEffect(()=>{callbackRef.current=onObjectSelected},[onObjectSelected]);

  const requestRender=useCallback(()=>{
    const renderer=rendererRef.current;
    const scene=sceneRef.current;
    const camera=activeCameraRef.current;
    if(renderer&&scene&&camera)renderer.render(scene,camera);
  },[]);

  const renderPremium=useCallback(()=>{
    const renderer=rendererRef.current;
    const scene=sceneRef.current;
    const camera=activeCameraRef.current;
    if(!renderer||!scene||!camera)return false;

    const composer=composerRef.current;
    const renderPass=renderPassRef.current;
    const ssaoPass=ssaoPassRef.current;
    const canAO=!!composer&&!!renderPass&&!!ssaoPass&&
      renderModeRef.current==='solid'&&!sectionEnabledRef.current&&
      globalOpacityRef.current>=.999;

    if(!canAO){
      renderer.render(scene,camera);
      return true;
    }

    try{
      renderPass.camera=camera;
      ssaoPass.camera=camera;
      ssaoPass.ssaoMaterial.uniforms.cameraNear.value=camera.near;
      ssaoPass.ssaoMaterial.uniforms.cameraFar.value=camera.far;
      ssaoPass.depthRenderMaterial.uniforms.cameraNear.value=camera.near;
      ssaoPass.depthRenderMaterial.uniforms.cameraFar.value=camera.far;
      composer.render();
      return true;
    }catch{
      renderer.render(scene,camera);
      return true;
    }
  },[]);

  const entryInfo=useCallback(entry=>entry?({
    id:'bundle-object:'+entry.objectIndex,
    name:String(entry.applicationId||('Object '+entry.objectIndex)),
    applicationId:String(entry.applicationId||entry.objectIndex),
    objectIndex:Number(entry.objectIndex),
    bundle:true,
    source:'phd-native-batched-viewer'
  }):null,[]);

  const applyEntryColor=useCallback((entry,color)=>{
    const c=color?.isColor?color:colorValue(color);
    eachEntryHandle(entry,(batch,instanceId)=>batch.setColorAt(instanceId,c));
  },[]);

  const clearSelection=useCallback((notify=true)=>{
    const index=selectedRef.current;
    if(index!==null){
      const entry=objectsRef.current.get(index);
      if(entry)applyEntryColor(entry,entry.color||entry.baseColor||BASE_COLOR);
    }
    selectedRef.current=null;
    setState(current=>({...current,selectedObjectIndex:null}));
    if(notify)callbackRef.current?.(null);
    requestRender();
  },[applyEntryColor,requestRender]);

  const fitBox=useCallback((box,direction)=>{
    if(!box||!finiteBox(box))return;
    const center=box.getCenter(new THREE.Vector3());
    const size=box.getSize(new THREE.Vector3());
    const maxSize=Math.max(size.x,size.y,size.z,.1);
    const ssao=ssaoPassRef.current;
    if(ssao){
      ssao.kernelRadius=Math.max(.45,Math.min(4.5,maxSize*.0045));
      ssao.minDistance=.0015;
      ssao.maxDistance=.045;
    }
    const controls=controlsRef.current;
    const camera=activeCameraRef.current;
    const dir=(direction||new THREE.Vector3(1,-1,.75)).clone().normalize();

    if(camera===perspectiveRef.current){
      const perspective=perspectiveRef.current;
      const distance=(maxSize*.5)/Math.tan(THREE.MathUtils.degToRad(perspective.fov*.5))*1.55;
      perspective.position.copy(center).add(dir.multiplyScalar(distance));
      perspective.near=Math.max(distance/10000,.01);
      perspective.far=Math.max(distance*100,100000);
      perspective.updateProjectionMatrix();
    }else{
      const ortho=orthoRef.current;
      const host=hostRef.current;
      const aspect=Math.max(1,(host?.clientWidth||1)/(host?.clientHeight||1));
      const half=maxSize*.72;
      ortho.left=-half*aspect;ortho.right=half*aspect;
      ortho.top=half;ortho.bottom=-half;
      ortho.near=.01;ortho.far=Math.max(maxSize*1000,100000);
      ortho.position.copy(center).add(dir.multiplyScalar(maxSize*3));
      ortho.updateProjectionMatrix();
    }

    controls.target.copy(center);
    controls.update();
    requestRender();
  },[hostRef,requestRender]);

  const fit=useCallback(objectIndex=>{
    const root=rootRef.current;
    const entry=Number.isFinite(Number(objectIndex))?objectsRef.current.get(Number(objectIndex)):null;
    const entryBounds=boxFromEntry(entry);
    if(entryBounds){
      if(root)entryBounds.applyMatrix4(root.matrixWorld);
      fitBox(entryBounds);
    }else{
      fitBox(modelBoundsRef.current);
    }
  },[fitBox]);

  const selectObject=useCallback((objectIndex,{notify=true,focus=false}={})=>{
    const index=Number(objectIndex);
    const entry=objectsRef.current.get(index);
    if(!entry)return false;
    clearSelection(false);
    applyEntryColor(entry,SELECT_COLOR);
    selectedRef.current=index;
    setState(current=>({...current,selectedObjectIndex:index}));
    if(notify)callbackRef.current?.(entryInfo(entry));
    const entryBounds=boxFromEntry(entry);
    const controls=controlsRef.current;
    if(entryBounds&&controls&&!focus){
      const root=rootRef.current;
      if(root)entryBounds.applyMatrix4(root.matrixWorld);
      controls.target.copy(entryBounds.getCenter(new THREE.Vector3()));
      controls.update();
    }
    if(focus)fit(index);
    requestRender();
    return true;
  },[applyEntryColor,clearSelection,entryInfo,fit,requestRender]);

  const setWorldOrigin=useCallback(bounds=>{
    if(!Array.isArray(bounds)||bounds.length!==6)return false;
    const box=new THREE.Box3(
      new THREE.Vector3(Number(bounds[0]),Number(bounds[1]),Number(bounds[2])),
      new THREE.Vector3(Number(bounds[3]),Number(bounds[4]),Number(bounds[5]))
    );
    if(!saneWorldBox(box))return false;
    const center=box.getCenter(new THREE.Vector3());
    worldOriginRef.current.copy(center);
    const root=rootRef.current;
    if(root){
      root.position.copy(center).multiplyScalar(-1);
      root.updateMatrixWorld(true);
    }
    const localBox=box.clone().translate(center.clone().multiplyScalar(-1));
    modelBoundsRef.current.copy(localBox);
    const controls=controlsRef.current;
    if(controls){
      controls.target.set(0,0,0);
      controls.update();
    }
    requestRender();
    return true;
  },[requestRender]);

  const setRenderMode=useCallback(mode=>{
    const next=['solid','skeleton','xray'].includes(mode)?mode:'solid';
    renderModeRef.current=next;
    for(const batch of batchesRef.current){
      configureBatchMaterial(batch.userData?.qualityMaterial||batch.material,next,globalOpacityRef.current);
      configureBatchMaterial(batch.userData?.fastMaterial,next,globalOpacityRef.current);
      const usingFast=!!batch.userData?.navigationFast;
      batch.material=usingFast
        ? (batch.userData?.fastMaterial||batch.material)
        : (batch.userData?.qualityMaterial||batch.material);
    }
    const proxy=spatialProxyRef.current?.mesh;
    if(proxy){
      // O proxy espacial é apenas índice técnico. Nunca é desenhado como
      // caixas no produto final; "Esqueleto" usa a geometria real em wireframe.
      proxy.visible=false;
    }
    requestRender();
    return next;
  },[requestRender]);

  const setGlobalOpacity=useCallback(value=>{
    const opacity=Math.max(.05,Math.min(1,Number(value)));
    globalOpacityRef.current=Number.isFinite(opacity)?opacity:1;
    setRenderMode(renderModeRef.current);
    return globalOpacityRef.current;
  },[setRenderMode]);

  const setModelVisible=useCallback(visible=>{
    modelVisibleRef.current=visible!==false;
    if(rootRef.current)rootRef.current.visible=modelVisibleRef.current;
    requestRender();
    return modelVisibleRef.current;
  },[requestRender]);

  const setVisible=useCallback((objectIndex,visible)=>{
    const entry=objectsRef.current.get(Number(objectIndex));
    if(!entry)return false;
    eachEntryHandle(entry,(batch,instanceId)=>batch.setVisibleAt(instanceId,!!visible));
    requestRender();
    return true;
  },[requestRender]);

  const isolate=useCallback(objectIndex=>{
    const target=Number(objectIndex);
    for(const [index,entry] of objectsRef.current){
      const visible=index===target;
      eachEntryHandle(entry,(batch,instanceId)=>batch.setVisibleAt(instanceId,visible));
    }
    requestRender();
  },[requestRender]);

  const isolateMany=useCallback(objectIndices=>{
    const wanted=new Set((objectIndices||[]).map(Number).filter(Number.isFinite));
    if(!wanted.size)return false;
    for(const [index,entry] of objectsRef.current){
      const visible=wanted.has(index);
      eachEntryHandle(entry,(batch,instanceId)=>batch.setVisibleAt(instanceId,visible));
    }
    requestRender();
    return true;
  },[requestRender]);

  const fitObjects=useCallback(objectIndices=>{
    const root=rootRef.current;
    const box=new THREE.Box3().makeEmpty();
    let found=0;
    for(const rawIndex of objectIndices||[]){
      const entry=objectsRef.current.get(Number(rawIndex));
      const entryBounds=boxFromEntry(entry);
      if(!entryBounds)continue;
      if(root)entryBounds.applyMatrix4(root.matrixWorld);
      if(!saneWorldBox(entryBounds))continue;
      box.union(entryBounds);found++;
    }
    if(!found||!saneWorldBox(box))return false;
    fitBox(box);
    return true;
  },[fitBox]);

  const restoreVisibility=useCallback(()=>{
    for(const entry of objectsRef.current.values()){
      eachEntryHandle(entry,(batch,instanceId)=>batch.setVisibleAt(instanceId,true));
    }
    requestRender();
  },[requestRender]);

  const setObjectColor=useCallback((objectIndex,color,render=true)=>{
    const entry=objectsRef.current.get(Number(objectIndex));
    if(!entry)return false;
    entry.color=String(color||'#9fa3a7');
    if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,entry.color);
    if(render)requestRender();
    return true;
  },[applyEntryColor,requestRender]);

  const setObjectBaseColor=useCallback((objectIndex,color,render=false)=>{
    const entry=objectsRef.current.get(Number(objectIndex));
    if(!entry)return false;
    const previousBase=String(entry.baseColor||'#9fa3a7');
    const wasUsingBase=!entry.color||String(entry.color)===previousBase;
    const next=String(color||'#9fa3a7');
    entry.baseColor=next;
    if(wasUsingBase){
      entry.color=next;
      if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,next);
    }
    if(render)requestRender();
    return true;
  },[applyEntryColor,requestRender]);

  const restoreObjectColor=useCallback((objectIndex,render=false)=>{
    const entry=objectsRef.current.get(Number(objectIndex));
    if(!entry)return false;
    entry.color=entry.baseColor||'#9fa3a7';
    if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,entry.color);
    if(render)requestRender();
    return true;
  },[applyEntryColor,requestRender]);

  const clearColors=useCallback((render=true)=>{
    for(const entry of objectsRef.current.values()){
      entry.color=entry.baseColor||'#9fa3a7';
      if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,entry.color);
    }
    if(render)requestRender();
  },[applyEntryColor,requestRender]);

  const applyBaseColorMap=useCallback((colorMap,{restore=true,render=true}={})=>{
    if(!colorMap?.size)return 0;
    let applied=0;
    for(const entry of objectsRef.current.values()){
      const next=colorMap.get(Number(entry.objectIndex));
      if(!next)continue;
      entry.baseColor=String(next);
      if(restore){
        entry.color=String(next);
        if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,entry.color);
      }
      applied++;
    }
    if(render&&applied)requestRender();
    return applied;
  },[applyEntryColor,requestRender]);

  const applyColorGroups=useCallback(groups=>{
    clearColors(false);
    for(const group of groups||[]){
      const color=colorValue(group.color);
      for(const objectIndex of group.objectIndices||[]){
        const entry=objectsRef.current.get(Number(objectIndex));
        if(!entry)continue;
        entry.color=String(group.color||'#9fa3a7');
        if(selectedRef.current!==entry.objectIndex)applyEntryColor(entry,color);
      }
    }
    requestRender();
  },[applyEntryColor,clearColors,requestRender]);

  const clearSpatialProxy=useCallback(()=>{
    const proxy=spatialProxyRef.current;
    const root=rootRef.current;
    if(proxy.mesh){
      root?.remove(proxy.mesh);
      proxy.mesh.geometry?.dispose?.();
      proxy.mesh.material?.dispose?.();
    }
    spatialProxyRef.current={mesh:null,records:new Map()};
    requestRender();
  },[requestRender]);

  const setSpatialProxyBounds=useCallback(descriptors=>{
    const root=rootRef.current;
    if(!root)return {count:0,bounds:null};

    const previous=spatialProxyRef.current;
    if(previous.mesh){
      root.remove(previous.mesh);
      previous.mesh.geometry?.dispose?.();
      previous.mesh.material?.dispose?.();
    }

    const valid=[];
    const globalBox=new THREE.Box3().makeEmpty();
    for(const descriptor of descriptors||[]){
      const bounds=descriptor?.bounds;
      if(!Array.isArray(bounds)||bounds.length!==6)continue;
      const box=new THREE.Box3(
        new THREE.Vector3(Number(bounds[0]),Number(bounds[1]),Number(bounds[2])),
        new THREE.Vector3(Number(bounds[3]),Number(bounds[4]),Number(bounds[5]))
      );
      if(!saneWorldBox(box))continue;
      valid.push({descriptor,box});
      globalBox.union(box);
    }

    if(!valid.length){
      spatialProxyRef.current={mesh:null,records:new Map()};
      return {count:0,bounds:null};
    }

    const geometry=new THREE.BoxGeometry(1,1,1);
    const material=new THREE.MeshBasicMaterial({
      color:0x8794a0,
      transparent:true,
      opacity:.10,
      depthWrite:false,
      depthTest:true,
      wireframe:true
    });
    const mesh=new THREE.InstancedMesh(geometry,material,valid.length);
    mesh.name='PHD_SPATIAL_LOD0_PROXY';
    mesh.frustumCulled=false;
    mesh.renderOrder=-10;
    // O proxy espacial é índice de streaming, não representação visual.
    mesh.visible=false;

    const records=new Map();
    const quaternion=new THREE.Quaternion();
    const center=new THREE.Vector3();
    const size=new THREE.Vector3();
    const matrix=new THREE.Matrix4();

    valid.forEach((item,index)=>{
      item.box.getCenter(center);
      item.box.getSize(size);
      matrix.compose(center,quaternion,size);
      mesh.setMatrixAt(index,matrix);
      records.set('detail:'+String(item.descriptor?.chunkIndex),{
        instanceId:index,
        matrix:matrix.clone(),
        visible:true
      });
    });

    mesh.instanceMatrix.needsUpdate=true;
    mesh.computeBoundingBox();
    mesh.computeBoundingSphere();
    root.add(mesh);
    spatialProxyRef.current={mesh,records};

    if(saneWorldBox(globalBox)){
      const localBox=globalBox.clone();
      if(root)localBox.applyMatrix4(root.matrixWorld);
      if(saneWorldBox(localBox))modelBoundsRef.current.copy(localBox);
    }
    requestRender();

    return {
      count:valid.length,
      bounds:saneWorldBox(globalBox)?[
        globalBox.min.x,globalBox.min.y,globalBox.min.z,
        globalBox.max.x,globalBox.max.y,globalBox.max.z
      ]:null
    };
  },[requestRender]);

  const setSpatialProxyVisible=useCallback((chunkKey,visible)=>{
    const proxy=spatialProxyRef.current;
    const record=proxy.records.get(String(chunkKey));
    if(!proxy.mesh||!record||record.visible===!!visible)return false;
    record.visible=!!visible;
    proxy.mesh.setMatrixAt(
      record.instanceId,
      visible?record.matrix:new THREE.Matrix4().makeScale(0,0,0)
    );
    proxy.mesh.instanceMatrix.needsUpdate=true;
    requestRender();
    return true;
  },[requestRender]);

  const clearModel=useCallback(()=>{
    clearSelection(false);
    const root=rootRef.current;
    if(root){
      for(const batch of batchesRef.current){
        root.remove(batch);
        batch.dispose?.();
        const materials=new Set([
          batch.material,
          batch.userData?.qualityMaterial,
          batch.userData?.fastMaterial
        ].filter(Boolean));
        for(const material of materials)material.dispose?.();
      }
      root.position.set(0,0,0);
      root.visible=true;
    }
    batchesRef.current.clear();
    chunksRef.current.clear();
    clearSpatialProxy();
    objectsRef.current.clear();
    modelBoundsRef.current.makeEmpty();
    worldOriginRef.current.set(0,0,0);
    modelVisibleRef.current=true;
    statsRef.current={objects:0,instances:0,batches:0,invalid:0};
    setState(current=>({...current,objectCount:0,meshCount:0,batchCount:0,error:''}));
    requestRender();
  },[clearSelection,clearSpatialProxy,requestRender]);

  const appendObjects=useCallback((objects,{fit=false,chunkKey=null}={})=>{
    const root=rootRef.current;
    if(!root)throw new Error('PHD Native Batched Viewer ainda não foi inicializado.');

    const geometryCache=new Map();
    const instances=[];
    const appendBounds=new THREE.Box3().makeEmpty();
    let invalid=0;

    for(const object of objects||[]){
      const objectIndex=Number(object.objectIndex);
      if(!Number.isFinite(objectIndex)||objectsRef.current.has(objectIndex))continue;

      for(const row of object.rows||[]){
        const geometryIndex=Number(row.geometryIndex);
        if(!Number.isFinite(geometryIndex))continue;

        let geometry=geometryCache.get(geometryIndex);
        if(!geometry){
          geometry=createPreparedGeometry(row);
          if(!geometry||!finiteBox(geometry.boundingBox)){
            invalid++;
            continue;
          }
          geometryCache.set(geometryIndex,geometry);
        }

        const hasTransform=row.transform!==null&&row.transform!==undefined&&String(row.transform).length>0;
        const matrix=hasTransform?matrixFromBundleTransform(row.transform):IDENTITY.clone();
        if(hasTransform&&!matrix){invalid++;continue}
        const box=geometry.boundingBox.clone().applyMatrix4(matrix||IDENTITY);
        if(!saneWorldBox(box)){invalid++;continue}
        appendBounds.union(box);

        instances.push({
          objectIndex,
          applicationId:String(object.applicationId||objectIndex),
          displayColor:String(object.displayColor||row.displayColor||''),
          geometryIndex,
          geometry,
          matrix,
          box
        });
      }
    }

    if(!instances.length){
      statsRef.current.invalid+=invalid;
      return {...statsRef.current};
    }

    let totalVertices=0,totalIndices=0;
    for(const geometry of geometryCache.values()){
      totalVertices+=geometry.getAttribute('position')?.count||0;
      totalIndices+=geometry.getIndex()?.count||0;
    }

    const clippingPlanes=sectionEnabledRef.current?[sectionPlaneRef.current]:null;
    const qualityMaterial=createQualityMaterial(clippingPlanes);
    const fastMaterial=createFastMaterial(clippingPlanes);
    configureBatchMaterial(qualityMaterial,renderModeRef.current,globalOpacityRef.current);
    configureBatchMaterial(fastMaterial,renderModeRef.current,globalOpacityRef.current);

    const batch=new THREE.BatchedMesh(
      instances.length,
      Math.max(1,totalVertices),
      Math.max(1,totalIndices),
      qualityMaterial
    );
    batch.name='PHD_BATCH_'+String(batchesRef.current.size+1);
    batch.userData.phdChunkKey=chunkKey?String(chunkKey):null;
    batch.userData.qualityMaterial=qualityMaterial;
    batch.userData.fastMaterial=fastMaterial;
    batch.userData.navigationFast=false;
    // Os chunks já são espacialmente pequenos/priorizados. Evita o custo CPU
    // de testar centenas de instâncias por frame dentro de cada BatchedMesh.
    batch.perObjectFrustumCulled=false;
    batch.sortObjects=false;
    batch.userData.instanceToObjectIndex=[];

    const geometryIds=new Map();
    for(const [geometryIndex,geometry] of geometryCache){
      geometryIds.set(geometryIndex,batch.addGeometry(geometry));
    }

    for(const item of instances){
      const geometryId=geometryIds.get(item.geometryIndex);
      const instanceId=batch.addInstance(geometryId);
      batch.setMatrixAt(instanceId,item.matrix);
      const nativeColor=item.displayColor?colorValue(item.displayColor):BASE_COLOR;
      batch.setColorAt(instanceId,nativeColor);
      batch.userData.instanceToObjectIndex[instanceId]=item.objectIndex;

      let entry=objectsRef.current.get(item.objectIndex);
      if(!entry){
        entry={
          objectIndex:item.objectIndex,
          applicationId:item.applicationId===String(item.objectIndex)?null:item.applicationId,
          batch:null,
          instanceId:null,
          extraHandles:null,
          bounds:null,
          baseColor:item.displayColor||'#9fa3a7',
          color:item.displayColor||'#9fa3a7',
          chunkKey:chunkKey?String(chunkKey):null
        };
        objectsRef.current.set(item.objectIndex,entry);
      }
      addEntryHandle(entry,batch,instanceId);
      unionEntryBounds(entry,item.box);
    }

    batch.computeBoundingBox();
    batch.computeBoundingSphere();
    root.add(batch);
    batchesRef.current.add(batch);

    if(chunkKey){
      const key=String(chunkKey);
      let record=chunksRef.current.get(key);
      if(!record){
        record={batches:new Set(),objectIndices:new Set(),instances:0};
        chunksRef.current.set(key,record);
      }
      record.batches.add(batch);
      record.instances+=instances.length;
      for(const item of instances)record.objectIndices.add(item.objectIndex);
    }

    for(const geometry of geometryCache.values())geometry.dispose();

    statsRef.current.objects=objectsRef.current.size;
    statsRef.current.instances+=instances.length;
    statsRef.current.batches=batchesRef.current.size;
    statsRef.current.invalid+=invalid;

    const renderer=rendererRef.current;
    const host=hostRef.current;
    if(renderer&&host){
      const targetRatio=statsRef.current.objects>60000
        ? 1
        : Math.min(window.devicePixelRatio||1,1.25);
      if(Math.abs(renderer.getPixelRatio()-targetRatio)>.01){
        renderer.setPixelRatio(targetRatio);
        renderer.setSize(Math.max(1,host.clientWidth),Math.max(1,host.clientHeight),false);
      }
    }

    if(finiteBox(appendBounds)){
      const localAppendBounds=appendBounds.clone();
      if(root)localAppendBounds.applyMatrix4(root.matrixWorld);
      if(!finiteBox(modelBoundsRef.current)||modelBoundsRef.current.isEmpty())modelBoundsRef.current.copy(localAppendBounds);
      else modelBoundsRef.current.union(localAppendBounds);
    }
    const bounds=modelBoundsRef.current;

    setState(current=>({
      ...current,
      objectCount:statsRef.current.objects,
      meshCount:statsRef.current.instances,
      batchCount:statsRef.current.batches,
      error:statsRef.current.invalid?statsRef.current.invalid+' geometria(s) inválida(s) ignoradas.':''
    }));

    if(fit&&finiteBox(bounds))fitBox(bounds);
    requestRender();
    return {...statsRef.current};
  },[fitBox,requestRender]);

  const loadObjects=useCallback((objects,options={})=>{
    clearModel();
    return appendObjects(objects,{fit:options.fit!==false,chunkKey:options.chunkKey||null});
  },[appendObjects,clearModel]);

  const removeChunk=useCallback(chunkKey=>{
    const key=String(chunkKey);
    const record=chunksRef.current.get(key);
    if(!record)return false;

    if(selectedRef.current!==null&&record.objectIndices.has(selectedRef.current))clearSelection(false);

    const root=rootRef.current;
    for(const batch of record.batches){
      root?.remove(batch);
      batchesRef.current.delete(batch);
      batch.dispose?.();
      const materials=new Set([
        batch.material,
        batch.userData?.qualityMaterial,
        batch.userData?.fastMaterial
      ].filter(Boolean));
      for(const material of materials)material.dispose?.();
    }

    for(const objectIndex of record.objectIndices){
      const entry=objectsRef.current.get(objectIndex);
      if(entry?.chunkKey===key)objectsRef.current.delete(objectIndex);
    }

    chunksRef.current.delete(key);
    statsRef.current.objects=objectsRef.current.size;
    statsRef.current.instances=Math.max(0,statsRef.current.instances-record.instances);
    statsRef.current.batches=batchesRef.current.size;

    setState(current=>({
      ...current,
      objectCount:statsRef.current.objects,
      meshCount:statsRef.current.instances,
      batchCount:statsRef.current.batches
    }));
    requestRender();
    return true;
  },[clearSelection,requestRender]);

  const fitBounds=useCallback(bounds=>{
    if(!Array.isArray(bounds)||bounds.length!==6)return false;
    const box=new THREE.Box3(
      new THREE.Vector3(Number(bounds[0]),Number(bounds[1]),Number(bounds[2])),
      new THREE.Vector3(Number(bounds[3]),Number(bounds[4]),Number(bounds[5]))
    );
    if(!saneWorldBox(box))return false;
    const root=rootRef.current;
    if(root)box.applyMatrix4(root.matrixWorld);
    if(!saneWorldBox(box))return false;
    modelBoundsRef.current.copy(box);
    fitBox(box);
    return true;
  },[fitBox]);

  const getSpatialLoadBudget=useCallback((descriptors,{overview=56,medium=40,detail=24}={})=>{
    const camera=activeCameraRef.current;
    const modelBox=modelBoundsRef.current;
    if(!camera||!saneWorldBox(modelBox))return medium;

    const center=modelBox.getCenter(new THREE.Vector3());
    const diagonal=Math.max(modelBox.getSize(new THREE.Vector3()).length(),1);

    if(camera.isPerspectiveCamera){
      const distance=Math.max(1,camera.getWorldPosition(new THREE.Vector3()).distanceTo(center));
      const ratio=distance/diagonal;
      if(ratio>1.25)return overview;
      if(ratio>.58)return medium;
      return detail;
    }

    if(camera.isOrthographicCamera){
      const visibleHeight=Math.abs(camera.top-camera.bottom)/Math.max(camera.zoom||1,1e-6);
      const ratio=visibleHeight/diagonal;
      if(ratio>.75)return overview;
      if(ratio>.32)return medium;
      return detail;
    }

    return medium;
  },[]);

  const rankSpatialChunks=useCallback((descriptors,{max=24}={})=>{
    const camera=activeCameraRef.current;
    if(!camera)return [];
    camera.updateMatrixWorld(true);

    const projectionView=new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse);
    const frustum=new THREE.Frustum().setFromProjectionMatrix(projectionView);
    const cameraPosition=camera.getWorldPosition(new THREE.Vector3());
    const modelDiagonal=saneWorldBox(modelBoundsRef.current)
      ? Math.max(modelBoundsRef.current.getSize(new THREE.Vector3()).length(),1)
      : 1;
    const tanHalfFov=camera.isPerspectiveCamera
      ? Math.max(Math.tan(THREE.MathUtils.degToRad(camera.fov*.5)),1e-6)
      : 1;
    const orthoHeight=camera.isOrthographicCamera
      ? Math.max(Math.abs(camera.top-camera.bottom)/Math.max(camera.zoom||1,1e-6),1e-6)
      : 1;

    return (descriptors||[]).map(descriptor=>{
      const bounds=descriptor?.bounds;
      if(!Array.isArray(bounds)||bounds.length!==6)return null;

      const box=new THREE.Box3(
        new THREE.Vector3(Number(bounds[0]),Number(bounds[1]),Number(bounds[2])),
        new THREE.Vector3(Number(bounds[3]),Number(bounds[4]),Number(bounds[5]))
      );
      const root=rootRef.current;
      if(root)box.applyMatrix4(root.matrixWorld);
      if(!saneWorldBox(box))return null;

      const visible=frustum.intersectsBox(box);
      const center=box.getCenter(new THREE.Vector3());
      const size=box.getSize(new THREE.Vector3());
      const diagonal=Math.max(size.length(),.001);
      const maxDimension=Math.max(size.x,size.y,size.z,.001);
      const minDimension=Math.max(Math.min(size.x,size.y,size.z),.000001);
      const flatness=minDimension/maxDimension;
      const distance=Math.max(1,center.distanceTo(cameraPosition));

      const screenFraction=camera.isPerspectiveCamera
        ? Math.min(4,diagonal/(distance*tanHalfFov*2))
        : Math.min(4,diagonal/orthoHeight);

      const objectCount=Math.max(1,Number(descriptor?.objectCount||1));
      const densityWeight=1+Math.log2(objectCount+1)/5;
      const giantFlatTerrain=maxDimension>modelDiagonal*.18&&flatness<.035&&objectCount<96;
      const terrainPenalty=giantFlatTerrain?.22:1;
      const oversizedPenalty=maxDimension>modelDiagonal*.42?.45:1;
      const visibleBoost=visible?1000:0;
      const importance=(screenFraction*220*densityWeight*terrainPenalty*oversizedPenalty);
      const proximity=Math.max(0,40-(distance/modelDiagonal)*12);

      return {descriptor,visible,score:visibleBoost+importance+proximity,distance};
    }).filter(Boolean).sort((a,b)=>{
      if(a.visible!==b.visible)return a.visible?-1:1;
      if(Math.abs(a.score-b.score)>.0001)return b.score-a.score;
      return a.distance-b.distance;
    }).slice(0,Math.max(1,Number(max)||24)).map(item=>item.descriptor);
  },[]);

  const finalizeModel=useCallback(()=>{
    const root=rootRef.current;
    if(!root||!objectsRef.current.size)throw new Error('Nenhum objeto foi carregado no PHD Native Batched Viewer.');
    root.updateMatrixWorld(true);
    let bounds=new THREE.Box3().setFromObject(root);
    if(!finiteBox(bounds))throw new Error('BoundingBox final inválido no PHD Native Batched Viewer.');

    const center=bounds.getCenter(new THREE.Vector3());
    root.position.sub(center);
    root.updateMatrixWorld(true);
    bounds=new THREE.Box3().setFromObject(root);
    modelBoundsRef.current.copy(bounds);
    fitBox(bounds);
    requestRender();
    return {...statsRef.current,bounds:{min:bounds.min.toArray(),max:bounds.max.toArray()}};
  },[fitBox,requestRender]);

  const setView=useCallback(view=>{
    const directions={
      '3d':new THREE.Vector3(1,-1,.75),
      top:new THREE.Vector3(0,0,1),
      front:new THREE.Vector3(0,-1,0),
      back:new THREE.Vector3(0,1,0),
      right:new THREE.Vector3(1,0,0),
      left:new THREE.Vector3(-1,0,0)
    };
    fitBox(modelBoundsRef.current,directions[view]||directions['3d']);
  },[fitBox]);

  const toggleProjection=useCallback(()=>{
    const next=projectionRef.current==='perspective'?'orthographic':'perspective';
    projectionRef.current=next;
    activeCameraRef.current=next==='perspective'?perspectiveRef.current:orthoRef.current;
    if(controlsRef.current)controlsRef.current.object=activeCameraRef.current;
    setState(current=>({...current,projection:next}));
    fitBox(modelBoundsRef.current);
    return next;
  },[fitBox]);

  const setInteraction=useCallback(mode=>{
    const controls=controlsRef.current;
    if(!controls)return false;
    const next=['orbit','pan','pick'].includes(mode)?mode:'orbit';
    interactionRef.current=next;
    controls.mouseButtons={
      LEFT:next==='pan'?THREE.MOUSE.PAN:THREE.MOUSE.ROTATE,
      MIDDLE:THREE.MOUSE.DOLLY,
      RIGHT:THREE.MOUSE.PAN
    };
    const canvas=rendererRef.current?.domElement;
    if(canvas)canvas.style.cursor=next==='pick'?'crosshair':next==='pan'?'grab':'grab';
    return true;
  },[]);

  const toggleSection=useCallback(()=>{
    const renderer=rendererRef.current;
    if(!renderer)return false;
    const next=!sectionEnabledRef.current;
    sectionEnabledRef.current=next;
    const bounds=modelBoundsRef.current;
    if(next&&saneWorldBox(bounds)){
      const center=bounds.getCenter(new THREE.Vector3());
      sectionPlaneRef.current.set(new THREE.Vector3(0,0,-1),center.z);
    }
    renderer.localClippingEnabled=next;
    for(const batch of batchesRef.current){
      for(const material of [
        batch.userData?.qualityMaterial,
        batch.userData?.fastMaterial,
        batch.material
      ]){
        if(!material)continue;
        material.clippingPlanes=next?[sectionPlaneRef.current]:null;
        material.needsUpdate=true;
      }
    }
    requestRender();
    return next;
  },[requestRender]);

  useEffect(()=>{
    const host=hostRef.current;
    if(!host)return;
    let disposed=false,frame=0,resizeFrame=0,resizeObserver=null,qualityTimer=0;
    let environmentTexture=null,pmremGenerator=null,composer=null,renderPass=null,ssaoPass=null;
    let onPointerDown=null,onPointerUp=null,onDoubleClick=null,onContextMenu=null,onControlStart=null,onControlEnd=null;

    try{
      const scene=new THREE.Scene();
      sceneRef.current=scene;
      const root=new THREE.Group();
      root.name='PHD_NATIVE_BATCHED_MODEL';
      rootRef.current=root;
      scene.add(root);

      // HyperView Studio Lighting: luz ambiente baixa para não achatar
      // volumes, hemisférica neutra e três fontes direcionais suaves. O PBR
      // de repouso ganha leitura de tubulações/estruturas sem shadow maps.
      scene.add(new THREE.AmbientLight(0xffffff,.075));
      scene.add(new THREE.HemisphereLight(0xf5f7f9,0x565b61,.38));
      const keyLight=new THREE.DirectionalLight(0xffffff,1.02);
      keyLight.position.set(22,-26,34);scene.add(keyLight);
      const fillLight=new THREE.DirectionalLight(0xe3edf5,.24);
      fillLight.position.set(-18,10,14);scene.add(fillLight);
      const rimLight=new THREE.DirectionalLight(0xfff4e8,.18);
      rimLight.position.set(8,24,20);scene.add(rimLight);

      const width=Math.max(1,host.clientWidth),height=Math.max(1,host.clientHeight);
      const aspect=width/height;
      const perspective=new THREE.PerspectiveCamera(42,aspect,.01,1000000);
      perspective.up.set(0,0,1);
      perspective.position.set(10,-10,8);perspectiveRef.current=perspective;
      const ortho=new THREE.OrthographicCamera(-10*aspect,10*aspect,10,-10,.01,1000000);
      ortho.up.set(0,0,1);
      ortho.position.set(10,-10,8);orthoRef.current=ortho;
      activeCameraRef.current=perspective;

      const renderer=new THREE.WebGLRenderer({
        antialias:true,
        alpha:true,
        powerPreference:'high-performance',
        depth:true,
        stencil:false
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio||1,1.25));
      renderer.setSize(width,height,false);
      renderer.outputColorSpace=THREE.SRGBColorSpace;
      // NeutralToneMapping preserva as cores CAD melhor que ACES, mas cria
      // headroom de iluminação suficiente para o material PBR parecer metálico.
      renderer.toneMapping=THREE.NeutralToneMapping;
      renderer.toneMappingExposure=.92;
      renderer.shadowMap.enabled=false;
      renderer.localClippingEnabled=false;

      // IBL gerado localmente: sem HDR externo, sem requisição adicional.
      // É aplicado somente ao MeshStandardMaterial do modo de alta qualidade.
      pmremGenerator=new THREE.PMREMGenerator(renderer);
      pmremGenerator.compileEquirectangularShader();
      const roomEnvironment=new RoomEnvironment();
      environmentTexture=pmremGenerator.fromScene(roomEnvironment,.035).texture;
      roomEnvironment.dispose?.();
      scene.environment=environmentTexture;

      renderer.domElement.className='phd-native-canvas';
      renderer.domElement.setAttribute('data-renderer','PHD-HYPERVIEW-PREMIUM');
      host.appendChild(renderer.domElement);rendererRef.current=renderer;

      // AO técnico adaptativo: não participa do FastNav. Só entra quando a
      // câmera repousa, adicionando contato entre vigas, tubos e equipamentos.
      composer=new EffectComposer(renderer);
      renderPass=new RenderPass(scene,activeCameraRef.current);
      ssaoPass=new SSAOPass(scene,activeCameraRef.current,width,height,16);
      ssaoPass.kernelRadius=1.25;
      ssaoPass.minDistance=.0015;
      ssaoPass.maxDistance=.04;
      composer.addPass(renderPass);
      composer.addPass(ssaoPass);
      composerRef.current=composer;
      renderPassRef.current=renderPass;
      ssaoPassRef.current=ssaoPass;

      const controls=new OrbitControls(activeCameraRef.current,renderer.domElement);
      controls.enableDamping=true;
      controls.dampingFactor=.10;
      controls.screenSpacePanning=true;
      controls.zoomToCursor=true;
      controls.rotateSpeed=.42;
      controls.zoomSpeed=1.08;
      controls.panSpeed=.78;
      controls.enableRotate=true;
      controls.enablePan=true;
      controls.enableZoom=true;
      controls.minAzimuthAngle=-Infinity;
      controls.maxAzimuthAngle=Infinity;
      controls.minPolarAngle=.01;
      controls.maxPolarAngle=Math.PI-.01;
      controls.mouseButtons={
        LEFT:THREE.MOUSE.ROTATE,
        MIDDLE:THREE.MOUSE.PAN,
        RIGHT:THREE.MOUSE.PAN
      };
      controls.touches={
        ONE:THREE.TOUCH.ROTATE,
        TWO:THREE.TOUCH.DOLLY_PAN
      };
      controlsRef.current=controls;

      const restorePixelRatio=()=>{
        const target=Math.min(window.devicePixelRatio||1,1.35);
        if(Math.abs(renderer.getPixelRatio()-target)>.01){
          renderer.setPixelRatio(target);
          renderer.setSize(Math.max(1,host.clientWidth),Math.max(1,host.clientHeight),false);
          composer.setPixelRatio(target);
          composer.setSize(Math.max(1,host.clientWidth),Math.max(1,host.clientHeight));
        }
      };
      onControlStart=()=>{
        window.clearTimeout(qualityTimer);
        // FastNav: durante órbita/pan troca somente o shader PBR por Lambert
        // e reduz resolução. A geometria/cores permanecem iguais.
        for(const batch of batchesRef.current){
          const fast=batch.userData?.fastMaterial;
          if(!fast)continue;
          batch.userData.navigationFast=true;
          batch.material=fast;
        }
        const target=Math.min(.78,window.devicePixelRatio||1);
        if(Math.abs(renderer.getPixelRatio()-target)>.01){
          renderer.setPixelRatio(target);
          renderer.setSize(Math.max(1,host.clientWidth),Math.max(1,host.clientHeight),false);
        }
      };
      onControlEnd=()=>{
        window.clearTimeout(qualityTimer);
        qualityTimer=window.setTimeout(()=>{
          if(disposed)return;
          for(const batch of batchesRef.current){
            const quality=batch.userData?.qualityMaterial;
            if(!quality)continue;
            batch.userData.navigationFast=false;
            batch.material=quality;
          }
          restorePixelRatio();
          renderPremium();
        },120);
      };
      controls.addEventListener('start',onControlStart);
      controls.addEventListener('end',onControlEnd);

      const raycaster=new THREE.Raycaster();
      const pointer=new THREE.Vector2();
      let down=null;

      const pickAt=(clientX,clientY)=>{
        const rect=renderer.domElement.getBoundingClientRect();
        pointer.x=((clientX-rect.left)/rect.width)*2-1;
        pointer.y=-((clientY-rect.top)/rect.height)*2+1;
        raycaster.setFromCamera(pointer,activeCameraRef.current);
        const hits=raycaster.intersectObjects([...batchesRef.current],false);
        return hits.find(item=>Number.isFinite(Number(item.batchId)))||hits[0]||null;
      };

      onPointerDown=e=>{
        const canPick=e.button===0&&interactionRef.current!=='pan';
        // Nunca faz raycast no pointerdown. Órbita começa instantaneamente;
        // o raycast só acontece no pointerup quando foi realmente um clique.
        down={x:e.clientX,y:e.clientY,button:e.button,canPick};
      };

      onPointerUp=e=>{
        if(!down)return;
        const start=down;
        down=null;
        const moved=Math.hypot(e.clientX-start.x,e.clientY-start.y);
        if(moved>5||start.button!==0||!start.canPick)return;
        const hit=pickAt(e.clientX,e.clientY);
        if(hit){
          const objectIndex=Number(hit.object?.userData?.instanceToObjectIndex?.[hit.batchId]);
          if(Number.isFinite(objectIndex))selectObject(objectIndex,{notify:true,focus:false});
        }else clearSelection(true);
      };

      onDoubleClick=e=>{
        e.preventDefault();
        const hit=pickAt(e.clientX,e.clientY);
        if(!hit)return;
        const objectIndex=Number(hit.object?.userData?.instanceToObjectIndex?.[hit.batchId]);
        if(Number.isFinite(objectIndex)){
          selectObject(objectIndex,{notify:true,focus:true});
          return;
        }
        if(hit.point){
          const camera=activeCameraRef.current;
          const direction=camera.position.clone().sub(hit.point);
          const distance=Math.max(direction.length()*.45,.1);
          direction.normalize();
          controls.target.copy(hit.point);
          camera.position.copy(hit.point).add(direction.multiplyScalar(distance));
          controls.update();
          renderer.render(scene,camera);
        }
      };

      onContextMenu=e=>e.preventDefault();
      renderer.domElement.style.cursor='grab';
      renderer.domElement.addEventListener('pointerdown',onPointerDown);
      renderer.domElement.addEventListener('pointerup',onPointerUp);
      renderer.domElement.addEventListener('dblclick',onDoubleClick);
      renderer.domElement.addEventListener('contextmenu',onContextMenu);

      const resize=()=>{
        if(disposed)return;
        cancelAnimationFrame(resizeFrame);
        resizeFrame=requestAnimationFrame(()=>{
          if(disposed)return;
          const w=Math.max(1,host.clientWidth),h=Math.max(1,host.clientHeight),a=w/h;
          perspective.aspect=a;perspective.updateProjectionMatrix();
          renderer.setSize(w,h,false);
          composer.setSize(w,h);
          if(!document.hidden)renderer.render(scene,activeCameraRef.current);
        });
      };
      resizeObserver=new ResizeObserver(resize);resizeObserver.observe(host);

      let firstFrame=true;
      const animate=()=>{
        if(disposed)return;
        if(!document.hidden){
          const changed=controls.update();
          if(changed||firstFrame){
            renderer.render(scene,activeCameraRef.current);
            firstFrame=false;
          }
        }
        frame=requestAnimationFrame(animate);
      };
      animate();
      setState(current=>({...current,status:'ready',ready:true,error:''}));
    }catch(error){
      setState(current=>({...current,status:'error',ready:false,error:error?.message||'Falha ao iniciar PHD Native Batched Viewer.'}));
    }

    return()=>{
      disposed=true;
      cancelAnimationFrame(frame);
      cancelAnimationFrame(resizeFrame);
      resizeObserver?.disconnect();
      window.clearTimeout(qualityTimer);
      if(controlsRef.current&&onControlStart)controlsRef.current.removeEventListener('start',onControlStart);
      if(controlsRef.current&&onControlEnd)controlsRef.current.removeEventListener('end',onControlEnd);
      controlsRef.current?.dispose();
      const renderer=rendererRef.current;
      if(renderer?.domElement&&onPointerDown)renderer.domElement.removeEventListener('pointerdown',onPointerDown);
      if(renderer?.domElement&&onPointerUp)renderer.domElement.removeEventListener('pointerup',onPointerUp);
      if(renderer?.domElement&&onDoubleClick)renderer.domElement.removeEventListener('dblclick',onDoubleClick);
      if(renderer?.domElement&&onContextMenu)renderer.domElement.removeEventListener('contextmenu',onContextMenu);
      clearModel();
      ssaoPass?.dispose?.();
      composer?.dispose?.();
      environmentTexture?.dispose?.();
      pmremGenerator?.dispose?.();
      scene.environment=null;
      if(renderer){renderer.domElement?.remove();renderer.dispose()}
      composerRef.current=null;renderPassRef.current=null;ssaoPassRef.current=null;
      rendererRef.current=null;sceneRef.current=null;rootRef.current=null;
      perspectiveRef.current=null;orthoRef.current=null;activeCameraRef.current=null;controlsRef.current=null;
    };
  },[hostRef,clearModel,clearSelection,selectObject,renderPremium]);

  const captureScreenshot=useCallback((filename='PHD360-modelo.png')=>{
    const renderer=rendererRef.current;
    const scene=sceneRef.current;
    const camera=activeCameraRef.current;
    if(!renderer||!scene||!camera)return false;
    try{
      renderPremium();
      const url=renderer.domElement.toDataURL('image/png');
      const link=document.createElement('a');
      link.href=url;
      link.download=filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      return true;
    }catch{
      return false;
    }
  },[renderPremium]);

  return {
    ...state,
    loadObjects,appendObjects,removeChunk,rankSpatialChunks,fitBounds,finalizeModel,clearModel,
    setWorldOrigin,setSpatialProxyBounds,setSpatialProxyVisible,clearSpatialProxy,
    setRenderMode,setGlobalOpacity,setModelVisible,
    getSpatialLoadBudget,captureScreenshot,
    selectObject,clearSelection,fit,setView,toggleProjection,setInteraction,toggleSection,
    isolate,isolateMany,fitObjects,hide:index=>setVisible(index,false),show:index=>setVisible(index,true),
    restoreVisibility,setObjectColor,setObjectBaseColor,restoreObjectColor,applyBaseColorMap,clearColors,applyColorGroups,render:requestRender,renderPremium,
    hasObject:index=>objectsRef.current.has(Number(index)),
    hasChunk:key=>chunksRef.current.has(String(key)),
    getObjectChunkKey:index=>objectsRef.current.get(Number(index))?.chunkKey||null,
    getObjectBounds:index=>objectsRef.current.get(Number(index))?.bounds||null,
    getRenderMode:()=>renderModeRef.current
  };
}
