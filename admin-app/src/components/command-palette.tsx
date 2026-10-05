import { useEffect } from "react";
import { useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { NAV_ITEMS } from "@/lib/nav-items";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function CommandPalette({ open, onOpenChange }: Readonly<Props>) {
  const navigate = useNavigate();
  const { isPrivileged } = useAuth();

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        onOpenChange(!open);
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const visiblePages = NAV_ITEMS.filter((p) => !p.privileged || isPrivileged);

  const goTo = (path: string) => {
    navigate(path);
    onOpenChange(false);
  };

  return (
    <CommandDialog open={open} onOpenChange={onOpenChange}>
      <CommandInput placeholder="ページへ移動..." />
      <CommandList>
        <CommandEmpty>該当するページがありません</CommandEmpty>
        <CommandGroup heading="ページ">
          {visiblePages.map((page) => {
            const Icon = page.icon;
            return (
              <CommandItem
                key={page.path}
                value={`${page.label} ${page.keywords}`}
                onSelect={() => goTo(page.path)}
              >
                <Icon className="mr-2 size-4" aria-hidden="true" />
                {page.label}
              </CommandItem>
            );
          })}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}
