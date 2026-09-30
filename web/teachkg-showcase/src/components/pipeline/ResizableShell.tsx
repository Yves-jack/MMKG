import type { ReactNode } from "react";
import shell from "@/styles/shell.module.css";
import { ResizableSplit } from "./ResizableSplit";

type Props = {
  /** 左侧导航；不传则仅主区（或主区+详情） */
  nav?: ReactNode;
  main: ReactNode;
  /** 有 detail 时为三栏或两栏（主区 | 详情） */
  detail?: ReactNode;
  /** localStorage 前缀，如 shell-pipeline */
  storagePrefix: string;
  /** 右侧详情栏初始宽度（px） */
  detailInitialRightPx?: number;
  /** 右侧详情栏最小宽度（px）；窄轨折叠时可传更小值 */
  detailMinRightPx?: number;
  /** 锁定右侧像素宽（如 Neo4j 式收成窄轨）；隐藏拖拽条 */
  detailFixedRightPx?: number;
};

/**
 * 全页外壳可拖分栏：始终左右布局（不因窗口变窄改为上下堆叠）。
 */
export function ResizableShell({
  nav,
  main,
  detail,
  storagePrefix,
  detailInitialRightPx = 340,
  detailMinRightPx = 220,
  detailFixedRightPx,
}: Props) {
  const rootClass = `${shell.shell}${detail || nav ? ` ${shell.shellWide}` : ""}`;
  const rightMin = detailFixedRightPx ?? detailMinRightPx;
  const rightFixed = detailFixedRightPx;
  const rightInitial = detailFixedRightPx ?? detailInitialRightPx;

  if (!nav && !detail) {
    return <div className={rootClass}>{main}</div>;
  }

  if (!nav && detail) {
    return (
      <ResizableSplit
        className={rootClass}
        storageKey={rightFixed != null ? undefined : `${storagePrefix}-detail-r`}
        sizedPane="right"
        initialRightPx={rightInitial}
        initialRightRatio={0.34}
        minLeftPx={320}
        minRightPx={rightMin}
        fixedSizedPx={rightFixed}
        stackBelowPx={0}
        left={main}
        right={detail}
      />
    );
  }

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
          key={rightFixed != null ? "detail-rail" : "detail-panel"}
          className={shell.shellInner}
          storageKey={rightFixed != null ? undefined : `${storagePrefix}-detail-r`}
          sizedPane="right"
          initialRightPx={rightInitial}
          initialRightRatio={0.32}
          minLeftPx={280}
          minRightPx={rightMin}
          fixedSizedPx={rightFixed}
          stackBelowPx={0}
          left={main}
          right={detail}
        />
      }
    />
  );
}
