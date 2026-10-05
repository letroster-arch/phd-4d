import StudioViewer from '@/components/phd/StudioViewer';
import StudioSchedule from '@/components/phd/StudioSchedule';

export default function Simulation4D(){
  return <div className="studio-page simulation-page"><StudioViewer showDefaultInspector overlayRight show4DControls bottom={<StudioSchedule expanded title="WBS + CRONOGRAMA 4D"/>}/></div>;
}
