import type { ReactNode } from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";

type PendingDialogProps = {
  open: boolean;
  pending: boolean;
  onClose: () => void;
  children: ReactNode;
};

export function PendingDialog({
  open,
  pending,
  onClose,
  children,
}: Readonly<PendingDialogProps>) {
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !pending) onClose();
      }}
    >
      <DialogContent
        className="max-w-md"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
