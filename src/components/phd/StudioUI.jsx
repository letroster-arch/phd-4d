export function StatusPill({children,tone='ready'}){return <span className={'studio-pill '+tone}>{children}</span>}
export function MetricCard({icon:Icon,label,value,delta,tone='blue',children}){return <section className={'studio-metric '+tone}>{Icon&&<Icon size={18}/>}<div><small>{label}</small><strong>{value}</strong>{delta&&<span>{delta}</span>}</div>{children}</section>}
export function ProgressBar({value=0,tone='blue'}){return <div className={'studio-progress '+tone}><i style={{width:Math.max(0,Math.min(100,Number(value)||0))+'%'}}/></div>}
