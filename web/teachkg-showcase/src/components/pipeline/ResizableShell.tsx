import type { ReactNode } from "react";
import shell from "@/styles/shell.module.css";
import { ResizableSplit } from "./ResizableSplit";

type Props = {
  nav: ReactNode;
  main: ReactNode;
  /** 有 detail 时为三栏（导航 | 主区 | 详情） */
  detail?: ReactNode;
  /** localStorage 前缀，如 shell-pipeline */
  storagePrefix: string;
};

/**
 * 全页外壳可拖分栏：始终左右布局（不因窗口变窄改为上下堆叠）。
 */
export function ResizableShell({ nav, main, detail, storagePrefix }: Props) {
  const rootClass = `${shell.shell}${detail ? ` ${shell.shellWide}` : ""}`;

  if (!detail) {
    return (
      <ResizableSplit
        className={rootClass}
        storageKey={`${storagePrefix}-nav-r`}
        initialLeftPx={260}
        initialLeftRatio={0.22}
        minLeftPx={160}
        minRightPx={280}
        stackBelowPx={0}
        left={nav}
        right={main}
      />
    );
  }

  return (
    <ResizableSplit
      className={rootClass}
      storageKey={`${storagePrefix}-nav-r`}
      initialLeftPx={240}
      initialLeftRatio={0.18}
      minLeftPx={160}
      minRightPx={360}
      stackBelowPx={0}
      left={nav}
      right={
        <ResizableSplit
          className={shell.shellInner}
          storageKey={`${storagePrefix}-detail-r`}
          sizedPane="right"
          initialRightPx={340}
          initialRightRatio={0.28}
          minLeftPx={280}
          minRightPx={220}
          stackBelowPx={0}
          left={main}
          right={detail}
        />
      }
    />
  );
}
