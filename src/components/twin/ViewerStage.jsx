import { useRef, useState } from 'react';
import { Box, Eye, Home, Layers3, Maximize, Network, Play, SlidersHorizontal, ChevronRight, Compass, Info, Sparkles, CalendarDays } from 'lucide-react';
import { useWorkspace } from '@/components/phd/WorkspaceContext';
import TechnicalButton from '@/components/phd/TechnicalButton';
import ViewerEmpty from '@/components/twin/ViewerEmpty';
import BundleViewerCanvas from '@/components/twin/BundleViewerCanvas';
import BundleFilterToolbar from '@/components/twin/BundleFilterToolbar';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Link } from 'react-router-dom';

export default function ViewerStage({ bridge, onRoot, onSelected, selected, openTree, openProperties, show4DControls=false }) {
  const stage = useRef(null);
  const { connection, setModelState, modelState, project } = useWorkspace();
  const [actionError, setActionError] = useState('');
  const bundleMode = connection?.referenced_object?.startsWith('bundle.');
  const status = modelState.status;
  const error = bundleMode ? '' : 'Este projeto usa apenas o PHD HyperView Bundle.';
  const ready = status === 'READY' || (bundleMode && Number(modelState.activeObjectCount||0)>0);

  const action = async (name, value) => {
    setActionError('');
    try {await bridge.current?.(name, value);}
    catch (e) {setActionError(e.message);}
  };
  const fullscreen = async () => {
    try {if (document.fullscreenElement) await document.exitFullscreen();else await stage.current.requestFullscreen();}
    catch {setActionError('Tela cheia não permitida neste ambiente.');}
  };

  return <section className="viewer-stage" ref={stage}>
    <div className="viewer-stage-heading">
      <span className="stage-tab active">3D</span>
      <span className="viewer-heading-name"><Box size={12} />{connection?.model_name || 'MODELO 3D'}</span>
      <span className="viewer-live-stat"><span className={'status-dot '+(ready?'ready':'')}/>{ready?(modelState.streaming?'3D STREAMING':'3D CARREGADO'):'3D STANDBY'}<b>{modelState.count?.toLocaleString('pt-BR')||'—'} elementos</b></span>
      <span className="viewer-live-stat viewer-date-stat"><CalendarDays size={12}/><span>DATA</span><b>{project?.data_date||'—'}</b></span>
      <div className="ml-auto flex items-center gap-1">
        {bundleMode&&ready&&<>
          <button className="viewer-top-action" onClick={()=>action('showAll')}><Eye size={13}/><span>Mostrar Tudo</span></button>
          {show4DControls&&<button className="viewer-top-action" onClick={()=>action('toggle4d')}><Play size={13}/><span>4D</span></button>}
          <Popover>
            <PopoverTrigger asChild><button className="viewer-top-action"><Layers3 size={13}/><span>Sobreposições</span></button></PopoverTrigger>
            <PopoverContent className="technical-popover w-48" align="end">
              <button className="picker-option" onClick={openTree}><Network size={14}/>Hierarquia</button>
              <button className="picker-option" onClick={openProperties}><Info size={14}/>Object Intelligence</button>
              {show4DControls&&<button className="picker-option" onClick={()=>action('toggle4d')}><Play size={14}/>Simulação 4D</button>}
            </PopoverContent>
          </Popover>
          <Link to="/phd-ai" className="viewer-top-action viewer-ai-action"><Sparkles size={13}/><span>PHD AI</span></Link>
        </>}
        <button className="viewer-label-button" onClick={openTree}><Network size={12} /><span>HIERARQUIA</span></button>
        <select aria-label="Vista da câmera" disabled={!ready} onChange={(e) => action('view', e.target.value)} defaultValue="3d">
          <option value="3d">Perspectiva</option><option value="top">Superior</option><option value="front">Frontal</option><option value="right">Direita</option><option value="left">Esquerda</option><option value="back">Posterior</option>
        </select>
        <TechnicalButton icon={Maximize} label="Tela cheia" onClick={fullscreen} />
      </div>
    </div>
    <div className="viewer-canvas-area">
      <div className="cad-grid" aria-hidden="true" />
      {bundleMode
        ? <BundleViewerCanvas connection={connection} selected={selected} bridge={bridge} setModelState={setModelState} onRoot={onRoot} onSelected={onSelected} enable4D={show4DControls} />
        : <ViewerEmpty status={status} error={error} />}
      <div className="viewer-breadcrumb"><TechnicalButton icon={Home} label="Enquadrar modelo" disabled={!ready} onClick={() => action('fit')} /><span className="hidden"><ChevronRight size={11} />{connection?.model_name || 'Nenhum modelo conectado'}</span></div>

      <div className="mobile-panel-triggers"><button onClick={openTree}><Network size={15} />Hierarquia</button><button onClick={openProperties}><Info size={15} />Objeto</button></div>
      {actionError && <div className="viewer-error" role="alert">{actionError}</div>}
      {bundleMode&&ready&&<BundleFilterToolbar ready={ready} selected={selected} action={action} fullscreen={fullscreen} />}
      <><div className="viewer-corner-label"><Compass size={13} />WCS<span>3D</span></div><button className="projection-button" disabled={!ready} onClick={() => action('projection')} title="Alternar projeção ortográfica / perspectiva"><SlidersHorizontal size={14} /></button></>
    </div>
    <footer className="viewer-status"><span><span className={'status-dot ' + (ready ? 'ready' : '')} />{ready ? 'VIEWER READY' : 'VIEWER STANDBY'}</span><span>{selected ? '1 SELEÇÃO' : '0 SELECIONADOS'}</span><span className="ml-auto">PHD HYPERVIEW · SINGLE MODEL ENGINE</span></footer>
  </section>;
}