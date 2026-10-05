import { useIsMobile } from '@/hooks/use-mobile';
import { Drawer, DrawerContent, DrawerTitle } from '@/components/ui/drawer';
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet';
export default function PanelOverlay({ open, onOpenChange, side = 'left', title, children }) {
  const mobile = useIsMobile();
  if (mobile) return <Drawer open={open} onOpenChange={onOpenChange}><DrawerContent className="phd-drawer h-[85dvh]"><DrawerTitle className="sr-only">{title}</DrawerTitle><div className="overlay-panel-content">{children}</div></DrawerContent></Drawer>;
  return <Sheet open={open} onOpenChange={onOpenChange}><SheetContent side={side} className="phd-sheet"><SheetTitle className="sr-only">{title}</SheetTitle><div className="overlay-panel-content">{children}</div></SheetContent></Sheet>;
}