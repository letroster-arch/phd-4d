import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { base44 } from '@/api/base44Client';

export const FOUR_D_PHASES=[
  {key:'not_started',label:'Não iniciado',color:'#8b929a'},
  {key:'planned',label:'Planejado',color:'#3b82f6'},
  {key:'in_progress',label:'Em execução',color:'#f59e0b'},
  {key:'completed',label:'Concluído',color:'#22c55e'},
  {key:'late',label:'Atrasado',color:'#ef4444'}
];

const phaseMap=new Map(FOUR_D_PHASES.map(item=>[item.key,item]));
const clean=value=>String(value??'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
const today=()=>new Date().toLocaleDateString('en-CA');

export function activityPhaseAt(activity,date){
  const start=activity?.start_date||'';
  const finish=activity?.finish_date||'';
  const progress=Number(activity?.physical_progress||0);
  const status=clean(activity?.status);
  const current=today();
  const completed=status.includes('concl')||status.includes('complet')||progress>=100;
  const explicitlyLate=status.includes('atras')||status.includes('late')||status.includes('delay');

  if(!start&&!finish)return 'not_started';
  if(start&&date<start)return 'planned';
  if(start&&date>=start&&(!finish||date<=finish)){
    if(date>=current&&completed)return 'completed';
    return 'in_progress';
  }
  if(finish&&date>finish){
    if(date>=current&&!completed&&(explicitlyLate||progress<100))return 'late';
    return 'completed';
  }
  return 'not_started';
}

export function phaseDefinition(key){
  return phaseMap.get(key)||phaseMap.get('not_started');
}

export default function useFourDSimulation(connection,initialDate,enabled=true){
  const projectId=connection?.project_id||'';
  const versionId=connection?.version_id||'';
  const [date,setDate]=useState(initialDate||today());

  const activities=useQuery({
    queryKey:['4d','activities',projectId],
    queryFn:()=>base44.entities.ScheduleActivity.filter({project_id:projectId},'start_date',2500),
    enabled:enabled&&!!projectId,
    retry:false,
    staleTime:30000
  });
  const links=useQuery({
    queryKey:['4d','links',projectId],
    queryFn:()=>base44.entities.Link4D.filter({project_id:projectId},'-created_date',5000),
    enabled:enabled&&!!projectId,
    retry:false,
    staleTime:10000
  });
  const objects=useQuery({
    queryKey:['4d','objects',projectId,versionId],
    queryFn:()=>base44.entities.BimObject.filter(
      versionId?{project_id:projectId,version_id:versionId}:{project_id:projectId},
      '-updated_date',
      5000
    ),
    enabled:enabled&&!!projectId,
    retry:false,
    staleTime:10000
  });

  const result=useMemo(()=>{
    const activityRows=activities.data||[];
    const linkRows=links.data||[];
    const objectRows=objects.data||[];
    const activityById=new Map(activityRows.map(item=>[item.id,item]));
    const objectById=new Map(objectRows.map(item=>[item.id,item]));
    const groups=new Map(FOUR_D_PHASES.map(item=>[item.key,new Set()]));
    const rows=[];
    let linkedWithGeometryIndex=0;

    for(const link of linkRows){
      const activity=activityById.get(link.schedule_activity_id);
      const object=objectById.get(link.bim_object_id);
      if(!activity||!object)continue;
      const objectIndex=Number(object.object_index);
      const phase=activityPhaseAt(activity,date);
      if(Number.isFinite(objectIndex)){
        groups.get(phase)?.add(objectIndex);
        linkedWithGeometryIndex++;
      }
      rows.push({link,activity,object,objectIndex:Number.isFinite(objectIndex)?objectIndex:null,phase});
    }

    const dated=activityRows.filter(item=>item.start_date||item.finish_date);
    const starts=dated.map(item=>item.start_date).filter(Boolean).sort();
    const finishes=dated.map(item=>item.finish_date).filter(Boolean).sort();
    const minDate=starts[0]||finishes[0]||date;
    const maxDate=finishes.at(-1)||starts.at(-1)||date;
    const counts=Object.fromEntries(FOUR_D_PHASES.map(item=>[item.key,rows.filter(row=>row.phase===item.key).length]));
    const groupedObjectIndices=Object.fromEntries([...groups.entries()].map(([key,set])=>[key,[...set]]));

    return {
      activities:activityRows,
      links:linkRows,
      objects:objectRows,
      rows,
      counts,
      groupedObjectIndices,
      linkedWithGeometryIndex,
      minDate,
      maxDate
    };
  },[activities.data,links.data,objects.data,date]);

  const refresh=useCallback(()=>{
    if(!enabled)return Promise.resolve([]);
    return Promise.all([
      activities.refetch(),
      links.refetch(),
      objects.refetch()
    ]);
  },[enabled,activities.refetch,links.refetch,objects.refetch]);

  return {
    ...result,
    date,
    setDate,
    loading:enabled&&(activities.isPending||links.isPending||objects.isPending),
    error:activities.error||links.error||objects.error||null,
    refresh
  };
}
