import { useEffect, useRef, useState } from 'react';
import {
  Box,
  BoxSelect,
  Camera,
  Eye,
  EyeOff,
  Focus,
  Hand,
  Layers3,
  Maximize,
  MousePointer2,
  Move,
  Orbit,
  RotateCcw,
  Scan,
  ScanLine,
  SlidersHorizontal,
  Undo2,
  View
} from 'lucide-react';
import TechnicalButton from '@/components/phd/TechnicalButton';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

const views=[
  ['3d','Perspectiva'],
  ['top','Superior'],
  ['front','Frontal'],
  ['right','Direita'],
  ['left','Esquerda'],
  ['back','Posterior']
];

export default function BundleFilterToolbar({ready,selected,action,fullscreen}){
  const [mode,setMode]=useState('orbit');
  const [renderMode,setRenderMode]=useState('solid');
  const [section,setSection]=useState(false);
  const [position,setPosition]=useState(null);
  const toolbarRef=useRef(null);
  const dragRef=useRef(null);
  const activate=next=>{setMode(next);action(next)};
  const render=next=>{setRenderMode(next);action('renderMode',next)};

  useEffect(()=>{
    try{
      const saved=JSON.parse(localStorage.getItem('phd-hyperview-toolbar-position')||'null');
      if(saved&&Number.isFinite(saved.x)&&Number.isFinite(saved.y))setPosition(saved);
    }catch{}
  },[]);

  useEffect(()=>{
    if(!position)return;
    const clampToCanvas=()=>{
      const toolbar=toolbarRef.current;
      const canvas=toolbar?.parentElement;
      if(!toolbar||!canvas)return;
      const maxX=Math.max(6,canvas.clientWidth-toolbar.offsetWidth-6);
      const maxY=Math.max(6,canvas.clientHeight-toolbar.offsetHeight-6);
      setPosition(current=>{
        if(!current)return current;
        const next={
          x:Math.max(6,Math.min(maxX,current.x)),
          y:Math.max(6,Math.min(maxY,current.y))
        };
        if(next.x===current.x&&next.y===current.y)return current;
        try{localStorage.setItem('phd-hyperview-toolbar-position',JSON.stringify(next))}catch{}
        return next;
      });
    };
    clampToCanvas();
    window.addEventListener('resize',clampToCanvas);
    return()=>window.removeEventListener('resize',clampToCanvas);
  },[position?.x,position?.y]);

  const startDrag=event=>{
    if(event.button!==0)return;
    const toolbar=toolbarRef.current;
    const canvas=toolbar?.parentElement;
    if(!toolbar||!canvas)return;
    event.preventDefault();
    event.stopPropagation();

    const toolbarRect=toolbar.getBoundingClientRect();
    const canvasRect=canvas.getBoundingClientRect();
    dragRef.current={
      pointerId:event.pointerId,
      startX:event.clientX,
      startY:event.clientY,
      left:toolbarRect.left-canvasRect.left,
      top:toolbarRect.top-canvasRect.top
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    toolbar.classList.add('is-dragging');
  };

  const drag=event=>{
    const state=dragRef.current;
    const toolbar=toolbarRef.current;
    const canvas=toolbar?.parentElement;
    if(!state||state.pointerId!==event.pointerId||!toolbar||!canvas)return;
    event.preventDefault();

    const maxX=Math.max(6,canvas.clientWidth-toolbar.offsetWidth-6);
    const maxY=Math.max(6,canvas.clientHeight-toolbar.offsetHeight-6);
    setPosition({
      x:Math.max(6,Math.min(maxX,state.left+(event.clientX-state.startX))),
      y:Math.max(6,Math.min(maxY,state.top+(event.clientY-state.startY)))
    });
  };

  const endDrag=event=>{
    const state=dragRef.current;
    if(!state||state.pointerId!==event.pointerId)return;
    dragRef.current=null;
    toolbarRef.current?.classList.remove('is-dragging');
    try{
      if(position)localStorage.setItem('phd-hyperview-toolbar-position',JSON.stringify(position));
    }catch{}
  };

  const resetPosition=()=>{
    dragRef.current=null;
    setPosition(null);
    toolbarRef.current?.classList.remove('is-dragging');
    try{localStorage.removeItem('phd-hyperview-toolbar-position')}catch{}
  };

  const dragStyle=position?{
    '--hyper-toolbar-x':position.x+'px',
    '--hyper-toolbar-y':position.y+'px'
  }:undefined;

  return <div
    ref={toolbarRef}
    className={'viewer-toolbar bundle-filter-toolbar bundle-aec-toolbar hyper-toolbar hyper-toolbar-draggable '+(position?'is-dragged':'')}
    style={dragStyle}
    role="toolbar"
    aria-label="Ferramentas 3D"
  >
    <button
      className="hyper-toolbar-drag-handle"
      type="button"
      title="Arraste para mover a barra · duplo clique para centralizar"
      aria-label="Mover barra de ferramentas"
      onPointerDown={startDrag}
      onPointerMove={drag}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onDoubleClick={resetPosition}
    >
      <Move size={15}/>
    </button>
    <div className="hyper-tool-group">
      <TechnicalButton icon={Orbit} label="Órbita 360°" active={mode==='orbit'} disabled={!ready} onClick={()=>activate('orbit')}>Órbita</TechnicalButton>
      <TechnicalButton icon={Hand} label="Pan" active={mode==='pan'} disabled={!ready} onClick={()=>activate('pan')}>Pan</TechnicalButton>
      <TechnicalButton icon={MousePointer2} label="Selecionar" active={mode==='pick'} disabled={!ready} onClick={()=>activate('pick')}>Selecionar</TechnicalButton>
    </div>

    <span className="hyper-toolbar-divider"/>

    <TechnicalButton icon={Focus} label="Zoom na seleção" disabled={!ready||!selected} onClick={()=>action('focus')}>Focar</TechnicalButton>

    <Popover>
      <PopoverTrigger asChild>
        <button className={'tech-button '+(renderMode!=='solid'?'active':'')} aria-label="Modo de render" disabled={!ready}>
          {renderMode==='skeleton'?<ScanLine size={16}/>:renderMode==='xray'?<Layers3 size={16}/>:<Box size={16}/>}
          <span className="tech-button-label">{renderMode==='skeleton'?'Esqueleto':renderMode==='xray'?'X-Ray':'Realista'}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent className="technical-popover w-52 hyper-render-popover" side="top">
        <div className="bundle-color-title">MODO DE RENDER</div>
        <button className={'picker-option '+(renderMode==='solid'?'active':'')} onClick={()=>render('solid')}><Box size={14}/>Realista · PBR + AO</button>
        <button className={'picker-option '+(renderMode==='skeleton'?'active':'')} onClick={()=>render('skeleton')}><ScanLine size={14}/>Esqueleto leve</button>
        <button className={'picker-option '+(renderMode==='xray'?'active':'')} onClick={()=>render('xray')}><Layers3 size={14}/>X-Ray</button>
      </PopoverContent>
    </Popover>

    <TechnicalButton icon={BoxSelect} label="Seção horizontal" active={section} disabled={!ready} onClick={()=>{setSection(v=>!v);action('section')}}>Seção</TechnicalButton>

    <Popover>
      <PopoverTrigger asChild>
        <button className="tech-button" aria-label="Visibilidade" disabled={!ready}><Eye size={16}/><span className="tech-button-label">Visibilidade</span></button>
      </PopoverTrigger>
      <PopoverContent className="technical-popover w-52" side="top">
        <div className="bundle-color-title">VISIBILIDADE</div>
        <button className="picker-option" disabled={!selected} onClick={()=>action('isolate')}><Eye size={14}/>Isolar seleção</button>
        <button className="picker-option" disabled={!selected} onClick={()=>action('hide')}><EyeOff size={14}/>Ocultar seleção</button>
        <button className="picker-option" disabled={!selected} onClick={()=>action('show')}><Undo2 size={14}/>Mostrar seleção</button>
        <button className="picker-option" onClick={()=>action('showAll')}><RotateCcw size={14}/>Mostrar tudo</button>
      </PopoverContent>
    </Popover>

    <Popover>
      <PopoverTrigger asChild>
        <button className="tech-button" aria-label="Vistas da câmera" disabled={!ready}><View size={16}/><span className="tech-button-label">Vistas</span></button>
      </PopoverTrigger>
      <PopoverContent className="technical-popover w-44" side="top">
        <div className="bundle-color-title">VISTAS DA CÂMERA</div>
        {views.map(([id,label])=><button className="picker-option" key={id} onClick={()=>action('view',id)}>{label}</button>)}
        <button className="picker-option" onClick={()=>action('projection')}><SlidersHorizontal size={14}/>Perspectiva / ortográfica</button>
      </PopoverContent>
    </Popover>

    <span className="hyper-toolbar-divider"/>

    <TechnicalButton icon={Camera} label="Salvar imagem do viewport" disabled={!ready} onClick={()=>action('screenshot')}>Snapshot</TechnicalButton>
    <TechnicalButton icon={Scan} label="Enquadrar modelo" disabled={!ready} onClick={()=>action('fit')}>Ajustar</TechnicalButton>
    <TechnicalButton icon={Maximize} label="Tela cheia" disabled={!ready} onClick={fullscreen}>Tela cheia</TechnicalButton>
  </div>;
}
