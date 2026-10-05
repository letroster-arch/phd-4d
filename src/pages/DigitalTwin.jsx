import { useState } from 'react';
import { Box, Eye, Layers3, Palette, ScanLine } from 'lucide-react';
import StudioViewer from '@/components/phd/StudioViewer';

function Toggle({on,label,Icon,onClick}){
  return <button onClick={onClick} className="hyper-toggle-row">
    <span><Icon size={14}/>{label}</span>
    <i className={on?'on':''}/>
  </button>;
}

function OverlayPanel({action}){
  const [tab,setTab]=useState('visual');
  const [visible,setVisible]=useState(true);
  const [sets,setSets]=useState(false);
  const [mode,setMode]=useState('solid');
  const [opacity,setOpacity]=useState(100);

  const changeMode=next=>{
    setMode(next);
    action('renderMode',next);
  };

  return <section className="studio-overlay-card model-overlay-premium hyperview-panel">
    <header><strong>HYPERVIEW · VISUALIZAÇÃO</strong></header>
    <div className="overlay-tabs">
      <button className={tab==='visual'?'active':''} onClick={()=>setTab('visual')}>VISUAL</button>
      <button className={tab==='color'?'active':''} onClick={()=>setTab('color')}>COLORIR POR</button>
    </div>

    {tab==='visual'?<>
      <div className="overlay-list">
        <Toggle on={visible} label="Modelo (Base)" Icon={Eye} onClick={()=>{
          const next=!visible;setVisible(next);action('modelVisible',next);
        }}/>
      </div>

      <div className="hyper-render-modes">
        <span>MODO DE RENDER</span>
        <div>
          <button className={mode==='solid'?'active':''} onClick={()=>changeMode('solid')}><Box size={13}/>Realista</button>
          <button className={mode==='skeleton'?'active':''} onClick={()=>changeMode('skeleton')}><ScanLine size={13}/>Esqueleto</button>
          <button className={mode==='xray'?'active':''} onClick={()=>changeMode('xray')}><Layers3 size={13}/>X-Ray</button>
        </div>
        <small>Realista usa PBR + AO em repouso. Durante a navegação o HyperView reduz o custo automaticamente.</small>
      </div>

      <div className="overlay-slider">
        <span>TRANSPARÊNCIA DO MODELO · {opacity}%</span>
        <input type="range" min="10" max="100" value={opacity} onChange={e=>{
          const next=Number(e.target.value);setOpacity(next);action('opacity',next);
        }}/>
      </div>
    </>:<>
      <div className="hyper-color-modes">
        <button className={!sets?'active':''} onClick={()=>{
          setSets(false);
          action('originalColors');
        }}>
          <Palette size={14}/>
          <span>Visual Premium</span>
          <small>Original + fallback industrial</small>
        </button>
        <button className={sets?'active':''} onClick={()=>{
          setSets(true);
          action('colorBySets',true);
        }}>
          <Layers3 size={14}/>
          <span>Sets / Federado</span>
          <small>Cores técnicas por grupo</small>
        </button>
      </div>
      <div className="hyper-color-note">
        <strong>{sets?'SETS ATIVOS':'MATERIAL ORIGINAL ATIVO'}</strong>
        <span>{sets
          ? 'Cada grupo federado recebe uma cor técnica consistente sem alterar o material de origem.'
          : 'O HyperView usa as cores e materiais originais armazenados no Bundle Speckle/Navisworks.'}</span>
        {sets&&<button onClick={()=>{setSets(false);action('originalColors')}}>Restaurar original</button>}
      </div>
    </>}
  </section>;
}

export default function DigitalTwin(){
  return <div className="studio-page model-page model-page-focus">
    <StudioViewer right={({action})=><OverlayPanel action={action}/>} overlayRight className="model-viewer-focus"/>
  </div>;
}
