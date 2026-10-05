import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
export default function TechnicalButton({ icon: Icon, label, active, disabled, onClick, children, className = '' }) {
  return <Tooltip>
    <TooltipTrigger asChild>
      <button type="button" className={'tech-button '+(active?'active ':'')+className} aria-label={label} disabled={disabled} onClick={onClick}>
        {Icon&&<Icon size={17}/>} {children&&<span className="tech-button-label">{children}</span>}
      </button>
    </TooltipTrigger>
    <TooltipContent>{label}{disabled ? ' — indisponível sem modelo ou seleção' : ''}</TooltipContent>
  </Tooltip>;
}