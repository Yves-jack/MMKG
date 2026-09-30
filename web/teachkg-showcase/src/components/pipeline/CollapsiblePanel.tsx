import { useEffect, useState, type ReactNode } from "react";
import styles from "@/pages/PipelinePage.module.css";

type Props = {
  title: string;
  children: ReactNode;
  /** 默认展开 */
  defaultOpen?: boolean;
  /** 写入 localStorage，记住折叠状态（受控模式下仍用于初次缺省） */
  storageKey?: string;
  className?: string;
  /** 受控展开；传入后由父组件决定开合 */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function CollapsiblePanel({
  title,
  children,
  defaultOpen = true,
  storageKey,
  className,
  open: openControlled,
  onOpenChange,
}: Props) {
  const controlled = openControlled !== undefined;
  const [openInternal, setOpenInternal] = useState(() => {
    if (controlled) return Boolean(openControlled);
    if (typeof window === "undefined" || !storageKey) return defaultOpen;
    try {
      const v = window.localStorage.getItem(storageKey);
      if (v === "0") return false;
      if (v === "1") return true;
    } catch {
      /* ignore */
    }
    return defaultOpen;
  });

  const open = controlled ? Boolean(openControlled) : openInternal;

  useEffect(() => {
    if (controlled || !storageKey || typeof window === "undefined") return;
    try {
      window.localStorage.setItem(storageKey, openInternal ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [controlled, openInternal, storageKey]);

  const toggle = () => {
    const next = !open;
    if (!controlled) setOpenInternal(next);
    onOpenChange?.(next);
  };

  return (
    <div className={`${styles.panel} ${open ? "" : styles.panelCollapsed} ${className || ""}`.trim()}>
      <button
        type="button"
        className={styles.panelToggle}
        aria-expanded={open}
        onClick={toggle}
      >
        <h3>{title}</h3>
        <span className={styles.panelChevron} aria-hidden>
          {open ? "▾" : "▸"}
        </span>
      </button>
      {open ? <div className={styles.panelBody}>{children}</div> : null}
    </div>
  );
}
